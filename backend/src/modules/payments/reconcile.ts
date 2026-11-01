import { and, asc, eq, gte, inArray, lte, ne, notLike, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders, payments } from '../../db/schema.js';
import { getGateway } from '../../integrations/payments.js';
import { applyCapture, EXTRA_PAYMENT_SEPARATOR } from './capture.js';

const WINDOW_MS = 2 * 60_000;
const LOOKBACK_MS = 3 * 24 * 3_600_000;
const BATCH_SIZE = 100;

type Check = { paymentId: string; razorpayOrderId: string };
const checkColumns = { paymentId: payments.id, razorpayOrderId: payments.razorpayOrderId };

/** Holds with a payment row that end within two minutes or already have. */
function holdsNearEnd(now: Date): Promise<Check[]> {
  const horizon = new Date(now.getTime() + WINDOW_MS).toISOString();
  return db
    .select(checkColumns)
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(and(eq(orders.status, 'held'), lte(orders.holdExpiresAt, horizon)))
    .orderBy(asc(orders.holdExpiresAt))
    .limit(BATCH_SIZE);
}

/** Ended orders whose payment never settled here, longest unchecked first, so no row is left waiting. */
function endedOrders(now: Date, limit: number): Promise<Check[]> {
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  return db
    .select(checkColumns)
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(
      and(
        inArray(orders.status, ['expired', 'cancelled']),
        ne(payments.status, 'captured'),
        gte(payments.createdAt, since),
        notLike(payments.razorpayOrderId, `%${EXTRA_PAYMENT_SEPARATOR}%`),
      ),
    )
    .orderBy(sql`${payments.lastCheckedAt} ASC NULLS FIRST`)
    .limit(limit);
}

/**
 * Catches delayed or lost webhooks, asking the gateway about at most 100 payments. Holds near their
 * end come first, and any room left goes to ended orders, where the late payment rules apply.
 * Returns how many payments it settled.
 */
export async function reconcilePayments(now: Date): Promise<number> {
  const holds = await holdsNearEnd(now);
  const room = BATCH_SIZE - holds.length;
  const checks = room > 0 ? [...holds, ...(await endedOrders(now, room))] : holds;
  if (checks.length === 0) return 0;

  // Stamped before asking, so a row the gateway keeps failing on still takes its turn at the back.
  await db
    .update(payments)
    .set({ lastCheckedAt: now.toISOString() })
    .where(
      inArray(
        payments.id,
        checks.map((c) => c.paymentId),
      ),
    );

  const gateway = getGateway();
  let settled = 0;
  for (const { razorpayOrderId } of checks) {
    try {
      const found = await gateway.listOrderPayments(razorpayOrderId);
      for (const gp of found.filter((p) => p.status === 'captured')) {
        if (await applyCapture(gp, now)) settled++;
      }
    } catch (e) {
      // The next run tries again, and one bad order must not hold up the others.
      console.error(`Reconcile failed for ${razorpayOrderId}`, e);
    }
  }
  return settled;
}
