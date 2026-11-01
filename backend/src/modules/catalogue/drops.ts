import { and, asc, eq, gt, or } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx } from '../../db/client.js';
import { drops, listings, outlets } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { pickupBounds, serviceDate } from '../../lib/time.js';
import { requireOutlet } from '../auth/access.js';
import { queueFollowerAlert } from '../notifications/events.js';
import { assertPrice, assertWindow, hhmm, MANAGERS, toHhmm } from './listings.js';

export type Drop = typeof drops.$inferSelect;
export type TodayView = {
  serviceDate: string;
  drops: Drop[];
  /** Cancelled drops are listed but not counted. */
  totals: { drops: number; quantity: number; reserved: number; remaining: number };
};

const IST_OFFSET_MS = 330 * 60_000;
/** The IST wall-clock HH:mm of an instant. */
const istHhmm = (iso: string) => new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);

const conflict = (code: string, message: string) => new ApiError(code, 409, message);
const windowEnded = () => conflict('window_ended', 'The pickup window for tonight has ended');
const cancelled = () => conflict('drop_cancelled', 'This drop was cancelled');
const belowReserved = (reserved: number) =>
  conflict('below_reserved', `Quantity cannot go below the ${reserved} already reserved`);

const quantitySchema = z.number().int().min(1).max(10_000);

// ---------- Publishing ----------

/**
 * Puts a listing on sale for tonight (the IST date of `now`) with the given quantity. The drop
 * takes a copy of the listing. Publishing again the same night changes the quantity only.
 * A null `actorId` is a job or a WhatsApp reply, which has no membership to check.
 */
export async function publishDrop(
  actorId: string | null,
  listingId: string,
  rawQuantity: number,
  now: Date,
): Promise<Drop> {
  const quantity = parseInput(quantitySchema, rawQuantity);
  const [found] = await db.select({ outletId: listings.outletId }).from(listings).where(eq(listings.id, listingId));
  if (!found) throw new ApiError('not_found', 404, 'Listing not found');
  if (actorId !== null) await requireOutlet(actorId, found.outletId, [...MANAGERS]);

  return withTx(async (tx) => {
    // Locking the listing serialises two publishes of the same listing.
    const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId)).for('update');
    if (!listing) throw new ApiError('not_found', 404, 'Listing not found');
    if (listing.archivedAt) throw conflict('listing_archived', 'This listing is archived');

    const [outlet] = await tx.select().from(outlets).where(eq(outlets.id, listing.outletId));
    if (!outlet) throw new ApiError('not_found', 404, 'Outlet not found');
    if (outlet.status !== 'live') throw conflict('outlet_not_live', 'This outlet is not live');
    const date = serviceDate(now);
    // A licence that expires today is still valid today. An outlet without a date has none on record to check.
    if (outlet.fssaiExpiresOn && outlet.fssaiExpiresOn < date) {
      throw conflict('fssai_expired', 'The FSSAI licence has expired');
    }

    const { startAt, endAt, salesEndAt } = pickupBounds(date, toHhmm(listing.pickupStart), toHhmm(listing.pickupEnd));
    if (now.getTime() >= endAt.getTime()) throw windowEnded();

    const [created] = await tx
      .insert(drops)
      .values({
        listingId,
        outletId: listing.outletId,
        serviceDate: date,
        quantity,
        name: listing.name,
        description: listing.description,
        type: listing.type,
        foodCategory: listing.foodCategory,
        diet: listing.diet,
        allergens: listing.allergens,
        valuePaise: listing.valuePaise,
        pricePaise: listing.pricePaise,
        photoKey: listing.photoKey,
        pickupStartAt: startAt.toISOString(),
        pickupEndAt: endAt.toISOString(),
        salesEndAt: salesEndAt.toISOString(),
      })
      .onConflictDoNothing({ target: [drops.listingId, drops.serviceDate] })
      .returning();
    if (created) {
      await audit(tx, {
        actorId,
        action: 'drop.publish',
        entity: 'drop',
        entityId: created.id,
        detail: { listingId, quantity, serviceDate: date },
      });
      await queueFollowerAlert(tx, created);
      return created;
    }

    // Already published tonight: only the quantity moves, the snapshot stays as it was.
    const [existing] = await tx
      .select()
      .from(drops)
      .where(and(eq(drops.listingId, listingId), eq(drops.serviceDate, date)))
      .for('update');
    if (!existing) throw conflict('conflict', 'Try again');
    if (existing.status === 'cancelled') throw cancelled();
    if (quantity < existing.reservedCount) throw belowReserved(existing.reservedCount);
    const [row] = await tx.update(drops).set({ quantity }).where(eq(drops.id, existing.id)).returning();
    await audit(tx, {
      actorId,
      action: 'drop.publish',
      entity: 'drop',
      entityId: existing.id,
      detail: { listingId, quantity, serviceDate: date, republish: true },
    });
    return row!;
  });
}

