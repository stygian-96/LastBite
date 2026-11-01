import { and, asc, eq, inArray, ne, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { drops, orders, payments, refunds } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { requireOutlet, type Role } from '../auth/access.js';
import { endHold, releaseStock, type Order } from '../orders/reserve.js';
import { createRefund } from './create.js';

const CANCEL_ROLES: Role[] = ['owner', 'manager', 'counter'];
const reasonSchema = z.enum(['ran_out', 'quality', 'closing_early']);
type Cancel = { actorId: string; reason: z.infer<typeof reasonSchema>; now: Date };

const LIVE_STATUSES = ['held', 'paid'];
const NOT_THE_BAG_REASONS = ['late_payment', 'duplicate_payment'];
/** A restart needs an order to land in the moment before the drop is held, so a few are plenty. */
const DROP_CANCEL_TRIES = 5;

const isId = (id: string) => z.uuid().safeParse(id).success;
const orderNotFound = () => new ApiError('not_found', 404, 'Order not found');
const dropNotFound = () => new ApiError('not_found', 404, 'Drop not found');

/** The payment that bought the bag: any other captured row was refunded as late or duplicate. */
async function bagPayment(tx: Tx, orderId: string) {
  const [payment] = await tx
    .select({ id: payments.id, amountPaise: payments.amountPaise })
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.status, 'captured'),
        notExists(
          tx
            .select({ id: refunds.id })
            .from(refunds)
            .where(and(eq(refunds.paymentId, payments.id), inArray(refunds.reason, NOT_THE_BAG_REASONS))),
        ),
      ),
    );
  return payment;
}

/** What is left of a payment after its refunds, those that failed aside. */
async function unrefundedPaise(tx: Tx, payment: { id: string; amountPaise: number }): Promise<number> {
  const [refunded] = await tx
    .select({ paise: sql<number>`coalesce(sum(${refunds.amountPaise}), 0)::int` })
    .from(refunds)
    .where(and(eq(refunds.paymentId, payment.id), ne(refunds.status, 'failed')));
  return payment.amountPaise - refunded!.paise;
}

/**
 * Ends a paid order the caller has locked, once the caller holds its drop. The order always ends,
 * and the customer gets back what they have not had yet: an admin may have refunded some or all of
 * it. UNIQUE (payment_id, reason) allows this, as an earlier refund has another reason and an order
 * can be cancelled only once, so no vendor_cancelled refund can be there already.
 */
async function cancelPaidOrder(tx: Tx, order: Order, { actorId, reason, now }: Cancel): Promise<void> {
  const payment = await bagPayment(tx, order.id);
  const remainder = payment ? await unrefundedPaise(tx, payment) : 0;
  await tx
    .update(orders)
    .set({ status: 'cancelled', cancelledAt: now.toISOString(), cancelledBy: actorId, cancelReason: reason })
    .where(eq(orders.id, order.id));
  if (payment && remainder > 0) {
    await createRefund(tx, {
      orderId: order.id,
      paymentId: payment.id,
      amountPaise: remainder,
      reason: 'vendor_cancelled',
      chargedTo: 'vendor',
      createdBy: actorId,
    });
  }
  const detail = { reason, dropId: order.dropId, paymentId: payment?.id ?? null, refundPaise: Math.max(remainder, 0) };
  await audit(tx, { actorId, action: 'order.cancel', entity: 'order', entityId: order.id, detail });
  if (remainder <= 0) {
    await audit(tx, { actorId, action: 'order.cancel_no_refund', entity: 'order', entityId: order.id, detail });
  }
}

/**
 * Cancels one paid order and refunds it. Lock order is the order row, then the drop, with the order
 * unchanged until the drop is held, as in applyCaptureInTx and expireHolds.
 */
export async function cancelOrder(actorId: string, orderId: string, rawReason: unknown, now: Date): Promise<void> {
  const reason = parseInput(reasonSchema, rawReason);
  if (!isId(orderId)) throw orderNotFound();
  const [found] = await db.select({ outletId: orders.outletId }).from(orders).where(eq(orders.id, orderId));
  if (!found) throw orderNotFound();
  await requireOutlet(actorId, found.outletId, CANCEL_ROLES);

  await withTx(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (order?.status !== 'paid') throw new ApiError('not_cancellable', 409, 'Only a paid order can be cancelled');
    await releaseStock(tx, order.dropId);
    await cancelPaidOrder(tx, order, { actorId, reason, now });
  });
}

/**
 * One try at a drop cancel. Every live order is locked, then the drop, so this meets capture and
 * expireHolds in the order they use. Holding the drop, it never waits for an order: one that landed
 * before the drop was held shows up in a plain read, and the try gives up its locks and starts again
 * (returns false). Once the drop is held no order can land, so the set it cancels is complete.
 */
function tryCancelDrop(dropId: string, cancel: Cancel): Promise<boolean> {
  const live = and(eq(orders.dropId, dropId), inArray(orders.status, LIVE_STATUSES));
  return withTx(async (tx) => {
    const locked = await tx.select().from(orders).where(live).orderBy(asc(orders.id)).for('update');
    const [drop] = await tx.select({ status: drops.status }).from(drops).where(eq(drops.id, dropId)).for('update');
    if (drop!.status === 'cancelled') throw new ApiError('drop_cancelled', 409, 'This drop was cancelled');

    const lockedIds = new Set(locked.map((o) => o.id));
    const current = await tx.select({ id: orders.id }).from(orders).where(live);
    if (current.some((o) => !lockedIds.has(o.id))) return false;

    await tx.update(drops).set({ status: 'cancelled' }).where(eq(drops.id, dropId));
    const held = locked.filter((o) => o.status === 'held');
    const paid = locked.filter((o) => o.status === 'paid');
    for (const hold of held) await endHold(tx, hold, cancel.now.toISOString());
    for (const order of paid) {
      await releaseStock(tx, dropId);
      await cancelPaidOrder(tx, order, cancel);
    }
    await audit(tx, {
      actorId: cancel.actorId,
      action: 'drop.cancel',
      entity: 'drop',
      entityId: dropId,
      detail: { reason: cancel.reason, cancelled: paid.length, expired: held.length },
    });
    return true;
  });
}

/**
 * Cancels a drop: paid orders are cancelled and refunded, held orders expire, and stock returns, all
 * in one transaction. A capture still in flight for a held order then ends in a late payment refund.
 */
export async function cancelDrop(actorId: string, dropId: string, rawReason: unknown, now: Date): Promise<void> {
  const reason = parseInput(reasonSchema, rawReason);
  if (!isId(dropId)) throw dropNotFound();
  const [found] = await db.select({ outletId: drops.outletId }).from(drops).where(eq(drops.id, dropId));
  if (!found) throw dropNotFound();
  await requireOutlet(actorId, found.outletId, CANCEL_ROLES);

  for (let i = 0; i < DROP_CANCEL_TRIES; i++) {
    if (await tryCancelDrop(dropId, { actorId, reason, now })) return;
  }
  throw new ApiError('drop_busy', 409, 'This drop is busy. Try again');
}
