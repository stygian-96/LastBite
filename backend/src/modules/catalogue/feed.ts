import { and, asc, eq, gt, ilike, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { areas, brands, drops, orders, outlets } from '../../db/schema.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { getStore } from '../../integrations/storage.js';
import { INT4_MAX } from '../../lib/money.js';
import { hhmm } from './listings.js';

export type CityView = { slug: string; name: string; areas: { id: string; name: string }[] };

/** What a customer sees on a feed card. Money is integer paise and times are ISO strings. */
export type DropCard = {
  id: string;
  name: string;
  type: string;
  diet: string;
  pricePaise: number;
  valuePaise: number;
  remaining: number;
  pickupStartAt: string;
  pickupEndAt: string;
  salesEndAt: string;
  outletId: string;
  brandName: string;
  brandSlug: string;
  branchName: string;
  outletSlug: string;
  city: string | null;
  area: string | null;
  /** Null when the listing has no photo, so the frontend shows its illustration. */
  photoUrl: string | null;
  foodCategory: string;
};

export type DropDetail = DropCard & {
  description: string;
  allergens: string[];
  pickupInstructions: string | null;
  address: string | null;
  mapsUrl: string | null;
  fssaiNumber: string | null;
  /** Average of the outlet's ratings, null until it has 5. */
  rating: number | null;
};

export type OutletPage = {
  outletId: string;
  brandName: string;
  brandSlug: string;
  branchName: string;
  outletSlug: string;
  city: string | null;
  area: string | null;
  category: string;
  address: string | null;
  mapsUrl: string | null;
  pickupInstructions: string | null;
  openingHours: unknown;
  fssaiNumber: string | null;
  photoUrls: string[];
  rating: number | null;
  drops: DropCard[];
};

export type DropFilters = {
  city: string;
  area?: string;
  category?: string;
  veg?: boolean;
  /** IST HH:mm. Keeps drops whose pickup starts at or before this time. */
  pickupBy?: string;
  maxPricePaise?: number;
  q?: string;
};

const MIN_RATINGS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const filtersSchema = z.strictObject({
  city: z.string().min(1),
  area: z.string().min(1).optional(),
  category: z.enum(['bakery', 'cafe', 'meals', 'desserts']).optional(),
  veg: z.boolean().optional(),
  pickupBy: hhmm.optional(),
  maxPricePaise: z.number().int().min(0).max(INT4_MAX).optional(),
  q: z.string().refine((v) => !v.includes('\0')).optional(),
});

const iso = (t: string) => new Date(t).toISOString();
const photo = (key: string | null) => (key ? getStore().publicUrl(key) : null);
const notFound = (what: string) => new ApiError('not_found', 404, `${what} not found`);
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Outlet is live and not inside a pause window. */
const outletVisible = (now: Date) =>
  and(eq(outlets.status, 'live'), or(isNull(outlets.pausedUntil), lte(outlets.pausedUntil, now.toISOString())));

const cardColumns = {
  id: drops.id,
  name: drops.name,
  type: drops.type,
  diet: drops.diet,
  pricePaise: drops.pricePaise,
  valuePaise: drops.valuePaise,
  quantity: drops.quantity,
  reservedCount: drops.reservedCount,
  pickupStartAt: drops.pickupStartAt,
  pickupEndAt: drops.pickupEndAt,
  salesEndAt: drops.salesEndAt,
  outletId: outlets.id,
  brandName: brands.name,
  brandSlug: brands.slug,
  branchName: outlets.branchName,
  outletSlug: outlets.slug,
  city: areas.city,
  area: areas.name,
  photoKey: drops.photoKey,
  foodCategory: drops.foodCategory,
};

type CardRow = {
  id: string;
  name: string;
  type: string;
  diet: string;
  pricePaise: number;
  valuePaise: number;
  quantity: number;
  reservedCount: number;
  pickupStartAt: string;
  pickupEndAt: string;
  salesEndAt: string;
  outletId: string;
  brandName: string;
  brandSlug: string;
  branchName: string;
  outletSlug: string;
  city: string | null;
  area: string | null;
  photoKey: string | null;
  foodCategory: string;
};

function toCard(r: CardRow): DropCard {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    diet: r.diet,
    pricePaise: r.pricePaise,
    valuePaise: r.valuePaise,
    remaining: Math.max(0, r.quantity - r.reservedCount),
    pickupStartAt: iso(r.pickupStartAt),
    pickupEndAt: iso(r.pickupEndAt),
    salesEndAt: iso(r.salesEndAt),
    outletId: r.outletId,
    brandName: r.brandName,
    brandSlug: r.brandSlug,
    branchName: r.branchName,
    outletSlug: r.outletSlug,
    city: r.city,
    area: r.area,
    photoUrl: photo(r.photoKey),
    foodCategory: r.foodCategory,
  };
}

/** Selling soonest to end first, sold out last. */
const feedOrder = [
  asc(sql`(${drops.quantity} - ${drops.reservedCount} <= 0)`),
  asc(drops.salesEndAt),
  asc(drops.id),
];

async function outletRating(outletId: string): Promise<number | null> {
  const [r] = await db
    .select({ n: sql<number>`count(${orders.rating})::int`, avg: sql<string | null>`avg(${orders.rating})` })
    .from(orders)
    .where(and(eq(orders.outletId, outletId), isNotNull(orders.rating)));
  if (!r || r.n < MIN_RATINGS || r.avg === null) return null;
  return Math.round(Number(r.avg) * 10) / 10;
}

// ---------- Cities ----------

export async function listCities(): Promise<CityView[]> {
  const rows = await db.select().from(areas).orderBy(asc(areas.city), asc(areas.name));
  const byCity = new Map<string, CityView>();
  for (const a of rows) {
    const city = byCity.get(a.city) ?? { slug: a.city, name: titleCase(a.city), areas: [] };
    city.areas.push({ id: a.id, name: a.name });
    byCity.set(a.city, city);
  }
  return [...byCity.values()];
}

