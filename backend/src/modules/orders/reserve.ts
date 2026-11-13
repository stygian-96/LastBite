import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, withTx, type Tx } from '../../db/client.js';
import { drops, listings, orderItems, orders, outlets, payments } from '../../db/schema.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { z } from 'zod';
import { commissionPaise } from '../../lib/money.js';
import { checkRateLimit, countRateLimit } from '../../lib/rate-limit.js';
import { ownedOrder, type Viewer } from './views.js';

export type Order = typeof orders.$inferSelect;
type Hold = Pick<Order, 'id'>;
export type OrderItem = typeof orderItems.$inferSelect;

/** The highest limit a vendor can set on one bag, so the most of one bag any customer can take. */
export const MAX_PER_ORDER = 10;
const quantitySchema = z.number().int().min(1).max(MAX_PER_ORDER);

const HOLD_MS = 5 * 60_000;
const HOLDS_PER_IP = 5;
const HOLD_WINDOW_SECONDS = 3600;

// Orders that count towards what a customer has of a bag tonight.
const NIGHT_ORDER_STATUSES = ['held', 'paid', 'collected', 'no_show'];

/** A customer: signed in, or the anonymous holder of a cookie. */
type Who = { userId?: string | null; anonId?: string | null };

/**
 * How many of this drop the customer already has in their other orders: the vendor's limit is per
 * customer per night, however many orders they place. A customer can order as often as they like.
 * It locks the customer until the transaction ends, so two of their requests at once count each
 * other. Call it before taking stock: the lock comes before the drop's.
 */
