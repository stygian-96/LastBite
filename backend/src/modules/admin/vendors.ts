import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { areas, brands, drops, listings, memberships, orderItems, orders, outlets, users } from '../../db/schema.js';
import { ApiError } from '../../lib/errors.js';
import { serviceDate } from '../../lib/time.js';
import { getOutletStats } from './support.js';

const VENDOR_PAGE = 50;
// shortcut: offset paging, fine for thousands of outlets; switch to a cursor if rows shift under admins mid-scroll.
const MAX_OFFSET = 100_000;

export type VendorRow = {
  outlet: {
    id: string;
    branchName: string;
    slug: string;
    category: string;
    status: string;
    contactPhone: string | null;
    pausedUntil: string | null;
    submittedAt: string | null;
    createdAt: string;
  };
  brand: { id: string; name: string; slug: string };
  area: { city: string; name: string } | null;
  ownerPhone: string | null;
  tonight: { drops: number; quantity: number; reserved: number };
};

export type InventoryRow = {
  drop: {
    id: string;
    name: string;
    status: string;
    serviceDate: string;
    quantity: number;
    reservedCount: number;
    pricePaise: number;
    pickupStartAt: string;
    pickupEndAt: string;
    salesEndAt: string;
  };
  outlet: { id: string; branchName: string; status: string };
  brand: { id: string; name: string };
  area: { city: string; name: string } | null;
  orders: OrderCounts;
};

/** Bags paid and waiting, collected, marked no-show, and cancelled. Sold is every bag paid for and not cancelled. */
export type OrderCounts = { paid: number; collected: number; noShow: number; cancelled: number; soldPaise: number };

const filtersSchema = z.object({
  status: z.enum(['in_review', 'changes_needed', 'live', 'suspended', 'closed']).optional(),
  q: z.string().trim().max(100).optional(),
  areaId: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
});

/** An unknown or malformed filter is dropped, never a 400: these are search boxes. */
function filters(raw: Record<string, string | undefined>) {
  const out: z.infer<typeof filtersSchema> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === '') continue;
    const one = filtersSchema.shape[key as keyof typeof filtersSchema.shape]?.safeParse(value);
    if (one?.success) Object.assign(out, { [key]: one.data });
  }
  return out;
}

/** Escapes LIKE wildcards so a search for "50%" matches the text, not everything. */
const likeText = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * Outlets past draft, a page at a time, with brand, area, the brand owner's phone, and tonight's bag
 * counts. Search matches brand name, branch name or contact phone.
 */
export async function listVendors(
  raw: { status?: string; q?: string; areaId?: string; offset?: string },
  now: Date,
): Promise<{ vendors: VendorRow[]; hasMore: boolean }> {
  const f = filters(raw);
  const rows = await vendorRows(
    and(
      ne(outlets.status, 'draft'),
      f.status ? eq(outlets.status, f.status) : undefined,
      f.areaId ? eq(outlets.areaId, f.areaId) : undefined,
      f.q
        ? or(ilike(brands.name, likeText(f.q)), ilike(outlets.branchName, likeText(f.q)), ilike(outlets.contactPhone, likeText(f.q)))
        : undefined,
    ),
    now,
    { limit: VENDOR_PAGE + 1, offset: f.offset ?? 0 },
  );
  return { vendors: rows.slice(0, VENDOR_PAGE), hasMore: rows.length > VENDOR_PAGE };
}

