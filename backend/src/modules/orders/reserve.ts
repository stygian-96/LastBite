import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db, withTx, type Tx } from '../../db/client.js';
import { drops, orders, outlets } from '../../db/schema.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ApiError } from '../../lib/errors.js';
import { commissionPaise } from '../../lib/money.js';
import { checkRateLimit, countRateLimit } from '../../lib/rate-limit.js';
import { ownedOrder, type Viewer } from './views.js';

export type Order = typeof orders.$inferSelect;
type Hold = Pick<Order, 'id' | 'dropId'>;

const HOLD_MS = 5 * 60_000;
const HOLDS_PER_IP = 5;
const HOLD_WINDOW_SECONDS = 3600;

// The statuses covered by the one_order_per_outlet_night index.
const NIGHT_ORDER_STATUSES = ['held', 'paid', 'collected', 'no_show'];

export async function findNightOrder(
  q: Tx | typeof db,
  userId: string,
  outletId: string,
  serviceDate: string,
): Promise<string | undefined> {
  const [row] = await q
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.outletId, outletId),
        eq(orders.serviceDate, serviceDate),
        inArray(orders.status, NIGHT_ORDER_STATUSES),
      ),
    );
  return row?.id;
}

async function findAnonHold(anonId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.anonId, anonId), eq(orders.status, 'held'), isNull(orders.userId)));
  return row?.id;
}

/**
 * Explains a reserve that was already refused. Nothing depends on this read but the wording of the
 * error: the conditional update and the unique indexes have decided the outcome.
 */
async function refusal(r: { dropId: string; userId?: string; anonId?: string }, now: Date): Promise<ApiError> {
  const [row] = await db
    .select({
      outletId: drops.outletId,
      serviceDate: drops.serviceDate,
      dropStatus: drops.status,
      salesEndAt: drops.salesEndAt,
      outletStatus: outlets.status,
      pausedUntil: outlets.pausedUntil,
    })
    .from(drops)
    .innerJoin(outlets, eq(outlets.id, drops.outletId))
    .where(eq(drops.id, r.dropId));
  if (!row) return new ApiError('not_found', 404, 'Drop not found');

  const nightOrder = r.userId ? await findNightOrder(db, r.userId, row.outletId, row.serviceDate) : undefined;
  if (nightOrder) {
    return new ApiError('already_ordered', 409, 'You already have an order at this outlet tonight', {
      existingOrderId: nightOrder,
    });
  }
  const anonHold = !r.userId && r.anonId ? await findAnonHold(r.anonId) : undefined;
  if (anonHold) {
    return new ApiError('hold_exists', 409, 'You already have a bag on hold', { existingOrderId: anonHold });
  }

  const onSale =
    row.dropStatus === 'live' &&
    row.outletStatus === 'live' &&
    (row.pausedUntil === null || new Date(row.pausedUntil) < now) &&
    new Date(row.salesEndAt) > now;
  return onSale
    ? new ApiError('sold_out', 409, 'This bag has sold out')
    : new ApiError('not_on_sale', 409, 'This bag is not on sale');
}

/** Takes one bag if this drop is on sale with stock left. The conditional update prevents overselling. */
export async function takeStock(tx: Tx, dropId: string, nowIso: string) {
  const [drop] = await tx
    .update(drops)
    .set({ reservedCount: sql`${drops.reservedCount} + 1` })
    .from(outlets)
    .where(
      and(
        eq(drops.id, dropId),
        eq(outlets.id, drops.outletId),
        eq(drops.status, 'live'),
        eq(outlets.status, 'live'),
        or(isNull(outlets.pausedUntil), lt(outlets.pausedUntil, nowIso)),
        gt(drops.salesEndAt, nowIso),
        lt(drops.reservedCount, drops.quantity),
      ),
    )
    .returning({
      outletId: drops.outletId,
      serviceDate: drops.serviceDate,
      pricePaise: drops.pricePaise,
      commissionBps: outlets.commissionBps,
    });
  return drop;
}

