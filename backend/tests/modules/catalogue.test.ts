import { beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { auditLog, drops, listings, memberships } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { createSession } from '../../src/modules/auth/session.js';
import { archiveListing, copyListing, createListing, updateListing } from '../../src/modules/catalogue/listings.js';
import { getToday, publishDrop, updateDrop } from '../../src/modules/catalogue/drops.js';
import { getOutletStatus } from '../../src/modules/onboarding/outlets.js';
import { app } from '../../src/app.js';
import { makeBrand, makeDrop, makeListing, makeLiveOutlet, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-01. The default listing sells 19:00-21:00 IST.
const T0 = new Date('2026-11-01T10:00:00Z');
const DATE = '2026-11-01';

beforeEach(resetDb);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

const LISTING = {
  type: 'surprise_bag',
  name: 'Bakery Surprise Bag',
  description: 'Whatever is left at close',
  foodCategory: 'bakery',
  diet: 'veg',
  allergens: ['gluten'],
  valuePaise: 30000,
  pricePaise: 14900,
  defaultQuantity: 6,
  pickupStart: '19:00',
  pickupEnd: '21:00',
  repeatDays: [1, 2, 3],
};

/** A live outlet with a brand-wide owner. */
async function setup(outletOverrides: Parameters<typeof makeLiveOutlet>[0] = {}) {
  const owner = await makeUser();
  const brand = await makeBrand({ createdBy: owner.id });
  await db.insert(memberships).values({ userId: owner.id, brandId: brand.id, outletId: null, role: 'owner' });
  const outlet = await makeLiveOutlet({ brandId: brand.id, ...outletOverrides });
  return { owner, brand, outlet };
}

async function staff(brandId: string, outletId: string, role: 'manager' | 'counter') {
  const u = await makeUser();
  await db.insert(memberships).values({ userId: u.id, brandId, outletId, role });
  return u;
}

describe('listings', () => {
  test('price above value is rejected', async () => {
    const { owner, outlet } = await setup();
    expect(await failure(createListing(owner.id, outlet.id, { ...LISTING, pricePaise: 30001 }))).toMatchObject({ status: 400 });
    const l = await createListing(owner.id, outlet.id, LISTING);
    expect(await failure(updateListing(owner.id, l.id, { pricePaise: 40000 }))).toMatchObject({ status: 400 });
    expect(await failure(updateListing(owner.id, l.id, { valuePaise: 10000 }))).toMatchObject({ status: 400 });
  });

  test('pickup times must be HH:mm and the window non-empty', async () => {
    const { owner, outlet } = await setup();
    for (const bad of ['7pm', '19:00:00', '24:00', '19:60']) {
      expect(await failure(createListing(owner.id, outlet.id, { ...LISTING, pickupStart: bad }))).toMatchObject({ status: 400 });
    }
    const same = await failure(createListing(owner.id, outlet.id, { ...LISTING, pickupStart: '19:00', pickupEnd: '19:00' }));
    expect(same).toMatchObject({ status: 400 });
    // End earlier than start means the next day, which is fine.
    const overnight = await createListing(owner.id, outlet.id, { ...LISTING, pickupStart: '22:00', pickupEnd: '01:00' });
    expect(overnight.pickupEnd).toMatch(/^01:00/);
  });

  test('create, update and archive write the listing and an audit row', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    expect(l).toMatchObject({ outletId: outlet.id, name: 'Bakery Surprise Bag', pricePaise: 14900, archivedAt: null });
    const u = await updateListing(owner.id, l.id, { name: 'Renamed', pricePaise: 12000 });
    expect(u).toMatchObject({ name: 'Renamed', pricePaise: 12000, valuePaise: 30000 });
    const a = await archiveListing(owner.id, l.id, T0);
    expect(a.archivedAt).not.toBeNull();
    expect(await failure(updateListing(owner.id, l.id, { name: 'x' }))).toMatchObject({ status: 409 });
    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['listing.create', 'listing.update', 'listing.archive']));
  });

  test('counter role cannot edit listings', async () => {
    const { brand, outlet } = await setup();
    const counter = await staff(brand.id, outlet.id, 'counter');
    const manager = await staff(brand.id, outlet.id, 'manager');
    const l = await makeListing({ outletId: outlet.id });
    expect(await failure(createListing(counter.id, outlet.id, LISTING))).toMatchObject({ status: 403 });
    expect(await failure(updateListing(counter.id, l.id, { name: 'x' }))).toMatchObject({ status: 403 });
    expect(await failure(archiveListing(counter.id, l.id, T0))).toMatchObject({ status: 403 });
    expect(await failure(publishDrop(counter.id, l.id, 3, T0))).toMatchObject({ status: 403 });
    // A manager may.
    expect((await createListing(manager.id, outlet.id, LISTING)).outletId).toBe(outlet.id);
  });

  test('copy creates an independent listing on the target outlet', async () => {
    const { owner, brand, outlet } = await setup();
    const target = await makeLiveOutlet({ brandId: brand.id, payoutAccountId: outlet.payoutAccountId });
    const src = await createListing(owner.id, outlet.id, LISTING);
    const copy = await copyListing(owner.id, src.id, target.id);
    expect(copy.id).not.toBe(src.id);
    expect(copy).toMatchObject({ outletId: target.id, name: src.name, pricePaise: src.pricePaise, archivedAt: null });
    await updateListing(owner.id, copy.id, { name: 'Changed on target' });
    const [orig] = await db.select().from(listings).where(eq(listings.id, src.id));
    expect(orig!.name).toBe('Bakery Surprise Bag');
  });

  test('copy to another brand returns 403', async () => {
    const { owner, outlet } = await setup();
    // The same person owns a second brand, so only the brand check can stop this.
    const other = await makeBrand({ createdBy: owner.id });
    await db.insert(memberships).values({ userId: owner.id, brandId: other.id, outletId: null, role: 'owner' });
    const foreign = await makeLiveOutlet({ brandId: other.id });
    const src = await createListing(owner.id, outlet.id, LISTING);
    expect(await failure(copyListing(owner.id, src.id, foreign.id))).toMatchObject({ status: 403 });
    // Also refused when the caller has no access to the target at all.
    const stranger = await makeLiveOutlet();
    expect(await failure(copyListing(owner.id, src.id, stranger.id))).toMatchObject({ status: 403 });
  });

  test('submit requires a listing', async () => {
    const { owner, outlet } = await setup({ status: 'draft' });
    const codes = async () => (await getOutletStatus(owner.id, outlet.id)).fixes.map((f) => f.code);
    expect(await codes()).toContain('listing_missing');
    const l = await createListing(owner.id, outlet.id, LISTING);
    expect(await codes()).not.toContain('listing_missing');
    // An archived listing does not count.
    await archiveListing(owner.id, l.id, T0);
    expect(await codes()).toContain('listing_missing');
  });
});