async function vendorRows(where: SQL | undefined, now: Date, page = { limit: 1, offset: 0 }): Promise<VendorRow[]> {
  const rows = await db
    .select({ outlet: outlets, brand: { id: brands.id, name: brands.name, slug: brands.slug }, area: areas })
    .from(outlets)
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .leftJoin(areas, eq(areas.id, outlets.areaId))
    .where(where)
    .orderBy(asc(brands.name), asc(outlets.branchName), asc(outlets.id))
    .limit(page.limit)
    .offset(page.offset);
  if (rows.length === 0) return [];

  const outletIds = rows.map((r) => r.outlet.id);
  const brandIds = [...new Set(rows.map((r) => r.brand.id))];
  const [owners, counts] = await Promise.all([
    db
      .select({ brandId: memberships.brandId, phone: users.phone })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          inArray(memberships.brandId, brandIds),
          eq(memberships.role, 'owner'),
          isNull(memberships.outletId),
          isNull(memberships.removedAt),
        ),
      )
      .orderBy(asc(memberships.createdAt)),
    db
      .select({
        outletId: drops.outletId,
        drops: sql<number>`count(*)::int`,
        quantity: sql<number>`coalesce(sum(${drops.quantity}), 0)::int`,
        reserved: sql<number>`coalesce(sum(${drops.reservedCount}), 0)::int`,
      })
      .from(drops)
      .where(and(inArray(drops.outletId, outletIds), eq(drops.serviceDate, serviceDate(now)), ne(drops.status, 'cancelled')))
      .groupBy(drops.outletId),
  ]);

  const ownerByBrand = new Map<string, string>();
  for (const o of owners) if (!ownerByBrand.has(o.brandId)) ownerByBrand.set(o.brandId, o.phone);
  const countByOutlet = new Map(counts.map((c) => [c.outletId, c]));

  return rows.map(({ outlet: o, brand, area }) => {
    const c = countByOutlet.get(o.id);
    return {
      outlet: {
        id: o.id,
        branchName: o.branchName,
        slug: o.slug,
        category: o.category,
        status: o.status,
        contactPhone: o.contactPhone,
        pausedUntil: o.pausedUntil,
        submittedAt: o.submittedAt,
        createdAt: o.createdAt,
      },
      brand,
      area: area ? { city: area.city, name: area.name } : null,
      ownerPhone: ownerByBrand.get(brand.id) ?? null,
      tonight: { drops: c?.drops ?? 0, quantity: c?.quantity ?? 0, reserved: c?.reserved ?? 0 },
    };
  });
}

/**
 * Tonight's drops across every outlet, or one outlet, earliest pickup first. As the vendor's
 * today view has it, a drop whose window runs past midnight is still listed until it ends.
 */
export async function listInventory(
  raw: { outletId?: string; q?: string; areaId?: string },
  now: Date,
): Promise<{ serviceDate: string; drops: InventoryRow[] }> {
  const date = serviceDate(now);
  const outletId = z.uuid().safeParse(raw.outletId).success ? raw.outletId : undefined;
  if (raw.outletId && !outletId) return { serviceDate: date, drops: [] };
  const f = filters({ q: raw.q, areaId: raw.areaId });

  const rows = await db
    .select({
      drop: drops,
      outlet: { id: outlets.id, branchName: outlets.branchName, status: outlets.status },
      brand: { id: brands.id, name: brands.name },
      area: areas,
    })
    .from(drops)
    .innerJoin(outlets, eq(outlets.id, drops.outletId))
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .leftJoin(areas, eq(areas.id, outlets.areaId))
    .where(
      and(
        or(eq(drops.serviceDate, date), gt(drops.pickupEndAt, now.toISOString())),
        outletId ? eq(drops.outletId, outletId) : undefined,
        f.areaId ? eq(outlets.areaId, f.areaId) : undefined,
        f.q ? or(ilike(brands.name, likeText(f.q)), ilike(outlets.branchName, likeText(f.q)), ilike(drops.name, likeText(f.q))) : undefined,
      ),
    )
    .orderBy(asc(drops.pickupStartAt), asc(brands.name), asc(drops.id));

  const countByDrop = await orderCounts(rows.map((r) => r.drop.id));

  return {
    serviceDate: date,
    drops: rows.map(({ drop: d, outlet, brand, area }) => {
      return {
        drop: dropView(d),
        outlet,
        brand,
        area: area ? { city: area.city, name: area.name } : null,
        orders: countByDrop.get(d.id) ?? NO_ORDERS,
      };
    }),
  };
}

const NO_ORDERS: OrderCounts = { paid: 0, collected: 0, noShow: 0, cancelled: 0, soldPaise: 0 };

function dropView(d: typeof drops.$inferSelect): InventoryRow['drop'] {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    serviceDate: d.serviceDate,
    quantity: d.quantity,
    reservedCount: d.reservedCount,
    pricePaise: d.pricePaise,
    pickupStartAt: d.pickupStartAt,
    pickupEndAt: d.pickupEndAt,
    salesEndAt: d.salesEndAt,
  };
}

