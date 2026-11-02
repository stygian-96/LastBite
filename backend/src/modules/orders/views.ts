import { and, desc, eq, gt, inArray, isNull, not, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { brands, drops, orders, outlets, refunds } from '../../db/schema.js';
import { ApiError } from '../../lib/errors.js';
import { toIso } from '../../lib/time.js';

export type RefundSummary = { status: string; amountPaise: number };

/** What a customer sees of an order. Never carries commission or payout data. */
export type OrderView = {
  id: string;
  number: string;
  status: string;
  pricePaise: number;
  valuePaise: number;
  name: string;
  type: string;
  diet: string;
  allergens: string[];
  brandName: string;
  branchName: string;
  address: string | null;
  mapsUrl: string | null;
  pickupInstructions: string | null;
  pickupStartAt: string;
  pickupEndAt: string;
  holdExpiresAt: string;
  /** Null until the order is paid; it stays visible once collected. */
  pickupCode: string | null;
  refund: RefundSummary | null;
};

export type Viewer = { userId?: string; anonId?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ApiError('not_found', 404, 'Order not found');

const columns = {
  id: orders.id,
  number: orders.number,
  status: orders.status,
  pricePaise: orders.pricePaise,
  holdExpiresAt: orders.holdExpiresAt,
  pickupCode: orders.pickupCode,
  valuePaise: drops.valuePaise,
  name: drops.name,
  type: drops.type,
  diet: drops.diet,
  allergens: drops.allergens,
  pickupStartAt: drops.pickupStartAt,
  pickupEndAt: drops.pickupEndAt,
  brandName: brands.name,
  branchName: outlets.branchName,
  address: outlets.address,
  mapsUrl: outlets.mapsUrl,
  pickupInstructions: outlets.pickupInstructions,
};

function selectOrders(where: SQL | undefined) {
  return db
    .select(columns)
    .from(orders)
    .innerJoin(drops, eq(drops.id, orders.dropId))
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .where(where);
}

/** The newest refund of each order. */
async function refundsByOrder(orderIds: string[]): Promise<Map<string, RefundSummary>> {
  const map = new Map<string, RefundSummary>();
  if (orderIds.length === 0) return map;
  const rows = await db
    .select({ orderId: refunds.orderId, status: refunds.status, amountPaise: refunds.amountPaise })
    .from(refunds)
    .where(inArray(refunds.orderId, orderIds))
    .orderBy(desc(refunds.createdAt));
  for (const r of rows) if (!map.has(r.orderId)) map.set(r.orderId, { status: r.status, amountPaise: r.amountPaise });
  return map;
}

type Row = Awaited<ReturnType<typeof selectOrders>>[number];

function toView(row: Row, refund: RefundSummary | null): OrderView {
  return {
    id: row.id,
    number: `SJ-${row.number.toString()}`,
    status: row.status,
    pricePaise: row.pricePaise,
    valuePaise: row.valuePaise,
    name: row.name,
    type: row.type,
    diet: row.diet,
    allergens: row.allergens.filter((a) => a !== ''),
    brandName: row.brandName,
    branchName: row.branchName,
    address: row.address,
    mapsUrl: row.mapsUrl,
    pickupInstructions: row.pickupInstructions,
    pickupStartAt: toIso(row.pickupStartAt),
    pickupEndAt: toIso(row.pickupEndAt),
    holdExpiresAt: toIso(row.holdExpiresAt),
    pickupCode: row.status === 'paid' || row.status === 'collected' ? row.pickupCode : null,
    refund,
  };
}

async function toViews(rows: Row[]): Promise<OrderView[]> {
  const refundMap = await refundsByOrder(rows.map((r) => r.id));
  return rows.map((r) => toView(r, refundMap.get(r.id) ?? null));
}

/**
 * Matches this order only for its owner: its user, or its anonymous holder until it has a user.
 * Once attached, the cookie stays in the browser, and the next person on it must not own the order.
 */
export function ownedOrder(viewer: Viewer, orderId: string): SQL | undefined {
  if (!UUID.test(orderId)) throw notFound();
  const owner: SQL[] = [];
  if (viewer.userId) owner.push(eq(orders.userId, viewer.userId));
  if (viewer.anonId) owner.push(and(eq(orders.anonId, viewer.anonId), isNull(orders.userId))!);
  if (owner.length === 0) throw notFound();
  return and(eq(orders.id, orderId), or(...owner));
}

/** One order for its owner. Anyone else gets a 404, never a 403. */
export async function getOrder(viewer: Viewer, orderId: string): Promise<OrderView> {
  const [row] = await selectOrders(ownedOrder(viewer, orderId));
  if (!row) throw notFound();
  return (await toViews([row]))[0]!;
}

/**
 * The signed-in user's orders, newest first: all of them, or only the active or the past. Active
 * means held or paid with pickup not yet closed; everything else, refunded orders included, is past.
 */
export async function listMyOrders(userId: string, status: 'active' | 'past' | undefined, now: Date): Promise<OrderView[]> {
  const active = and(inArray(orders.status, ['held', 'paid']), gt(drops.pickupEndAt, now.toISOString()));
  const wanted = status === undefined ? undefined : status === 'active' ? active : not(active!);
  const rows = await selectOrders(and(eq(orders.userId, userId), wanted)).orderBy(desc(orders.createdAt));
  return toViews(rows);
}

/** One order as its customer sees it, for a caller that has already checked access to the order outlet. */
export async function orderViewById(orderId: string): Promise<OrderView> {
  const [row] = await selectOrders(eq(orders.id, orderId));
  if (!row) throw notFound();
  return (await toViews([row]))[0]!;
}
