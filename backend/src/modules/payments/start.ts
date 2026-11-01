import { asc, eq } from 'drizzle-orm';
import { withTx, type Tx } from '../../db/client.js';
import { orders, payments } from '../../db/schema.js';
import { getGateway } from '../../integrations/payments.js';
import { ApiError } from '../../lib/errors.js';
import { ownedOrder } from '../orders/views.js';

/** Locks the customer's order and checks its hold is still running. */
async function lockActiveHold(tx: Tx, userId: string, orderId: string, now: Date) {
  const [order] = await tx.select().from(orders).where(ownedOrder({ userId }, orderId)).for('update');
  if (!order) throw new ApiError('not_found', 404, 'Order not found');
  if (order.status !== 'held' || new Date(order.holdExpiresAt) <= now) {
    throw new ApiError('hold_expired', 409, 'This hold has ended');
  }
  return order;
}

async function existingRazorpayOrder(tx: Tx, orderId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ razorpayOrderId: payments.razorpayOrderId })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(asc(payments.createdAt));
  return row?.razorpayOrderId;
}

/**
 * Opens checkout for a held order. A retry reuses the Razorpay order and its payments row. The
 * gateway call sits between two transactions, and the second one settles a double tap.
 */
export async function startPayment(
  userId: string,
  orderId: string,
  ack: { allergenAck: boolean },
  now: Date,
): Promise<{ razorpayOrderId: string; amountPaise: number; keyId: string; timeoutSeconds: number }> {
  if (!ack.allergenAck) throw new ApiError('ack_required', 400, 'Please confirm you have read the allergen information');

  const gateway = getGateway();
  const hold = await withTx(async (tx) => {
    const order = await lockActiveHold(tx, userId, orderId, now);
    await tx.update(orders).set({ allergenAckAt: now.toISOString() }).where(eq(orders.id, order.id));
    return { order, razorpayOrderId: await existingRazorpayOrder(tx, order.id) };
  });
  const { order } = hold;

  let razorpayOrderId = hold.razorpayOrderId;
  if (!razorpayOrderId) {
    const created = await gateway.createOrder({ amountPaise: order.pricePaise, receipt: order.id });
    razorpayOrderId = await withTx(async (tx) => {
      await lockActiveHold(tx, userId, orderId, now);
      const existing = await existingRazorpayOrder(tx, order.id);
      if (existing) return existing;
      await tx.insert(payments).values({ orderId: order.id, razorpayOrderId: created.id, amountPaise: order.pricePaise });
      return created.id;
    });
  }

  return {
    razorpayOrderId,
    amountPaise: order.pricePaise,
    keyId: gateway.keyId,
    timeoutSeconds: Math.floor((new Date(order.holdExpiresAt).getTime() - now.getTime()) / 1000),
  };
}