async function orderCounts(dropIds: string[]): Promise<Map<string, OrderCounts>> {
  if (dropIds.length === 0) return new Map();
  // Bags per drop from the order lines: one order can hold several kinds, and a line can be cancelled alone.
  const live = sql`${orderItems.status} = 'active'`;
  const counts = await db
    .select({
      dropId: orderItems.dropId,
      paid: sql<number>`coalesce(sum(${orderItems.quantity}) FILTER (WHERE ${live} AND ${orders.status} = 'paid'), 0)::int`,
      collected: sql<number>`coalesce(sum(${orderItems.quantity}) FILTER (WHERE ${live} AND ${orders.status} = 'collected'), 0)::int`,
      noShow: sql<number>`coalesce(sum(${orderItems.quantity}) FILTER (WHERE ${live} AND ${orders.status} = 'no_show'), 0)::int`,
      cancelled: sql<number>`coalesce(sum(${orderItems.quantity}) FILTER (WHERE NOT ${live} OR ${orders.status} = 'cancelled'), 0)::int`,
      soldPaise: sql<number>`coalesce(sum(${orderItems.quantity} * ${orderItems.unitPricePaise}) FILTER (WHERE ${live} AND ${orders.status} IN ('paid', 'collected', 'no_show')), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(inArray(orderItems.dropId, dropIds))
    .groupBy(orderItems.dropId);
  return new Map(counts.map(({ dropId, ...c }) => [dropId, c]));
}

// ---------- One vendor ----------

const notFound = () => new ApiError('not_found', 404, 'Outlet not found');

export type VendorDetail = VendorRow & {
  details: {
    address: string | null;
    pincode: string | null;
    mapsUrl: string | null;
    pickupInstructions: string | null;
    fssaiNumber: string | null;
    fssaiExpiresOn: string | null;
    gstin: string | null;
    commissionBps: number;
    pauseReason: string | null;
  };
  stats: Awaited<ReturnType<typeof getOutletStats>>;
  listings: (typeof listings.$inferSelect)[];
  tonightDrops: InventoryRow[];
};

/** One outlet past draft: its facts, 30-day stats, saved listings (archived ones last) and tonight's drops. */
export async function getVendor(outletId: string, now: Date): Promise<VendorDetail> {
  if (!z.uuid().safeParse(outletId).success) throw notFound();
  const [row] = await vendorRows(and(eq(outlets.id, outletId), ne(outlets.status, 'draft')), now);
  if (!row) throw notFound();
  const [[o], stats, saved, inventory] = await Promise.all([
    db.select().from(outlets).where(eq(outlets.id, outletId)),
    getOutletStats(outletId, now),
    db
      .select()
      .from(listings)
      .where(and(eq(listings.outletId, outletId), isNull(listings.deletedAt)))
      .orderBy(sql`${listings.archivedAt} IS NOT NULL`, asc(listings.createdAt)),
    listInventory({ outletId }, now),
  ]);
  return {
    ...row,
    details: {
      address: o!.address,
      pincode: o!.pincode,
      mapsUrl: o!.mapsUrl,
      pickupInstructions: o!.pickupInstructions,
      fssaiNumber: o!.fssaiNumber,
      fssaiExpiresOn: o!.fssaiExpiresOn,
      gstin: o!.gstin,
      commissionBps: o!.commissionBps,
      pauseReason: o!.pauseReason,
    },
    stats,
    listings: saved,
    tonightDrops: inventory.drops,
  };
}

export type HistoryRow = { drop: InventoryRow['drop']; orders: OrderCounts };

/** 7, 30 or 90 nights; anything else is 30. */
const historyDays = (raw: unknown) => ([7, 30, 90].includes(Number(raw)) ? Number(raw) : 30);

/** The outlet's drops on the given number of nights before tonight, newest first, with what happened to their orders. */
export async function getVendorHistory(
  outletId: string,
  now: Date,
  rawDays?: unknown,
): Promise<{ from: string; to: string; days: number; drops: HistoryRow[] }> {
  const days = historyDays(rawDays);
  if (!z.uuid().safeParse(outletId).success) throw notFound();
  const [o] = await db.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, outletId));
  if (!o) throw notFound();
  const to = serviceDate(now);
  const from = serviceDate(new Date(now.getTime() - days * 86_400_000));
  const rows = await db
    .select()
    .from(drops)
    .where(and(eq(drops.outletId, outletId), gte(drops.serviceDate, from), lt(drops.serviceDate, to)))
    .orderBy(desc(drops.serviceDate), asc(drops.pickupStartAt));
  const counts = await orderCounts(rows.map((d) => d.id));
  return { from, to, days, drops: rows.map((d) => ({ drop: dropView(d), orders: counts.get(d.id) ?? NO_ORDERS })) };
}