// ---------- Changing a drop ----------

const patchSchema = z.strictObject({
  quantity: z.number().int().min(0).max(10_000),
  status: z.enum(['live', 'paused']),
  pricePaise: z.number().int().min(1).max(10_000_000),
  pickupStart: hhmm,
  pickupEnd: hhmm,
}).partial();
export type DropPatch = Record<string, unknown>;

/**
 * Pause, resume, change quantity, or (before the first reservation) price and pickup times.
 * Cancelling a drop is a separate flow because it refunds customers.
 */
export async function updateDrop(userId: string, dropId: string, raw: DropPatch, now: Date): Promise<Drop> {
  const patch = parseInput(patchSchema, raw);
  const [found] = await db.select({ outletId: drops.outletId }).from(drops).where(eq(drops.id, dropId));
  if (!found) throw new ApiError('not_found', 404, 'Drop not found');
  await requireOutlet(userId, found.outletId, [...MANAGERS]);

  return withTx(async (tx) => {
    // The row lock keeps a concurrent reservation from slipping between the checks and the write.
    const [drop] = await tx.select().from(drops).where(eq(drops.id, dropId)).for('update');
    if (!drop) throw new ApiError('not_found', 404, 'Drop not found');
    if (drop.status === 'cancelled') throw cancelled();

    const set: Partial<typeof drops.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.quantity !== undefined) {
      if (patch.quantity < drop.reservedCount) throw belowReserved(drop.reservedCount);
      set.quantity = patch.quantity;
    }

    const touchesPrice = patch.pricePaise !== undefined;
    const touchesTime = patch.pickupStart !== undefined || patch.pickupEnd !== undefined;
    if ((touchesPrice || touchesTime) && drop.reservedCount > 0) {
      throw conflict('locked', 'Price and pickup time cannot change once a bag is reserved');
    }
    if (touchesPrice) {
      assertPrice(patch.pricePaise!, drop.valuePaise);
      set.pricePaise = patch.pricePaise;
    }
    if (touchesTime) {
      const start = patch.pickupStart ?? istHhmm(drop.pickupStartAt);
      const end = patch.pickupEnd ?? istHhmm(drop.pickupEndAt);
      assertWindow(start, end);
      const b = pickupBounds(drop.serviceDate, start, end);
      if (now.getTime() >= b.endAt.getTime()) throw windowEnded();
      set.pickupStartAt = b.startAt.toISOString();
      set.pickupEndAt = b.endAt.toISOString();
      set.salesEndAt = b.salesEndAt.toISOString();
    }

    const [row] =
      Object.keys(set).length > 0 ? await tx.update(drops).set(set).where(eq(drops.id, dropId)).returning() : [drop];
    await audit(tx, {
      actorId: userId,
      action: 'drop.update',
      entity: 'drop',
      entityId: dropId,
      detail: { fields: Object.keys(patch) },
    });
    return row!;
  });
}

// ---------- Today ----------

/**
 * Tonight's drops for an outlet, with totals. A drop whose window runs past midnight keeps
 * yesterday's service date, so drops still open at `now` are included too.
 */
export async function getToday(userId: string, outletId: string, now: Date): Promise<TodayView> {
  await requireOutlet(userId, outletId, [...MANAGERS, 'counter']);
  const date = serviceDate(now);
  const rows = await db
    .select()
    .from(drops)
    .where(
      and(eq(drops.outletId, outletId), or(eq(drops.serviceDate, date), gt(drops.pickupEndAt, now.toISOString()))),
    )
    .orderBy(asc(drops.pickupStartAt), asc(drops.id));

  const counted = rows.filter((d) => d.status !== 'cancelled');
  const quantity = counted.reduce((n, d) => n + d.quantity, 0);
  const reserved = counted.reduce((n, d) => n + d.reservedCount, 0);
  return {
    serviceDate: date,
    drops: rows,
    totals: { drops: counted.length, quantity, reserved, remaining: quantity - reserved },
  };
}
