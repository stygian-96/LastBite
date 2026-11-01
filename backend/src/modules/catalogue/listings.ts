import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { listings, outlets } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { requireOutlet } from '../auth/access.js';

export type Listing = typeof listings.$inferSelect;

/** Who may manage listings and drops. Counters only read the Today view. */
export const MANAGERS = ['owner', 'manager'] as const;

// ---------- Formats ----------

/** HH:mm, 24 hour. `pickupBounds` does not check its input, so everything is checked here first. */
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** The database returns time columns as HH:mm:ss. */
export const toHhmm = (t: string): string => t.slice(0, 5);

/** An empty window (same start and end) is rejected. An end before the start runs to the next day. */
export function assertWindow(start: string, end: string): void {
  if (start === end) throw new ApiError('invalid_request', 400, 'Pickup start and end must differ');
}

export function assertPrice(pricePaise: number, valuePaise: number): void {
  if (pricePaise > valuePaise) {
    throw new ApiError('price_above_value', 400, 'The price cannot be higher than the value');
  }
}

const fields = {
  type: z.enum(['surprise_bag', 'fixed_box']),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  foodCategory: z.enum(['bakery', 'cafe', 'meals', 'desserts']),
  diet: z.enum(['veg', 'egg', 'nonveg', 'mixed']),
  allergens: z.array(z.string().trim().min(1).max(40)).max(20),
  valuePaise: z.number().int().min(1).max(10_000_000),
  pricePaise: z.number().int().min(1).max(10_000_000),
  defaultQuantity: z.number().int().min(1).max(1000),
  pickupStart: hhmm,
  pickupEnd: hhmm,
  // 1 = Monday ... 7 = Sunday
  repeatDays: z.array(z.number().int().min(1).max(7)).max(7),
  photoKey: z.string().min(1).max(300).nullable(),
};

const createSchema = z.strictObject({
  ...fields,
  allergens: fields.allergens.default([]),
  repeatDays: fields.repeatDays.default([]),
  photoKey: fields.photoKey.optional(),
});
const patchSchema = z.strictObject(fields).partial();

/** Callers pass untrusted JSON; the schemas above check it. */
export type ListingInput = Record<string, unknown>;
export type ListingPatch = Record<string, unknown>;

const badKey = () => new ApiError('invalid_request', 400, 'Upload the file first, then record it');
const uniqueDays = (days: number[]) => [...new Set(days)].sort((a, b) => a - b);

// ---------- Reading ----------

async function loadListing(listingId: string, executor: Pick<Tx, 'select'> = db): Promise<Listing> {
  const [l] = await executor.select().from(listings).where(eq(listings.id, listingId));
  if (!l) throw new ApiError('not_found', 404, 'Listing not found');
  return l;
}

/** Loads a listing and checks that the user may manage it. */
export async function loadManagedListing(userId: string, listingId: string): Promise<Listing> {
  const l = await loadListing(listingId);
  await requireOutlet(userId, l.outletId, [...MANAGERS]);
  return l;
}

export async function listListings(userId: string, outletId: string): Promise<Listing[]> {
  await requireOutlet(userId, outletId, [...MANAGERS]);
  return db
    .select()
    .from(listings)
    .where(eq(listings.outletId, outletId))
    .orderBy(asc(listings.createdAt), asc(listings.id));
}

// ---------- Writing ----------

export async function createListing(userId: string, outletId: string, raw: ListingInput): Promise<Listing> {
  await requireOutlet(userId, outletId, [...MANAGERS]);
  const input = parseInput(createSchema, raw);
  assertPrice(input.pricePaise, input.valuePaise);
  assertWindow(input.pickupStart, input.pickupEnd);
  if (input.photoKey && !input.photoKey.startsWith(`photos/${userId}/`)) throw badKey();

  return withTx(async (tx) => {
    const [row] = await tx
      .insert(listings)
      .values({ ...input, photoKey: input.photoKey ?? null, repeatDays: uniqueDays(input.repeatDays), outletId })
      .returning();
    await audit(tx, {
      actorId: userId,
      action: 'listing.create',
      entity: 'listing',
      entityId: row!.id,
      detail: { outletId },
    });
    return row!;
  });
}