export async function takenTonight(tx: Tx, who: Who, dropId: string, exceptOrderId?: string): Promise<number> {
  const key = who.userId ?? who.anonId;
  if (!key) return 0;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'customer:' + key}, 0))`);
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.dropId, dropId),
        eq(orderItems.status, 'active'),
        inArray(orders.status, NIGHT_ORDER_STATUSES),
        who.userId ? eq(orders.userId, who.userId) : and(eq(orders.anonId, who.anonId!), isNull(orders.userId)),
        exceptOrderId ? sql`${orders.id} <> ${exceptOrderId}` : undefined,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Explains a reserve that was already refused. Nothing depends on this read but the wording of the
 * error: the conditional update and the unique indexes have decided the outcome.
 */
async function refusal(r: { dropId: string; quantity?: number; taken?: number }, now: Date): Promise<ApiError> {
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

  const onSale =
    row.dropStatus === 'live' &&
    row.outletStatus === 'live' &&
    (row.pausedUntil === null || new Date(row.pausedUntil) < now) &&
    new Date(row.salesEndAt) > now;
  if (!onSale) return new ApiError('not_on_sale', 409, 'This bag is not on sale');
  return quantityRefusal(r.quantity ?? 1, row, 0, r.taken ?? 0);
}

/**
 * Why `wanted` bags could not be taken from a drop that is on sale. `alreadyHeld` is what this order
 * has of it, `taken` what the customer's other orders tonight have.
 */
function quantityRefusal(wanted: number, d: { quantity: number; reservedCount: number; maxPerOrder: number }, alreadyHeld = 0, taken = 0): ApiError {
  const left = d.quantity - d.reservedCount + alreadyHeld;
  if (left <= 0) return new ApiError('sold_out', 409, 'This bag has sold out');
  if (wanted + taken > d.maxPerOrder) {
    const message =
      taken > 0 ? `You can take up to ${d.maxPerOrder} of this bag tonight, and your other orders already have ${taken}` : `You can take up to ${d.maxPerOrder} of this bag`;
    return new ApiError('over_limit', 409, message, { maxPerOrder: d.maxPerOrder, alreadyHave: taken });
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
      pickupStartAt: drops.pickupStartAt,
      pickupEndAt: drops.pickupEndAt,
      commissionBps: outlets.commissionBps,
      payoutAccountId: outlets.payoutAccountId,
    });
  return drop;
}

/** An order's lines still in it, in drop order, the order drop rows are locked in. */
export function activeItems(tx: Tx | typeof db, orderId: string): Promise<OrderItem[]> {
  return tx
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'active')))
    .orderBy(asc(orderItems.dropId));
}

/** Puts back the stock of every line still in the order. */
export async function releaseItems(tx: Tx, orderId: string): Promise<void> {
  for (const item of await activeItems(tx, orderId)) await releaseStock(tx, item.dropId, item.quantity);
}

/**
 * Sets an order's bag count and pickup window from its active lines, and its first line. With
 * `money` (a hold, before payment) the total and commission follow too; a paid order keeps the
 * amount it was paid, and a cancelled line is refunded on its own.
 */
export async function recomputeOrder(tx: Tx, orderId: string, money: boolean): Promise<void> {
  const [order] = await tx.select({ commissionBps: orders.commissionBps }).from(orders).where(eq(orders.id, orderId));
  const rows = await tx
    .select({ item: orderItems, startAt: drops.pickupStartAt, endAt: drops.pickupEndAt })
    .from(orderItems)
    .innerJoin(drops, eq(drops.id, orderItems.dropId))
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'active')))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  if (rows.length === 0) return;
  const total = rows.reduce((n, r) => n + r.item.quantity * r.item.unitPricePaise, 0);
  const ms = (v: string) => new Date(v).getTime();
  await tx
    .update(orders)
    .set({
      dropId: rows[0]!.item.dropId,
      quantity: rows.reduce((n, r) => n + r.item.quantity, 0),
      pickupStartAt: new Date(Math.min(...rows.map((r) => ms(r.startAt)))).toISOString(),
      pickupEndAt: new Date(Math.max(...rows.map((r) => ms(r.endAt)))).toISOString(),
      ...(money ? { pricePaise: total, commissionPaise: commissionPaise(total, order!.commissionBps) } : {}),
    })
    .where(eq(orders.id, orderId));
}

/** Holds `quantity` bags (1 by default) for 5 minutes. The conditional update is what prevents overselling (spec 7.1). */
export async function reserveDrop(
  r: { dropId: string; userId?: string; anonId?: string; ip: string; quantity?: unknown },
  now: Date,
): Promise<Order> {
  const quantity = parseInput(quantitySchema, r.quantity ?? 1);
  // Already holding bags at this outlet tonight: this one joins that order.
  const open = await openHoldFor(r, now);
  if (open) {
    await addToHold(open, r.dropId, quantity, now);
    const [row] = await db.select().from(orders).where(eq(orders.id, open));
    return row!;
  }
  // Signed-out holds only, and only those that succeed, so sold-out taps on a shared IP cost nothing.
  // With no known address the limit is skipped, or every such caller would share one bucket.
  const ipLimitKey = r.userId || !r.ip ? undefined : `hold:ip:${r.ip}`;
  if (ipLimitKey) await checkRateLimit(ipLimitKey, HOLDS_PER_IP, HOLD_WINDOW_SECONDS, now);
  const nowIso = now.toISOString();
  let taken = 0;

  const order: Order | undefined = await withTx(async (tx) => {
    taken = await takenTonight(tx, r, r.dropId);
    const drop = await takeStock(tx, r.dropId, nowIso, quantity, taken + quantity);
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
        pickupStartAt: drop.pickupStartAt,
        pickupEndAt: drop.pickupEndAt,
        holdExpiresAt: new Date(now.getTime() + HOLD_MS).toISOString(),
        createdAt: nowIso,
      })
      .returning();
    await tx.insert(orderItems).values({ orderId: row!.id, dropId: r.dropId, quantity, unitPricePaise: drop.pricePaise, createdAt: nowIso });
    return row;
  });
  if (!order) throw await refusal({ ...r, quantity, taken }, now);
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
  await releaseItems(tx, hold.id);
  await tx.update(orders).set({ status: 'expired', holdExpiresAt: endedAt }).where(eq(orders.id, hold.id));
}

/** The customer gives a hold back. Anyone but its owner gets a 404. */
export async function releaseHold(viewer: Viewer, orderId: string, now: Date): Promise<void> {
  const where = ownedOrder(viewer, orderId);
  await withTx(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(where)
      .for('update');
    if (!order) throw new ApiError('not_found', 404, 'Order not found');
    if (order.status !== 'held') throw new ApiError('hold_not_active', 409, 'This order is no longer on hold');
    await endHold(tx, order, now.toISOString());
  });
}

/** Locks a hold the viewer owns and checks it can still change: running, and payment not started. */
async function lockOpenHold(tx: Tx, where: SQL | undefined, now: Date): Promise<Order> {
  const [order] = await tx.select().from(orders).where(where).for('update');
  if (!order) throw new ApiError('not_found', 404, 'Order not found');
  if (order.status !== 'held' || new Date(order.holdExpiresAt) <= now) {
    throw new ApiError('hold_not_active', 409, 'This order is no longer on hold');
  }
  const [payment] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.id)).limit(1);
  if (payment) throw new ApiError('payment_started', 409, 'Payment has started, so the bags in this order can’t change');
  return order;
}


/** The viewer's running, unpaid hold at the outlet of this drop tonight, if any. */
async function openHoldFor(r: { dropId: string; userId?: string; anonId?: string }, now: Date): Promise<string | undefined> {
  if (!r.userId && !r.anonId) return undefined;
  const [drop] = await db.select({ outletId: drops.outletId, serviceDate: drops.serviceDate }).from(drops).where(eq(drops.id, r.dropId));
  if (!drop) return undefined;
  const [hold] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        r.userId ? eq(orders.userId, r.userId) : and(eq(orders.anonId, r.anonId!), isNull(orders.userId)),
        eq(orders.outletId, drop.outletId),
        eq(orders.serviceDate, drop.serviceDate),
        eq(orders.status, 'held'),
        gt(orders.holdExpiresAt, now.toISOString()),
      ),
    );
  if (!hold) return undefined;
  const [payment] = await db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, hold.id)).limit(1);
  return payment ? undefined : hold.id;
}

/**
 * Adds a bag to a running hold at the same outlet and night, or more of one already in it. The hold
 * keeps its timer. Each line keeps to its listing's limit, and the order to 10 bags.
 */
async function addToHold(orderId: string, dropId: string, quantity: number, now: Date): Promise<void> {
  const failed = await withTx(async (tx) => {
    const order = await lockOpenHold(tx, eq(orders.id, orderId), now);
    const [drop] = await tx.select({ outletId: drops.outletId, serviceDate: drops.serviceDate }).from(drops).where(eq(drops.id, dropId));
    if (!drop || drop.outletId !== order.outletId || drop.serviceDate !== order.serviceDate) {
      throw new ApiError('other_outlet', 409, 'One order is for one outlet and one night');
    }
    const [line] = await tx
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, orderId), eq(orderItems.dropId, dropId), eq(orderItems.status, 'active')));
    const lineTotal = (line?.quantity ?? 0) + quantity;
    const taken = await takenTonight(tx, order, dropId, order.id);
    const took = await takeStock(tx, dropId, now.toISOString(), quantity, taken + lineTotal);
    if (!took) return { dropId, wanted: lineTotal, held: line?.quantity ?? 0, taken };
    if (line) await tx.update(orderItems).set({ quantity: lineTotal }).where(eq(orderItems.id, line.id));
    // Stamped by the database, so a later line sorts after the first even within one request clock.
    else await tx.insert(orderItems).values({ orderId, dropId, quantity, unitPricePaise: took.pricePaise });
    await recomputeOrder(tx, orderId, true);
    return undefined;
  });
  if (failed) throw await lineRefusal(failed, now, orderId);
}

/** Why a line could not grow to `wanted` bags. A refusal while adding to a hold points at that hold. */
async function lineRefusal(f: { dropId: string; wanted: number; held: number; taken: number }, now: Date, holdId?: string): Promise<ApiError> {
  const [d] = await db
    .select({ quantity: drops.quantity, reservedCount: drops.reservedCount, maxPerOrder: listings.maxPerOrder, status: drops.status, salesEndAt: drops.salesEndAt })
    .from(drops)
    .innerJoin(listings, eq(listings.id, drops.listingId))
    .where(eq(drops.id, f.dropId));
  const e = !d || d.status !== 'live' || new Date(d.salesEndAt) <= now ? new ApiError('not_on_sale', 409, 'This bag is not on sale') : quantityRefusal(f.wanted, d, f.held, f.taken);
  return holdId ? new ApiError(e.code, e.status, e.message, { ...e.details, existingOrderId: holdId }) : e;
}

/**
 * Sets how many of one bag a hold has, before payment starts: the Razorpay order is made for the
 * total, so after that it is fixed. 0 takes the bag out, unless it is the only one (give the hold
 * back instead). With no drop named, the order's first line. The order row is locked first, then the
 * drop, as releaseHold does.
 */
export async function changeItemQuantity(
  viewer: Viewer,
  orderId: string,
  dropId: string | undefined,
  rawQuantity: unknown,
  now: Date,
): Promise<void> {
  const quantity = parseInput(z.number().int().min(0).max(MAX_PER_ORDER), rawQuantity);
  const failed = await withTx(async (tx) => {
    const order = await lockOpenHold(tx, ownedOrder(viewer, orderId), now);
    const lines = await activeItems(tx, order.id);
    const line = lines.find((l) => l.dropId === (dropId ?? order.dropId));
    if (!line) throw new ApiError('not_found', 404, 'That bag isn’t in this order');
    if (quantity === line.quantity) return undefined;
    if (quantity === 0 && lines.length === 1) {
      throw new ApiError('last_item', 409, 'This is the only bag in the order. Cancel the order instead');
    }
    if (quantity > line.quantity) {
      const taken = await takenTonight(tx, order, line.dropId, order.id);
      const took = await takeStock(tx, line.dropId, now.toISOString(), quantity - line.quantity, taken + quantity);
      if (!took) return { dropId: line.dropId, wanted: quantity, held: line.quantity, taken };
    } else {
      await releaseStock(tx, line.dropId, line.quantity - quantity);
    }
    if (quantity === 0) await tx.delete(orderItems).where(eq(orderItems.id, line.id));
    else await tx.update(orderItems).set({ quantity }).where(eq(orderItems.id, line.id));
    await recomputeOrder(tx, order.id, true);
    return undefined;
  });
  if (failed) throw await lineRefusal(failed, now);
}

/** Sets how many bags of the order's first line it has. Kept for single-bag orders and older clients. */
export function changeHoldQuantity(viewer: Viewer, orderId: string, rawQuantity: unknown, now: Date): Promise<void> {
  if (rawQuantity === 0) throw new ApiError('invalid_request', 400, 'Choose at least one bag');
  return changeItemQuantity(viewer, orderId, undefined, rawQuantity, now);
}

/**
 * Gives an anonymous hold to the customer who just signed in, keeping its original expiry. A customer
 * can have several orders at an outlet, so it always attaches.
 */
export async function attachHolds(anonId: string, userId: string, now: Date): Promise<{ attachedOrderId?: string; existingOrderId?: string }> {
  return withTx(async (tx) => {
    const [hold] = await tx
      .update(orders)
      .set({ userId })
      .where(and(eq(orders.anonId, anonId), isNull(orders.userId), eq(orders.status, 'held'), gt(orders.holdExpiresAt, now.toISOString())))
      .returning({ id: orders.id });
    return hold ? { attachedOrderId: hold.id } : {};
  });
}
