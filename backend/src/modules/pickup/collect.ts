import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { drops, orders, payouts } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { checkRateLimit, countRateLimit } from '../../lib/rate-limit.js';
import { requireOutlet, type Role } from '../auth/access.js';
import { orderViewById, type OrderView } from '../orders/views.js';

export const PICKUP_ROLES: Role[] = ['owner', 'manager', 'counter'];
/** Staff can still collect this long after the window closes. */
export const NO_SHOW_GRACE_MINUTES = 30;
const WRONG_CODE_LIMIT = 10;
const WRONG_CODE_WINDOW_SECONDS = 60;
/** A payout in either of these states has been approved, so the order's outcome is fixed. */
const APPROVED_PAYOUTS = ['released', 'paid'];

export const isId = (id: string) => z.uuid().safeParse(id).success;
const orderNotFound = () => new ApiError('not_found', 404, 'Order not found');
const codeNotFound = () => new ApiError('code_not_found', 404, 'No order with that code');
const alreadyCollected = (collectedAt: string | null) =>
  new ApiError('already_collected', 409, 'This order was already collected', { collectedAt });

/** Staff of the outlet only. */
export async function requirePickupStaff(userId: string, outletId: string): Promise<void> {
  await requireOutlet(userId, outletId, PICKUP_ROLES);
}

/** Collects an order, locking its row. A no-show is corrected here, so both statuses pass. */
async function collectLocked(tx: Tx, staffId: string, orderId: string, now: Date): Promise<void> {
  const [order] = await tx
    .select({
      status: orders.status,
      collectedAt: orders.collectedAt,
      payoutStatus: payouts.status,
    })
    .from(orders)
    .leftJoin(payouts, eq(payouts.id, orders.payoutId))
    .where(eq(orders.id, orderId))
    .for('update', { of: orders });
  if (!order) throw orderNotFound();
  if (order.status === 'collected') throw alreadyCollected(order.collectedAt);
  if (order.status !== 'paid' && order.status !== 'no_show') {
    throw new ApiError('not_collectable', 409, 'This order cannot be collected');
  }
  if (order.payoutStatus && APPROVED_PAYOUTS.includes(order.payoutStatus)) {
    throw new ApiError('payout_released', 409, 'This order is in a payout that was already approved');
  }
  await tx
    .update(orders)
    .set({ status: 'collected', collectedAt: now.toISOString(), collectedBy: staffId })
    .where(and(eq(orders.id, orderId), inArray(orders.status, ['paid', 'no_show'])));
  await audit(tx, {
    actorId: staffId,
    action: 'order.collect',
    entity: 'order',
    entityId: orderId,
    detail: { from: order.status },
  });
}

/**
 * Collects by the code the customer shows. The lookup covers this outlet's paid and collected orders
 * whose pickup end plus 30 minutes is still ahead, never a calendar date, as windows pass midnight.
 * Only a wrong code costs quota, so a right one never locks staff out. No provider call happens here.
 */
export async function collectByCode(staffId: string, outletId: string, rawCode: string, now: Date): Promise<OrderView> {
  await requirePickupStaff(staffId, outletId);
  const key = `collect:${staffId}`;
  await checkRateLimit(key, WRONG_CODE_LIMIT, WRONG_CODE_WINDOW_SECONDS, now);

  const code = rawCode.trim().toUpperCase();
  // A paid order sorts ahead of a collected one if a code was reused on two nights.
  const [found] = code
    ? await db
        .select({ id: orders.id, status: orders.status, collectedAt: orders.collectedAt })
        .from(orders)
        .innerJoin(drops, eq(drops.id, orders.dropId))
        .where(
          and(
            eq(orders.outletId, outletId),
            eq(orders.pickupCode, code),
            inArray(orders.status, ['paid', 'collected']),
            sql`${drops.pickupEndAt} + make_interval(mins => ${NO_SHOW_GRACE_MINUTES}) > ${now.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(sql`${orders.status} = 'paid' desc`, desc(drops.pickupEndAt))
        .limit(1)
    : [];
  if (!found) {
    await countRateLimit(key, WRONG_CODE_WINDOW_SECONDS, now);
    throw codeNotFound();
  }
  if (found.status === 'collected') throw alreadyCollected(found.collectedAt);

  // The status check under the row lock is what lets one of two parallel taps win.
  await withTx((tx) => collectLocked(tx, staffId, found.id, now));
  return orderViewById(found.id);
}

/** Collects one order by ID: search by name, or a no-show corrected until its payout is approved. */
export async function collectOrder(staffId: string, orderId: string, now: Date): Promise<OrderView> {
  if (!isId(orderId)) throw orderNotFound();
  const [found] = await db.select({ outletId: orders.outletId }).from(orders).where(eq(orders.id, orderId));
  if (!found) throw orderNotFound();
  await requireOutlet(staffId, found.outletId, PICKUP_ROLES);
  await withTx((tx) => collectLocked(tx, staffId, orderId, now));
  return orderViewById(orderId);
}
