import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db, withTx, type Tx } from '../../db/client.js';
import { drops, listings, orders, outlets, payments } from '../../db/schema.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { z } from 'zod';
import { commissionPaise } from '../../lib/money.js';
import { checkRateLimit, countRateLimit } from '../../lib/rate-limit.js';
import { ownedOrder, type Viewer } from './views.js';

export type Order = typeof orders.$inferSelect;
type Hold = Pick<Order, 'id' | 'dropId' | 'quantity'>;

/** The most bags any order can hold, whatever a listing allows. The orders table checks it too. */
export const MAX_PER_ORDER = 10;
const quantitySchema = z.number().int().min(1).max(MAX_PER_ORDER);

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
async function refusal(r: { dropId: string; userId?: string; anonId?: string; quantity?: number }, now: Date): Promise<ApiError> {
  const [row] = await db
    .select({
      outletId: drops.outletId,
      serviceDate: drops.serviceDate,
      dropStatus: drops.status,
      salesEndAt: drops.salesEndAt,
      quantity: drops.quantity,
      reservedCount: drops.reservedCount,
      maxPerOrder: listings.maxPerOrder,
      outletStatus: outlets.status,
      pausedUntil: outlets.pausedUntil,
    })
    .from(drops)
    .innerJoin(outlets, eq(outlets.id, drops.outletId))
    .innerJoin(listings, eq(listings.id, drops.listingId))
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
  if (!onSale) return new ApiError('not_on_sale', 409, 'This bag is not on sale');
  return quantityRefusal(r.quantity ?? 1, row);
}

/** Why `wanted` bags could not be taken from a drop that is on sale. */
function quantityRefusal(wanted: number, d: { quantity: number; reservedCount: number; maxPerOrder: number }, alreadyHeld = 0): ApiError {
  const left = d.quantity - d.reservedCount + alreadyHeld;
  if (left <= 0) return new ApiError('sold_out', 409, 'This bag has sold out');
  if (wanted > d.maxPerOrder) {
    return new ApiError('over_limit', 409, `You can take up to ${d.maxPerOrder} of this bag`, { maxPerOrder: d.maxPerOrder });
  }
  return new ApiError('not_enough_left', 409, `Only ${left} left`, { remaining: left });
}

/**
 * Takes `take` bags if this drop is on sale with that many left, for an order that will then hold
 * `orderTotal` bags, which must be within the listing's limit. The conditional update prevents
 * overselling.
 */
export async function takeStock(tx: Tx, dropId: string, nowIso: string, take = 1, orderTotal = take) {
  const [drop] = await tx
    .update(drops)
    .set({ reservedCount: sql`${drops.reservedCount} + ${take}` })
    .from(outlets)
    .where(
      and(
        eq(drops.id, dropId),
        eq(outlets.id, drops.outletId),
        eq(drops.status, 'live'),
        eq(outlets.status, 'live'),
        or(isNull(outlets.pausedUntil), lt(outlets.pausedUntil, nowIso)),
        gt(drops.salesEndAt, nowIso),
        lte(sql`${drops.reservedCount} + ${take}`, drops.quantity),
        lte(sql`${orderTotal}`, sql`(SELECT ${listings.maxPerOrder} FROM ${listings} WHERE ${listings.id} = ${drops.listingId})`),
      ),
    )
    .returning({
      outletId: drops.outletId,
      serviceDate: drops.serviceDate,
      pricePaise: drops.pricePaise,
      commissionBps: outlets.commissionBps,
      payoutAccountId: outlets.payoutAccountId,
    });
  return drop;
}

