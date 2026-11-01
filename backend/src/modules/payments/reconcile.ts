import { and, asc, eq, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders, payments } from '../../db/schema.js';
import { getGateway } from '../../integrations/payments.js';
import { applyCapture } from './capture.js';

const WINDOW_MS = 2 * 60_000;
const BATCH_SIZE = 100;

/**
 * Catches delayed webhooks: asks the gateway about holds with a payment row that end within two
 * minutes or already have. Returns how many captured payments it applied.
 */
export async function reconcilePayments(now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + WINDOW_MS).toISOString();
  const holds = await db
    .select({ razorpayOrderId: payments.razorpayOrderId })
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(and(eq(orders.status, 'held'), lte(orders.holdExpiresAt, horizon)))
    .orderBy(asc(orders.holdExpiresAt))
    .limit(BATCH_SIZE);

  const gateway = getGateway();
  let applied = 0;
  for (const { razorpayOrderId } of holds) {
    try {
      const found = await gateway.listOrderPayments(razorpayOrderId);
      for (const gp of found.filter((p) => p.status === 'captured')) {
        await applyCapture(gp, now);
        applied++;
      }
    } catch (e) {
      // The next run tries again, and one bad order must not hold up the others.
      console.error(`Reconcile failed for ${razorpayOrderId}`, e);
    }
  }
  return applied;
}
