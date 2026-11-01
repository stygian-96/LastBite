import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { withTx, type Tx } from '../../db/client.js';
import { orders, payments } from '../../db/schema.js';
import type { GatewayPayment } from '../../integrations/payments.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { generatePickupCode } from '../orders/code.js';
import { findNightOrder, releaseStock, takeStock, type Order } from '../orders/reserve.js';
import { createRefund } from '../refunds/create.js';

const CODE_ATTEMPTS = 10;

/**
 * Stores a captured payment. It takes the Razorpay order's own row, unless an earlier payment has
 * that: then it gets a row of its own, since refunds are unique per payment row and reason, and a
 * second payment refunded against the first row would be lost as a conflict.
 */
async function recordCapture(tx: Tx, orderId: string, gp: GatewayPayment): Promise<string> {
  const details = { razorpayPaymentId: gp.id, status: 'captured', feePaise: gp.feePaise, method: gp.method };
  const [claimed] = await tx
    .update(payments)
    .set(details)
    .where(and(eq(payments.razorpayOrderId, gp.orderId), ne(payments.status, 'captured')))
    .returning({ id: payments.id });
  if (claimed) return claimed.id;

  const [extra] = await tx
    .insert(payments)
    .values({ orderId, razorpayOrderId: `${gp.orderId}:${gp.id}`, amountPaise: gp.amountPaise, ...details })
    .returning({ id: payments.id });
  return extra!.id;
}

/** Marks the order paid, with a pickup code. Each try has a savepoint, so a clash keeps the transaction. */
async function markPaid(tx: Tx, orderId: string, now: Date): Promise<void> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const pickupCode = generatePickupCode();
    try {
      await tx.transaction((sp) =>
        sp.update(orders).set({ status: 'paid', paidAt: now.toISOString(), pickupCode }).where(eq(orders.id, orderId)),
      );
      return;
    } catch (e) {
      if (!isUniqueViolation(e, 'pickup_code_per_outlet_night')) throw e;
    }
  }
  throw new Error(`No free pickup code for order ${orderId}`);
}

/**
 * Sells an expired order its bag again, if it can still be sold. Stock is taken before the order
 * changes: a reserve holds the drop and may then wait on a changed order row (see endHold).
 */
async function retakeBag(tx: Tx, order: Order, now: Date): Promise<boolean> {
  if (order.userId && (await findNightOrder(tx, order.userId, order.outletId, order.serviceDate))) return false;
  if (!(await takeStock(tx, order.dropId, now.toISOString()))) return false;
  try {
    await markPaid(tx, order.id, now);
    return true;
  } catch (e) {
    // A reserve by the same customer committed while this capture waited for the drop.
    if (!isUniqueViolation(e, 'one_order_per_outlet_night')) throw e;
    await releaseStock(tx, order.dropId);
    return false;
  }
}

async function refundCapture(
  tx: Tx,
  order: Order,
  gp: GatewayPayment,
  reason: 'late_payment' | 'duplicate_payment',
): Promise<void> {
  const paymentId = await recordCapture(tx, order.id, gp);
  await createRefund(tx, { orderId: order.id, paymentId, amountPaise: gp.amountPaise, reason, chargedTo: 'platform' });
}

/**
 * Applies a captured payment inside the caller's transaction: every capture ends in a confirmed bag
 * or a refund (spec 7.2). The two exceptions are flagged in the audit log for an admin.
 *
 * Lock order is the order row, then the drop, with no order changed before the drop is held. That
 * is the order expireHolds uses, so taking the drop first would deadlock against it. Waiting on the
 * drop is safe: its holders are expireHolds, which skips locked orders, and hold endings and reserves,
 * which never touch this order unless it has changed.
 */
export async function applyCaptureInTx(tx: Tx, gp: GatewayPayment, now: Date): Promise<void> {
  const [known] = await tx
    .select({ orderId: payments.orderId })
    .from(payments)
    .where(eq(payments.razorpayOrderId, gp.orderId));
  if (!known) {
    // audit_log.entity_id is required, and this payment has no row of ours to point at.
    await audit(tx, {
      actorId: null,
      action: 'payment.unmatched',
      entity: 'payment',
      entityId: randomUUID(),
      detail: { razorpayOrderId: gp.orderId, razorpayPaymentId: gp.id, amountPaise: gp.amountPaise },
    });
    return;
  }

  const [order] = await tx.select().from(orders).where(eq(orders.id, known.orderId)).for('update');
  if (!order) throw new Error(`Payment points at missing order ${known.orderId}`);

  // Whatever this payment led to the first time stands, even if a retry would now go differently.
  const [applied] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.razorpayPaymentId, gp.id));
  if (applied) return;

  if (gp.amountPaise !== order.pricePaise) {
    await audit(tx, {
      actorId: null,
      action: 'payment.amount_mismatch',
      entity: 'order',
      entityId: order.id,
      detail: { razorpayPaymentId: gp.id, amountPaise: gp.amountPaise, expectedPaise: order.pricePaise },
    });
    return;
  }

  switch (order.status) {
    case 'held':
      await recordCapture(tx, order.id, gp);
      await markPaid(tx, order.id, now);
      return;
    case 'expired':
      if (await retakeBag(tx, order, now)) await recordCapture(tx, order.id, gp);
      else await refundCapture(tx, order, gp, 'late_payment');
      return;
    case 'cancelled':
      await refundCapture(tx, order, gp, 'late_payment');
      return;
    default:
      // paid, collected or no_show: a different payment already bought this bag.
      await refundCapture(tx, order, gp, 'duplicate_payment');
  }
}

/** Applies a payment the gateway reports as captured. Safe to run twice for one payment. */
export function applyCapture(gp: GatewayPayment, now: Date): Promise<void> {
  return withTx((tx) => applyCaptureInTx(tx, gp, now));
}