/** Holds `quantity` bags (1 by default) for 5 minutes. The conditional update is what prevents overselling (spec 7.1). */
export async function reserveDrop(
  r: { dropId: string; userId?: string; anonId?: string; ip: string; quantity?: unknown },
  now: Date,
): Promise<Order> {
  const quantity = parseInput(quantitySchema, r.quantity ?? 1);
  // Signed-out holds only, and only those that succeed, so sold-out taps on a shared IP cost nothing.
  // With no known address the limit is skipped, or every such caller would share one bucket.
  const ipLimitKey = r.userId || !r.ip ? undefined : `hold:ip:${r.ip}`;
  if (ipLimitKey) await checkRateLimit(ipLimitKey, HOLDS_PER_IP, HOLD_WINDOW_SECONDS, now);
  const nowIso = now.toISOString();

  let order: Order | undefined;
  try {
    order = await withTx(async (tx) => {
      const drop = await takeStock(tx, r.dropId, nowIso, quantity);
      if (!drop) return undefined;
      const total = drop.pricePaise * quantity;

      const [row] = await tx
        .insert(orders)
        .values({
          userId: r.userId,
          anonId: r.anonId,
          dropId: r.dropId,
          outletId: drop.outletId,
          payoutAccountId: drop.payoutAccountId,
          serviceDate: drop.serviceDate,
          quantity,
          pricePaise: total,
          commissionBps: drop.commissionBps,
          commissionPaise: commissionPaise(total, drop.commissionBps),
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
  if (!order) throw await refusal({ ...r, quantity }, now);
  if (ipLimitKey) await countRateLimit(ipLimitKey, HOLD_WINDOW_SECONDS, now);
  return order;
}

/** Puts `count` bags back. Call it in the same transaction as the status change that ends a hold. */
export async function releaseStock(tx: Tx, dropId: string, count = 1): Promise<void> {
  await tx
    .update(drops)
    .set({ reservedCount: sql`${drops.reservedCount} - ${count}` })
    .where(and(eq(drops.id, dropId), gte(drops.reservedCount, count)));
}

/**
 * Ends a hold the caller has locked, early, so hold_expires_at records when it really ended.
 * Stock goes first: a reserve holds the drop row and then may wait on a changed order row, so
 * changing the order before taking the drop would deadlock against it.
 */
export async function endHold(tx: Tx, hold: Hold, endedAt: string): Promise<void> {
  await releaseStock(tx, hold.dropId, hold.quantity);
  await tx.update(orders).set({ status: 'expired', holdExpiresAt: endedAt }).where(eq(orders.id, hold.id));
}

/** The customer gives a hold back. Anyone but its owner gets a 404. */
export async function releaseHold(viewer: Viewer, orderId: string, now: Date): Promise<void> {
  const where = ownedOrder(viewer, orderId);
  await withTx(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, dropId: orders.dropId, quantity: orders.quantity, status: orders.status })
      .from(orders)
      .where(where)
      .for('update');
    if (!order) throw new ApiError('not_found', 404, 'Order not found');
    if (order.status !== 'held') throw new ApiError('hold_not_active', 409, 'This order is no longer on hold');
    await endHold(tx, order, now.toISOString());
  });
}

/**
 * Changes how many bags a hold is for, before payment starts: the Razorpay order is made for the
 * total, so after that the quantity is fixed. More bags are taken from stock now, fewer go back.
 * The order row is locked first, then the drop, as releaseHold does.
 */
export async function changeHoldQuantity(viewer: Viewer, orderId: string, rawQuantity: unknown, now: Date): Promise<void> {
  const quantity = parseInput(quantitySchema, rawQuantity);
  const nowIso = now.toISOString();
  const where = ownedOrder(viewer, orderId);
  const failed = await withTx(async (tx) => {
    const [order] = await tx.select().from(orders).where(where).for('update');
    if (!order) throw new ApiError('not_found', 404, 'Order not found');
    if (order.status !== 'held' || new Date(order.holdExpiresAt) <= now) {
      throw new ApiError('hold_not_active', 409, 'This order is no longer on hold');
    }
    const [payment] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.id)).limit(1);
    if (payment) throw new ApiError('payment_started', 409, 'Payment has started, so the number of bags can’t change');
    if (quantity === order.quantity) return undefined;

    if (quantity > order.quantity) {
      const took = await takeStock(tx, order.dropId, nowIso, quantity - order.quantity, quantity);
      if (!took) return order;
    } else {
      await releaseStock(tx, order.dropId, order.quantity - quantity);
    }
    const total = (order.pricePaise / order.quantity) * quantity;
    await tx
      .update(orders)
      .set({ quantity, pricePaise: total, commissionPaise: commissionPaise(total, order.commissionBps) })
      .where(eq(orders.id, order.id));
    return undefined;
  });
  if (!failed) return;

  const [d] = await db
    .select({ quantity: drops.quantity, reservedCount: drops.reservedCount, maxPerOrder: listings.maxPerOrder })
    .from(drops)
    .innerJoin(listings, eq(listings.id, drops.listingId))
    .where(eq(drops.id, failed.dropId));
  throw quantityRefusal(quantity, d!, failed.quantity);
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
      .select({ id: orders.id, dropId: orders.dropId, quantity: orders.quantity, outletId: orders.outletId, serviceDate: orders.serviceDate })
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