// ---------- Feed ----------

/**
 * Tonight's drops in a city. A drop shows while it is live, its outlet is live and not paused,
 * and sales have not ended. Sold out drops stay listed, after the others.
 */
export async function listDrops(raw: DropFilters, now: Date): Promise<DropCard[]> {
  const f = parseInput(filtersSchema, raw);
  const [known] = await db.select({ id: areas.id }).from(areas).where(eq(areas.city, f.city)).limit(1);
  if (!known) throw new ApiError('invalid_request', 400, 'Invalid value for city');

  const where: (SQL | undefined)[] = [
    eq(areas.city, f.city),
    eq(drops.status, 'live'),
    gt(drops.salesEndAt, now.toISOString()),
    outletVisible(now),
  ];
  if (f.area) where.push(sql`lower(${areas.name}) = lower(${f.area})`);
  if (f.category) where.push(eq(drops.foodCategory, f.category));
  if (f.veg) where.push(eq(drops.diet, 'veg'));
  if (f.maxPricePaise !== undefined) where.push(lte(drops.pricePaise, f.maxPricePaise));
  if (f.pickupBy) {
    where.push(sql`${drops.pickupStartAt} <= (${drops.serviceDate} + ${f.pickupBy}::time) AT TIME ZONE 'Asia/Kolkata'`);
  }
  const q = f.q?.trim();
  if (q) {
    // % and _ in the search are literal characters, not wildcards.
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(or(ilike(drops.name, pattern), ilike(brands.name, pattern), ilike(outlets.branchName, pattern)));
  }

  const rows = await db
    .select(cardColumns)
    .from(drops)
    .innerJoin(outlets, eq(outlets.id, drops.outletId))
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .innerJoin(areas, eq(areas.id, outlets.areaId))
    .where(and(...where))
    .orderBy(...feedOrder);
  return rows.map(toCard);
}

// ---------- Drop detail ----------

/**
 * One drop. A sold out drop is returned with `remaining` 0. A hidden (paused or cancelled) drop,
 * a drop past its pickup end, or one from an outlet that is not live is a 404.
 */
export async function getDrop(id: string, now: Date): Promise<DropDetail> {
  if (!UUID.test(id)) throw notFound('Drop');
  const [row] = await db
    .select({
      ...cardColumns,
      description: drops.description,
      allergens: drops.allergens,
      pickupInstructions: outlets.pickupInstructions,
      address: outlets.address,
      mapsUrl: outlets.mapsUrl,
      fssaiNumber: outlets.fssaiNumber,
    })
    .from(drops)
    .innerJoin(outlets, eq(outlets.id, drops.outletId))
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .leftJoin(areas, eq(areas.id, outlets.areaId))
    .where(
      and(eq(drops.id, id), eq(drops.status, 'live'), gt(drops.pickupEndAt, now.toISOString()), outletVisible(now)),
    );
  if (!row) throw notFound('Drop');

  return {
    ...toCard(row),
    description: row.description,
    allergens: row.allergens.filter((a) => a !== ''),
    pickupInstructions: row.pickupInstructions,
    address: row.address,
    mapsUrl: row.mapsUrl,
    fssaiNumber: row.fssaiNumber,
    rating: await outletRating(row.outletId),
  };
}

// ---------- Outlet page ----------

export async function getOutletPage(brandSlug: string, outletSlug: string, now: Date): Promise<OutletPage> {
  const [o] = await db
    .select({
      id: outlets.id,
      brandName: brands.name,
      brandSlug: brands.slug,
      branchName: outlets.branchName,
      outletSlug: outlets.slug,
      city: areas.city,
      area: areas.name,
      category: outlets.category,
      address: outlets.address,
      mapsUrl: outlets.mapsUrl,
      pickupInstructions: outlets.pickupInstructions,
      openingHours: outlets.openingHours,
      fssaiNumber: outlets.fssaiNumber,
      photoKeys: outlets.photoKeys,
      pausedUntil: outlets.pausedUntil,
    })
    .from(outlets)
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .leftJoin(areas, eq(areas.id, outlets.areaId))
    .where(and(eq(brands.slug, brandSlug), eq(outlets.slug, outletSlug), eq(outlets.status, 'live')));
  if (!o) throw notFound('Outlet');

  // A paused outlet keeps its page but lists nothing until the pause ends.
  const isPaused = o.pausedUntil !== null && new Date(o.pausedUntil).getTime() > now.getTime();
  const rows = isPaused
    ? []
    : await db
        .select(cardColumns)
        .from(drops)
        .innerJoin(outlets, eq(outlets.id, drops.outletId))
        .innerJoin(brands, eq(brands.id, outlets.brandId))
        .leftJoin(areas, eq(areas.id, outlets.areaId))
        .where(and(eq(drops.outletId, o.id), eq(drops.status, 'live'), gt(drops.salesEndAt, now.toISOString())))
        .orderBy(...feedOrder);

  return {
    outletId: o.id,
    brandName: o.brandName,
    brandSlug: o.brandSlug,
    branchName: o.branchName,
    outletSlug: o.outletSlug,
    city: o.city,
    area: o.area,
    category: o.category,
    address: o.address,
    mapsUrl: o.mapsUrl,
    pickupInstructions: o.pickupInstructions,
    openingHours: o.openingHours,
    fssaiNumber: o.fssaiNumber,
    photoUrls: o.photoKeys.filter((k) => k !== '').map((k) => getStore().publicUrl(k)),
    rating: await outletRating(o.id),
    drops: rows.map(toCard),
  };
}