export async function updateListing(userId: string, listingId: string, raw: ListingPatch): Promise<Listing> {
  const current = await loadManagedListing(userId, listingId);
  const patch = parseInput(patchSchema, raw);
  if (patch.photoKey && patch.photoKey !== current.photoKey && !patch.photoKey.startsWith(`photos/${userId}/`)) {
    throw badKey();
  }
  assertPrice(patch.pricePaise ?? current.pricePaise, patch.valuePaise ?? current.valuePaise);
  assertWindow(patch.pickupStart ?? toHhmm(current.pickupStart), patch.pickupEnd ?? toHhmm(current.pickupEnd));

  return withTx(async (tx) => {
    const [locked] = await tx.select().from(listings).where(eq(listings.id, listingId)).for('update');
    if (!locked) throw new ApiError('not_found', 404, 'Listing not found');
    if (locked.archivedAt) throw new ApiError('archived', 409, 'This listing is archived');
    // Re-check against the locked row in case it changed since the read above.
    assertPrice(patch.pricePaise ?? locked.pricePaise, patch.valuePaise ?? locked.valuePaise);
    assertWindow(patch.pickupStart ?? toHhmm(locked.pickupStart), patch.pickupEnd ?? toHhmm(locked.pickupEnd));

    const set = { ...patch, ...(patch.repeatDays ? { repeatDays: uniqueDays(patch.repeatDays) } : {}) };
    const [row] =
      Object.keys(set).length > 0
        ? await tx.update(listings).set(set).where(eq(listings.id, listingId)).returning()
        : [locked];
    await audit(tx, {
      actorId: userId,
      action: 'listing.update',
      entity: 'listing',
      entityId: listingId,
      detail: { fields: Object.keys(patch) },
    });
    return row!;
  });
}

/** Archiving hides the listing from new drops. Drops already published keep selling. */
export async function archiveListing(userId: string, listingId: string, now: Date = new Date()): Promise<Listing> {
  await loadManagedListing(userId, listingId);
  return withTx(async (tx) => {
    const [locked] = await tx.select().from(listings).where(eq(listings.id, listingId)).for('update');
    if (!locked) throw new ApiError('not_found', 404, 'Listing not found');
    if (locked.archivedAt) return locked;
    const [row] = await tx
      .update(listings)
      .set({ archivedAt: now.toISOString() })
      .where(eq(listings.id, listingId))
      .returning();
    await audit(tx, { actorId: userId, action: 'listing.archive', entity: 'listing', entityId: listingId });
    return row!;
  });
}

/** Copies a listing to another outlet of the same brand. The copy is an independent row. */
export async function copyListing(userId: string, listingId: string, targetOutletId: string): Promise<Listing> {
  const source = await loadManagedListing(userId, listingId);
  const forbidden = () => new ApiError('forbidden', 403, 'Not allowed');
  const [from] = await db.select({ brandId: outlets.brandId }).from(outlets).where(eq(outlets.id, source.outletId));
  const [to] = await db.select({ brandId: outlets.brandId }).from(outlets).where(eq(outlets.id, targetOutletId));
  if (!from || !to || from.brandId !== to.brandId) throw forbidden();
  await requireOutlet(userId, targetOutletId, [...MANAGERS]);

  return withTx(async (tx) => {
    const [row] = await tx
      .insert(listings)
      .values({
        outletId: targetOutletId,
        type: source.type,
        name: source.name,
        description: source.description,
        foodCategory: source.foodCategory,
        diet: source.diet,
        allergens: source.allergens,
        valuePaise: source.valuePaise,
        pricePaise: source.pricePaise,
        defaultQuantity: source.defaultQuantity,
        pickupStart: source.pickupStart,
        pickupEnd: source.pickupEnd,
        repeatDays: source.repeatDays,
        photoKey: source.photoKey,
      })
      .returning();
    await audit(tx, {
      actorId: userId,
      action: 'listing.copy',
      entity: 'listing',
      entityId: row!.id,
      detail: { from: listingId, targetOutletId },
    });
    return row!;
  });
}
