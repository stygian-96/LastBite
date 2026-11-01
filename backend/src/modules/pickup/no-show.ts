import { and, asc, eq, sql } from 'drizzle-orm';
import { db, withTx } from '../../db/client.js';
import { drops, orders } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { requireOutlet } from '../auth/access.js';
import { isId, NO_SHOW_GRACE_MINUTES, PICKUP_ROLES } from './collect.js';

const BATCH_SIZE = 100;
const orderNotFound = () => new ApiError('not_found', 404, 'Order not found');

/** Staff marks a paid order a no-show once its pickup window has ended. */
export async function markNoShow(staffId: string, orderId: string, now: Date): Promise<void> {
  if (!isId(orderId)) throw orderNotFound();
  const [found] = await db.select({ outletId: orders.outletId }).from(orders).where(eq(orders.id, orderId));
  if (!found) throw orderNotFound();
  await requireOutlet(staffId, found.outletId, PICKUP_ROLES);

  await withTx(async (tx) => {
    const [order] = await tx
      .select({ status: orders.status, pickupEndAt: drops.pickupEndAt })
      .from(orders)
      .innerJoin(drops, eq(drops.id, orders.dropId))
      .where(eq(orders.id, orderId))
      .for('update', { of: orders });
    if (order?.status !== 'paid') throw new ApiError('not_paid', 409, 'Only a paid order can be marked no-show');
    if (new Date(order.pickupEndAt).getTime() > now.getTime()) {
      throw new ApiError('pickup_not_ended', 409, 'Pickup has not ended yet');
    }
    await tx.update(orders).set({ status: 'no_show' }).where(eq(orders.id, orderId));
    await audit(tx, { actorId: staffId, action: 'order.no_show', entity: 'order', entityId: orderId });
  });
}

/** Marks paid orders no-show 30 minutes after pickup end. Batched, and safe to run twice or at once. */
export async function autoMarkNoShows(now: Date): Promise<number> {
  let marked = 0;
  for (;;) {
    const count = await withTx(async (tx) => {
      const due = await tx
        .select({ id: orders.id })
        .from(orders)
        .innerJoin(drops, eq(drops.id, orders.dropId))
        .where(
          and(
            eq(orders.status, 'paid'),
            sql`${drops.pickupEndAt} + make_interval(mins => ${NO_SHOW_GRACE_MINUTES}) < ${now.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(asc(drops.pickupEndAt), asc(orders.id))
        .limit(BATCH_SIZE)
        .for('update', { of: orders, skipLocked: true });
      for (const { id } of due) {
        await tx.update(orders).set({ status: 'no_show' }).where(and(eq(orders.id, id), eq(orders.status, 'paid')));
        await audit(tx, { actorId: null, action: 'order.no_show', entity: 'order', entityId: id, detail: { auto: true } });
      }
      return due.length;
    });
    marked += count;
    if (count < BATCH_SIZE) return marked;
  }
}
