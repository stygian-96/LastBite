import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { withTx } from '../../db/client.js';
import { orders } from '../../db/schema.js';
import { releaseStock } from './reserve.js';

const GRACE_MS = 60_000;
const BATCH_SIZE = 100;

/** Expires holds past hold_expires_at + 60s and returns their stock. Safe to run twice, or at once. */
export async function expireHolds(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - GRACE_MS).toISOString();
  let expired = 0;
  for (;;) {
    const count = await withTx(async (tx) => {
      const holds = await tx
        .select({ id: orders.id, dropId: orders.dropId, quantity: orders.quantity })
        .from(orders)
        .where(and(eq(orders.status, 'held'), lt(orders.holdExpiresAt, cutoff)))
        .orderBy(asc(orders.holdExpiresAt))
        .limit(BATCH_SIZE)
        .for('update', { skipLocked: true });
      if (holds.length === 0) return 0;

      // Every drop row first, in one fixed order, then every order row. Parallel batches cannot
      // cross, and a reserve waiting on a changed order row never holds a drop this batch still needs.
      const byDrop = [...holds].sort((a, b) => a.dropId.localeCompare(b.dropId));
      for (const hold of byDrop) await releaseStock(tx, hold.dropId, hold.quantity);
      await tx
        .update(orders)
        .set({ status: 'expired' })
        .where(
          inArray(
            orders.id,
            holds.map((h) => h.id),
          ),
        );
      return holds.length;
    });
    expired += count;
    if (count < BATCH_SIZE) return expired;
  }
}