/** Holds one bag for 5 minutes. The conditional update is what prevents overselling (spec 7.1). */
export async function reserveDrop(
  r: { dropId: string; userId?: string; anonId?: string; ip: string },
  now: Date,
): Promise<Order> {
  // Signed-out holds only, and only those that succeed, so sold-out taps on a shared IP cost nothing.
  const ipLimitKey = r.userId ? undefined : `hold:ip:${r.ip || 'unknown'}`;
  if (ipLimitKey) await checkRateLimit(ipLimitKey, HOLDS_PER_IP, HOLD_WINDOW_SECONDS, now);
  const nowIso = now.toISOString();

  let order: Order | undefined;
  try {
    order = await withTx(async (tx) => {
      const drop = await takeStock(tx, r.dropId, nowIso);
      if (!drop) return undefined;

      const [row] = await tx
        .insert(orders)
        .values({
          userId: r.userId,
          anonId: r.anonId,
          dropId: r.dropId,
          outletId: drop.outletId,
          serviceDate: drop.serviceDate,
          pricePaise: drop.pricePaise,
          commissionBps: drop.commissionBps,
          commissionPaise: commissionPaise(drop.pricePaise, drop.commissionBps),
          holdExpiresAt: new Date(now.getTime() + HOLD_MS).toISOString(),
          createdAt: nowIso,
        })
        .returning();
      return row;
    });
  } catch (e) {
    // The rollback has put the bag back.
    if (!isUniqueViolation(e, 'one_order_per_outlet_night') && !isUniqueViolation(e, 'one_hold_per_anon')) throw e;
  }
  if (!order) throw await refusal(r, now);
  if (ipLimitKey) await countRateLimit(ipLimitKey, HOLD_WINDOW_SECONDS, now);
  return order;
}

/** Puts one bag back. Call it in the same transaction as the status change that ends a hold. */
export async function releaseStock(tx: Tx, dropId: string): Promise<void> {
  await tx
    .update(drops)
    .set({ reservedCount: sql`${drops.reservedCount} - 1` })
    .where(and(eq(drops.id, dropId), gt(drops.reservedCount, 0)));
}

/**
 * Ends a hold the caller has locked, early, so hold_expires_at records when it really ended.
 * Stock goes first: a reserve holds the drop row and then may wait on a changed order row, so
 * changing the order before taking the drop would deadlock against it.
 */
async function endHold(tx: Tx, hold: Hold, endedAt: string): Promise<void> {
  await releaseStock(tx, hold.dropId);
  await tx.update(orders).set({ status: 'expired', holdExpiresAt: endedAt }).where(eq(orders.id, hold.id));
}

/** The customer gives a hold back. Anyone but its owner gets a 404. */
export async function releaseHold(viewer: Viewer, orderId: string, now: Date): Promise<void> {
  const where = ownedOrder(viewer, orderId);
  await withTx(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, dropId: orders.dropId, status: orders.status })
      .from(orders)
      .where(where)
      .for('update');
    if (!order) throw new ApiError('not_found', 404, 'Order not found');
    if (order.status !== 'held') throw new ApiError('hold_not_active', 409, 'This order is no longer on hold');
    await endHold(tx, order, now.toISOString());
  });
}

/**
 * Gives an anonymous hold to the customer who just signed in, keeping its original expiry. If they
 * already have an order at that outlet tonight, the hold is released and that order is returned.
 */
export async function attachHolds(
  anonId: string,
  userId: string,
  now: Date,
): Promise<{ attachedOrderId?: string; existingOrderId?: string }> {
  const nowIso = now.toISOString();
  return withTx(async (tx) => {
    const [hold] = await tx
      .select({ id: orders.id, dropId: orders.dropId, outletId: orders.outletId, serviceDate: orders.serviceDate })
      .from(orders)
      .where(
        and(
          eq(orders.anonId, anonId),
          isNull(orders.userId),
          eq(orders.status, 'held'),
          gt(orders.holdExpiresAt, nowIso),
        ),
      )
      .for('update');
    if (!hold) return {};

    try {
      // A savepoint, so the outer transaction survives the unique violation.
      await tx.transaction((sp) => sp.update(orders).set({ userId }).where(eq(orders.id, hold.id)));
      return { attachedOrderId: hold.id };
    } catch (e) {
      if (!isUniqueViolation(e, 'one_order_per_outlet_night')) throw e;
    }

    const existingOrderId = await findNightOrder(tx, userId, hold.outletId, hold.serviceDate);
    // The other order ended in the moment since the violation: leave this hold for a later sign-in.
    if (!existingOrderId) return {};
    await endHold(tx, hold, nowIso);
    return { existingOrderId };
  });
}
