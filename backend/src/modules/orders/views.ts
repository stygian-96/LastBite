import { and, desc, eq, gt, inArray, isNull, not, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { areas, brands, drops, listings, orderItems, orders, outlets, refunds } from '../../db/schema.js';
import { ApiError } from '../../lib/errors.js';
import { toIso } from '../../lib/time.js';

export type RefundSummary = { status: string; amountPaise: number };

/** One kind of bag in an order. A cancelled line was taken off by the vendor and refunded on its own. */
export type OrderLine = {
  dropId: string;
  name: string;
  type: string;
  diet: string;
  allergens: string[];
  quantity: number;
  unitPricePaise: number;
  /** The value of one bag. */
  valuePaise: number;
  pickupStartAt: string;
  pickupEndAt: string;
  status: 'active' | 'cancelled';
  /** While on hold, the most this line can be changed to: its listing's limit, or what is left. */
  maxQuantity: number;
};

/** What a customer sees of an order. Never carries commission or payout data. */
export type OrderView = {
  id: string;
  number: string;
  status: string;
  /** Every kind of bag in the order. The fields below name, type and diet describe the first. */
  items: OrderLine[];
  /** What all the active bags are worth together. */
  totalValuePaise: number;
  /** Bags in this order. */
  quantity: number;
  /** The order total: unitPricePaise × quantity. */
  pricePaise: number;
  unitPricePaise: number;
  /** The value of one bag. */
  valuePaise: number;
  /** While on hold, the most bags this order can be changed to: the listing's limit, or what is left. */
  maxQuantity: number;
  name: string;
  type: string;
  diet: string;
  allergens: string[];
  brandName: string;
  branchName: string;
  /** Where the outlet's page is: /{city}/{brandSlug}/{outletSlug}. */
  city: string | null;
  brandSlug: string;
  outletSlug: string;
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
  quantity: orders.quantity,
  pricePaise: orders.pricePaise,
  dropQuantity: drops.quantity,
  reservedCount: drops.reservedCount,
  maxPerOrder: listings.maxPerOrder,
  holdExpiresAt: orders.holdExpiresAt,
  pickupCode: orders.pickupCode,
  valuePaise: drops.valuePaise,
  name: drops.name,
  type: drops.type,
  diet: drops.diet,
  allergens: drops.allergens,
  pickupStartAt: orders.pickupStartAt,
  pickupEndAt: orders.pickupEndAt,
  brandName: brands.name,
  brandSlug: brands.slug,
  outletSlug: outlets.slug,
  city: areas.city,
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
    .innerJoin(listings, eq(listings.id, drops.listingId))
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .leftJoin(areas, eq(areas.id, outlets.areaId))
    .where(where);
}

/** Each order's lines, oldest first. */
async function linesByOrder(orderIds: string[]): Promise<Map<string, OrderLine[]>> {
  const map = new Map<string, OrderLine[]>();
  if (orderIds.length === 0) return map;
  const rows = await db
    .select({ item: orderItems, drop: drops, maxPerOrder: listings.maxPerOrder, orderStatus: orders.status })
    .from(orderItems)
    .innerJoin(drops, eq(drops.id, orderItems.dropId))
    .innerJoin(listings, eq(listings.id, drops.listingId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(orderItems.createdAt, orderItems.id);
  for (const { item, drop, maxPerOrder, orderStatus } of rows) {
    const line: OrderLine = {
      dropId: item.dropId,
      name: drop.name,
      type: drop.type,
      diet: drop.diet,
      allergens: drop.allergens.filter((a) => a !== ''),
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
      valuePaise: drop.valuePaise,
      pickupStartAt: toIso(drop.pickupStartAt),
      pickupEndAt: toIso(drop.pickupEndAt),
      status: item.status as OrderLine['status'],
      maxQuantity:
        orderStatus === 'held' && item.status === 'active'
          ? Math.min(maxPerOrder, drop.quantity - drop.reservedCount + item.quantity)
          : item.quantity,
    };
    map.set(item.orderId, [...(map.get(item.orderId) ?? []), line]);
  }
  return map;
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

function toView(row: Row, refund: RefundSummary | null, items: OrderLine[]): OrderView {
  const active = items.filter((l) => l.status === 'active');
  return {
    id: row.id,
    number: `SJ-${row.number.toString()}`,
    status: row.status,
    items,
    totalValuePaise: active.reduce((n, l) => n + l.valuePaise * l.quantity, 0),
    quantity: row.quantity,
    pricePaise: row.pricePaise,
    unitPricePaise: row.pricePaise / row.quantity,
    valuePaise: row.valuePaise,
    // A held order's own bags count as its to keep.
    maxQuantity:
      row.status === 'held' ? Math.min(row.maxPerOrder, row.dropQuantity - row.reservedCount + row.quantity) : row.quantity,
    name: row.name,
    type: row.type,
    diet: row.diet,
    // Anything any bag in the order may contain.
    allergens: [...new Set(active.flatMap((l) => l.allergens))],
    brandName: row.brandName,
    branchName: row.branchName,
    city: row.city,
    brandSlug: row.brandSlug,
    outletSlug: row.outletSlug,
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
  const ids = rows.map((r) => r.id);
  const [refundMap, lineMap] = await Promise.all([refundsByOrder(ids), linesByOrder(ids)]);
  return rows.map((r) => toView(r, refundMap.get(r.id) ?? null, lineMap.get(r.id) ?? []));
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