describe('publishing a drop', () => {
  test('publish copies listing fields into the drop', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(owner.id, l.id, 4, T0);
    expect(d).toMatchObject({
      listingId: l.id,
      outletId: outlet.id,
      serviceDate: DATE,
      quantity: 4,
      reservedCount: 0,
      status: 'live',
      name: l.name,
      description: l.description,
      type: l.type,
      foodCategory: l.foodCategory,
      diet: l.diet,
      allergens: ['gluten'],
      valuePaise: 30000,
      pricePaise: 14900,
    });
    expect(new Date(d.pickupStartAt).toISOString()).toBe('2026-11-01T13:30:00.000Z');
    expect(new Date(d.pickupEndAt).toISOString()).toBe('2026-11-01T15:30:00.000Z');
    // Sales end 15 minutes before pickup end.
    expect(new Date(d.salesEndAt).toISOString()).toBe('2026-11-01T15:15:00.000Z');
  });

  test('editing a listing leaves a published drop unchanged', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(owner.id, l.id, 4, T0);
    await updateListing(owner.id, l.id, { name: 'New name', pricePaise: 9900, pickupStart: '18:00' });
    const [after] = await db.select().from(drops).where(eq(drops.id, d.id));
    expect(after).toMatchObject({ name: 'Bakery Surprise Bag', pricePaise: 14900 });
    expect(after!.pickupStartAt).toBe(d.pickupStartAt);
  });

  test('window past midnight keeps service_date as the start date', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, { ...LISTING, pickupStart: '22:00', pickupEnd: '01:00' });
    const d = await publishDrop(owner.id, l.id, 3, T0);
    expect(d.serviceDate).toBe(DATE);
    expect(new Date(d.pickupStartAt).toISOString()).toBe('2026-11-01T16:30:00.000Z');
    expect(new Date(d.pickupEndAt).toISOString()).toBe('2026-11-01T19:30:00.000Z');
  });

  test('publish after the window has ended returns 409', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    // 21:00 IST exactly is the end.
    const e = await failure(publishDrop(owner.id, l.id, 3, new Date('2026-11-01T15:30:00Z')));
    expect(e).toMatchObject({ status: 409 });
    expect(await db.select().from(drops)).toHaveLength(0);
  });

  test('a window that started and has not ended can still be published', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(owner.id, l.id, 3, new Date('2026-11-01T14:00:00Z')); // 19:30 IST
    expect(d.serviceDate).toBe(DATE);
  });

  test('service date is the IST date, not the UTC date', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    // 00:30 IST on 11-02 is still 11-01 in UTC.
    const d = await publishDrop(owner.id, l.id, 3, new Date('2026-11-01T19:00:00Z'));
    expect(d.serviceDate).toBe('2026-11-02');
  });

  test('publish twice for one night updates quantity', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const first = await publishDrop(owner.id, l.id, 4, T0);
    await updateListing(owner.id, l.id, { name: 'Edited between publishes', pricePaise: 9900 });
    const second = await publishDrop(owner.id, l.id, 7, new Date('2026-11-01T11:00:00Z'));
    expect(second.id).toBe(first.id);
    expect(second.quantity).toBe(7);
    expect(second).toMatchObject({ name: 'Bakery Surprise Bag', pricePaise: 14900 });
    expect(await db.select().from(drops)).toHaveLength(1);
  });

  test('republish does not change a paused drop back to live', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(owner.id, l.id, 4, T0);
    await updateDrop(owner.id, d.id, { status: 'paused' }, T0);
    expect((await publishDrop(owner.id, l.id, 5, T0)).status).toBe('paused');
  });

  test('quantity below reserved_count returns 409', async () => {
    const { owner, outlet } = await setup();
    const l = await makeListing({ outletId: outlet.id });
    const d = await makeDrop({
      listingId: l.id,
      outletId: outlet.id,
      serviceDate: DATE,
      quantity: 5,
      reservedCount: 3,
      pickupStartAt: '2026-11-01T19:00:00+05:30',
      pickupEndAt: '2026-11-01T21:00:00+05:30',
      salesEndAt: '2026-11-01T20:45:00+05:30',
    });
    expect(await failure(updateDrop(owner.id, d.id, { quantity: 2 }, T0))).toMatchObject({ status: 409 });
    expect(await failure(publishDrop(owner.id, l.id, 2, T0))).toMatchObject({ status: 409 });
    expect((await updateDrop(owner.id, d.id, { quantity: 3 }, T0)).quantity).toBe(3);
    expect((await publishDrop(owner.id, l.id, 8, T0)).quantity).toBe(8);
  });

  test('price and time lock after the first reservation', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(owner.id, l.id, 5, T0);
    // Before any reservation both can change.
    const moved = await updateDrop(owner.id, d.id, { pricePaise: 12000, pickupStart: '19:30', pickupEnd: '21:30' }, T0);
    expect(moved.pricePaise).toBe(12000);
    expect(new Date(moved.pickupStartAt).toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(new Date(moved.salesEndAt).toISOString()).toBe('2026-11-01T15:45:00.000Z');

    await db.update(drops).set({ reservedCount: 1 }).where(eq(drops.id, d.id));
    expect(await failure(updateDrop(owner.id, d.id, { pricePaise: 11000 }, T0))).toMatchObject({ status: 409 });
    expect(await failure(updateDrop(owner.id, d.id, { pickupEnd: '22:00' }, T0))).toMatchObject({ status: 409 });
    // Quantity and status still move.
    expect((await updateDrop(owner.id, d.id, { quantity: 9 }, T0)).quantity).toBe(9);
    expect((await updateDrop(owner.id, d.id, { status: 'paused' }, T0)).status).toBe('paused');
    const [row] = await db.select().from(drops).where(eq(drops.id, d.id));
    expect(row!.pricePaise).toBe(12000);
  });

  test('drop price must stay within value and the window must be non-empty', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(owner.id, l.id, 5, T0);
    expect(await failure(updateDrop(owner.id, d.id, { pricePaise: 30001 }, T0))).toMatchObject({ status: 400 });
    expect(await failure(updateDrop(owner.id, d.id, { pickupStart: '20:00', pickupEnd: '20:00' }, T0))).toMatchObject({ status: 400 });
    expect(await failure(updateDrop(owner.id, d.id, { pickupStart: '8pm' }, T0))).toMatchObject({ status: 400 });
    expect(await failure(updateDrop(owner.id, d.id, { quantity: -1 }, T0))).toMatchObject({ status: 400 });
    expect(await failure(updateDrop(owner.id, d.id, { status: 'cancelled' as 'live' }, T0))).toMatchObject({ status: 400 });
  });

  test('a paused drop can be resumed, and a cancelled one cannot be changed', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(owner.id, l.id, 5, T0);
    expect((await updateDrop(owner.id, d.id, { status: 'paused' }, T0)).status).toBe('paused');
    expect((await updateDrop(owner.id, d.id, { status: 'live' }, T0)).status).toBe('live');
    await db.update(drops).set({ status: 'cancelled' }).where(eq(drops.id, d.id));
    expect(await failure(updateDrop(owner.id, d.id, { status: 'live' }, T0))).toMatchObject({ status: 409 });
    expect(await failure(publishDrop(owner.id, l.id, 6, T0))).toMatchObject({ status: 409 });
  });

  test('outlet with expired FSSAI cannot publish', async () => {
    const yesterday = await setup({ fssaiExpiresOn: '2026-10-31' });
    const l1 = await createListing(yesterday.owner.id, yesterday.outlet.id, LISTING);
    expect(await failure(publishDrop(yesterday.owner.id, l1.id, 3, T0))).toMatchObject({ status: 409 });

    // Expiring today still publishes. The IST date is compared, so 00:30 IST on 11-02 is already too late.
    const today = await setup({ fssaiExpiresOn: DATE });
    const l2 = await createListing(today.owner.id, today.outlet.id, LISTING);
    expect((await publishDrop(today.owner.id, l2.id, 3, T0)).serviceDate).toBe(DATE);
    const late = new Date('2026-11-01T19:00:00Z');
    expect(await failure(publishDrop(today.owner.id, l2.id, 3, late))).toMatchObject({ status: 409 });
  });

  test('outlet that is not live cannot publish', async () => {
    for (const status of ['draft', 'in_review', 'changes_needed', 'suspended', 'closed']) {
      const { owner, outlet } = await setup({ status });
      const l = await createListing(owner.id, outlet.id, LISTING);
      expect(await failure(publishDrop(owner.id, l.id, 3, T0))).toMatchObject({ status: 409 });
    }
  });

  test('an archived listing cannot be published', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    await archiveListing(owner.id, l.id, T0);
    expect(await failure(publishDrop(owner.id, l.id, 3, T0))).toMatchObject({ status: 409 });
  });

  test('a null actor publishes without a membership check, but the outlet rules still apply', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const d = await publishDrop(null, l.id, 4, T0);
    expect(d.quantity).toBe(4);
    const [log] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'drop.publish'), eq(auditLog.entityId, d.id)));
    expect(log!.actorId).toBeNull();

    const draft = await setup({ status: 'draft' });
    const l2 = await createListing(draft.owner.id, draft.outlet.id, LISTING);
    expect(await failure(publishDrop(null, l2.id, 4, T0))).toMatchObject({ status: 409 });
  });

  test('a stranger gets 403 and an unknown listing 404', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, LISTING);
    const stranger = await makeUser();
    expect(await failure(publishDrop(stranger.id, l.id, 3, T0))).toMatchObject({ status: 403 });
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(await failure(publishDrop(owner.id, missing, 3, T0))).toMatchObject({ status: 404 });
  });
});

describe('today view', () => {
  test("lists tonight's drops with totals, and a counter can read it", async () => {
    const { owner, brand, outlet } = await setup();
    const counter = await staff(brand.id, outlet.id, 'counter');
    const a = await createListing(owner.id, outlet.id, LISTING);
    const b = await createListing(owner.id, outlet.id, { ...LISTING, name: 'Second' });
    const da = await publishDrop(owner.id, a.id, 4, T0);
    await publishDrop(owner.id, b.id, 6, T0);
    await db.update(drops).set({ reservedCount: 2 }).where(eq(drops.id, da.id));

    const view = await getToday(counter.id, outlet.id, T0);
    expect(view.serviceDate).toBe(DATE);
    expect(view.drops).toHaveLength(2);
    expect(view.totals).toMatchObject({ drops: 2, quantity: 10, reserved: 2, remaining: 8 });
    expect(await failure(getToday((await makeUser()).id, outlet.id, T0))).toMatchObject({ status: 403 });
  });

  test('a window that passed midnight still shows after midnight', async () => {
    const { owner, outlet } = await setup();
    const l = await createListing(owner.id, outlet.id, { ...LISTING, pickupStart: '22:00', pickupEnd: '01:00' });
    await publishDrop(owner.id, l.id, 3, T0);
    // 00:30 IST on 11-02: service_date is yesterday, but the window is still open.
    const view = await getToday(owner.id, outlet.id, new Date('2026-11-01T19:00:00Z'));
    expect(view.drops).toHaveLength(1);
  });
});

describe('vendor catalogue routes', () => {
  test('outlets, listings, publish, today and drop update over HTTP', async () => {
    const { owner, brand, outlet } = await setup();
    const counter = await staff(brand.id, outlet.id, 'counter');
    const call = async (userId: string, method: string, path: string, body?: unknown) => {
      const token = await createSession(userId, new Date());
      const res = await app.request(`/api/v1/vendor${path}`, {
        method,
        headers: { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    const mine = await call(owner.id, 'GET', '/outlets');
    expect(mine.status).toBe(200);
    expect(mine.json.outlets.map((o: { id: string }) => o.id)).toContain(outlet.id);

    const made = await call(owner.id, 'POST', `/outlets/${outlet.id}/listings`, LISTING);
    expect(made.status).toBe(200);
    const id = made.json.listing.id as string;
    const list = await call(owner.id, 'GET', `/outlets/${outlet.id}/listings`);
    expect(list.json.listings).toHaveLength(1);
    expect((await call(owner.id, 'POST', `/outlets/${outlet.id}/listings`, { ...LISTING, pickupStart: 'nope' })).status).toBe(400);
    expect((await call(counter.id, 'GET', `/outlets/${outlet.id}/listings`)).status).toBe(403);
    expect((await call(counter.id, 'POST', `/outlets/${outlet.id}/listings`, LISTING)).status).toBe(403);

    const patched = await call(owner.id, 'PATCH', `/listings/${id}`, { name: 'Renamed' });
    expect(patched.json.listing.name).toBe('Renamed');

    const target = await makeLiveOutlet({ brandId: brand.id });
    const copied = await call(owner.id, 'POST', `/listings/${id}/copy`, { targetOutletId: target.id });
    expect(copied.status).toBe(200);
    expect(copied.json.listing.outletId).toBe(target.id);

    // The route uses the real clock, so use a listing that is open all day: end is 23:59 and start 00:00.
    const allDay = await call(owner.id, 'POST', `/outlets/${outlet.id}/listings`, { ...LISTING, pickupStart: '00:00', pickupEnd: '23:59' });
    const put = await call(owner.id, 'PUT', `/listings/${allDay.json.listing.id}/drops/today`, { quantity: 5 });
    expect(put.status).toBe(200);
    const dropId = put.json.drop.id as string;
    const today = await call(counter.id, 'GET', `/outlets/${outlet.id}/today`);
    expect(today.status).toBe(200);
    expect(today.json.today.drops.map((d: { id: string }) => d.id)).toContain(dropId);

    const paused = await call(owner.id, 'PATCH', `/drops/${dropId}`, { status: 'paused' });
    expect(paused.json.drop.status).toBe('paused');
    expect((await call(counter.id, 'PATCH', `/drops/${dropId}`, { status: 'live' })).status).toBe(403);
    expect((await call(owner.id, 'PUT', `/listings/${id}/drops/today`, { quantity: 'x' })).status).toBe(400);

    const gone = await call(owner.id, 'DELETE', `/listings/${id}`);
    expect(gone.json.listing.archivedAt).not.toBeNull();
  });
});
