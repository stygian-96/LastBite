import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { areas } from '../../src/db/schema.js';
import { ApiError } from '../../src/lib/errors.js';
import { getDrop, getOutletPage, listCities, listDrops } from '../../src/modules/catalogue/feed.js';
import { app } from '../../src/app.js';
import { makeBrand, makeDrop, makeLiveOutlet, makeOrder, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-02. Default drops pick up 19:00-21:00 IST and stop selling at 20:45.
const NOW = new Date('2026-11-02T10:00:00Z');

beforeEach(resetDb);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

async function areaId(name: string) {
  const [row] = await db.select({ id: areas.id }).from(areas).where(eq(areas.name, name));
  if (!row) throw new Error(`no area ${name}`);
  return row.id;
}

/** A live outlet in the given area (Indiranagar, Bengaluru by default). */
async function outletIn(name = 'Indiranagar', o: Parameters<typeof makeLiveOutlet>[0] = {}) {
  return makeLiveOutlet({ areaId: await areaId(name), ...o });
}

const ids = (cards: { id: string }[]) => cards.map((c) => c.id).sort();

describe('feed', () => {
  test('feed shows only live drops from live outlets in the city', async () => {
    const outlet = await outletIn();
    const live = await makeDrop({ outletId: outlet.id });
    await makeDrop({ outletId: outlet.id, status: 'paused' });
    await makeDrop({ outletId: outlet.id, status: 'cancelled' });
    const draft = await outletIn('Indiranagar', { status: 'draft' });
    await makeDrop({ outletId: draft.id });
    const suspended = await outletIn('Indiranagar', { status: 'suspended' });
    await makeDrop({ outletId: suspended.id });
    const hyd = await outletIn('Madhapur');
    const hydDrop = await makeDrop({ outletId: hyd.id });

    expect(ids(await listDrops({ city: 'bengaluru' }, NOW))).toEqual([live.id]);
    expect(ids(await listDrops({ city: 'hyderabad' }, NOW))).toEqual([hydDrop.id]);
  });

  test('feed hides paused outlets until paused_until passes', async () => {
    const outlet = await outletIn('Indiranagar', { pausedUntil: '2026-11-02T12:00:00Z' });
    const drop = await makeDrop({ outletId: outlet.id });
    expect(await listDrops({ city: 'bengaluru' }, NOW)).toHaveLength(0);
    expect(ids(await listDrops({ city: 'bengaluru' }, new Date('2026-11-02T12:00:00Z')))).toEqual([drop.id]);
    expect(ids(await listDrops({ city: 'bengaluru' }, new Date('2026-11-02T12:30:00Z')))).toEqual([drop.id]);
  });

  test('feed hides drops after sales_end_at', async () => {
    const outlet = await outletIn();
    const drop = await makeDrop({ outletId: outlet.id });
    // 20:44 IST is still selling, 20:45 IST is not.
    expect(ids(await listDrops({ city: 'bengaluru' }, new Date('2026-11-02T15:14:00Z')))).toEqual([drop.id]);
    expect(await listDrops({ city: 'bengaluru' }, new Date('2026-11-02T15:15:00Z'))).toHaveLength(0);
  });

  test('sold out drop stays listed with remaining 0, after the others', async () => {
    const outlet = await outletIn();
    // Sells out and would end sooner, but sorts last.
    const soldOut = await makeDrop({
      outletId: outlet.id,
      quantity: 3,
      reservedCount: 3,
      salesEndAt: '2026-11-02T18:00:00+05:30',
    });
    const late = await makeDrop({ outletId: outlet.id, salesEndAt: '2026-11-02T20:45:00+05:30' });
    const early = await makeDrop({ outletId: outlet.id, salesEndAt: '2026-11-02T19:30:00+05:30' });
    const feed = await listDrops({ city: 'bengaluru' }, NOW);
    expect(feed.map((c) => c.id)).toEqual([early.id, late.id, soldOut.id]);
    expect(feed[2]!.remaining).toBe(0);
    expect(feed[0]!.remaining).toBe(5);
  });

  test('veg filter returns only diet veg', async () => {
    const outlet = await outletIn();
    const veg = await makeDrop({ outletId: outlet.id, diet: 'veg' });
    await makeDrop({ outletId: outlet.id, diet: 'egg' });
    await makeDrop({ outletId: outlet.id, diet: 'nonveg' });
    await makeDrop({ outletId: outlet.id, diet: 'mixed' });
    expect(ids(await listDrops({ city: 'bengaluru', veg: true }, NOW))).toEqual([veg.id]);
    expect(await listDrops({ city: 'bengaluru' }, NOW)).toHaveLength(4);
  });

  test('pickupBy, maxPrice, area, category and q each filter', async () => {
    const indi = await outletIn('Indiranagar');
    const kora = await outletIn('Koramangala');
    const base = await makeDrop({ outletId: indi.id, name: 'Plain', pricePaise: 10000 });
    const cheap = await makeDrop({ outletId: indi.id, name: 'Cheap', pricePaise: 5000 });
    const early = await makeDrop({
      outletId: indi.id,
      name: 'Early',
      pickupStartAt: '2026-11-02T18:00:00+05:30',
      pickupEndAt: '2026-11-02T20:00:00+05:30',
      salesEndAt: '2026-11-02T19:45:00+05:30',
    });
    const meals = await makeDrop({ outletId: indi.id, name: 'Dinner', foodCategory: 'meals' });
    const elsewhere = await makeDrop({ outletId: kora.id, name: 'Elsewhere' });
    const all = [base.id, cheap.id, early.id, meals.id, elsewhere.id].sort();
    expect(ids(await listDrops({ city: 'bengaluru' }, NOW))).toEqual(all);

    expect(ids(await listDrops({ city: 'bengaluru', pickupBy: '18:30' }, NOW))).toEqual([early.id]);
    expect(ids(await listDrops({ city: 'bengaluru', pickupBy: '19:00' }, NOW))).toEqual(all);
    expect(await listDrops({ city: 'bengaluru', pickupBy: '17:00' }, NOW)).toHaveLength(0);
    expect(ids(await listDrops({ city: 'bengaluru', maxPricePaise: 5000 }, NOW))).toEqual([cheap.id]);
    expect(ids(await listDrops({ city: 'bengaluru', area: 'Koramangala' }, NOW))).toEqual([elsewhere.id]);
    expect(ids(await listDrops({ city: 'bengaluru', category: 'meals' }, NOW))).toEqual([meals.id]);
    expect(ids(await listDrops({ city: 'bengaluru', q: 'cheap' }, NOW))).toEqual([cheap.id]);
  });

  test('q matches listing, brand and branch names, and treats % and _ literally', async () => {
    const brand = await makeBrand({ name: 'Butterfold' });
    const byBrand = await outletIn('Indiranagar', { brandId: brand.id, branchName: 'Main' });
    const byBranch = await outletIn('Indiranagar', { branchName: 'Sunrise Annex' });
    const other = await outletIn('Indiranagar', { branchName: 'Other' });
    const d1 = await makeDrop({ outletId: byBrand.id, name: 'Bag one' });
    const d2 = await makeDrop({ outletId: byBranch.id, name: 'Bag two' });
    const d3 = await makeDrop({ outletId: other.id, name: 'Rye 100% loaf' });
    expect(ids(await listDrops({ city: 'bengaluru', q: 'butter' }, NOW))).toEqual([d1.id]);
    expect(ids(await listDrops({ city: 'bengaluru', q: 'sunrise' }, NOW))).toEqual([d2.id]);
    expect(ids(await listDrops({ city: 'bengaluru', q: 'rye' }, NOW))).toEqual([d3.id]);
    expect(ids(await listDrops({ city: 'bengaluru', q: '100%' }, NOW))).toEqual([d3.id]);
    expect(await listDrops({ city: 'bengaluru', q: '%' }, NOW)).toHaveLength(1);
    expect(await listDrops({ city: 'bengaluru', q: 'B_g' }, NOW)).toHaveLength(0);
  });

  test('feed never returns payout, PAN or staff fields', async () => {
    const outlet = await outletIn('Indiranagar', { contactPhone: '+919876543210', gstin: '29ABCDE1234F1Z5' });
    const drop = await makeDrop({ outletId: outlet.id, photoKey: 'drops/a.jpg' });
    const [card] = await listDrops({ city: 'bengaluru' }, NOW);
    expect(card).toMatchObject({
      id: drop.id,
      pricePaise: 10000,
      valuePaise: 30000,
      remaining: 5,
      area: 'Indiranagar',
      photoUrl: 'https://fake-storage.test/public/drops/a.jpg',
    });
    expect(typeof card!.pickupStartAt).toBe('string');
    const detail = await getDrop(drop.id, NOW);
    const keys = JSON.stringify([Object.keys(card!), Object.keys(detail)]).toLowerCase();
    for (const banned of ['pan', 'payout', 'account', 'ifsc', 'phone', 'gstin', 'commission', 'member', 'staff', 'lat', 'lng', 'distance']) {
      expect(keys).not.toContain(banned);
    }
    const text = JSON.stringify([card, detail]);
    expect(text).not.toContain('+919876543210');
    expect(text).not.toContain('29ABCDE1234F1Z5');
  });

  test('photoUrl is null when there is no photo', async () => {
    const outlet = await outletIn();
    await makeDrop({ outletId: outlet.id, photoKey: null });
    const [card] = await listDrops({ city: 'bengaluru' }, NOW);
    expect(card!.photoUrl).toBeNull();
  });

  test('unknown city returns 400', async () => {
    const err = await failure(listDrops({ city: 'atlantis' }, NOW));
    expect(err).toMatchObject({ code: 'invalid_request', status: 400 });
    const res = await app.request('/api/v1/drops?city=atlantis');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    expect((await app.request('/api/v1/drops')).status).toBe(400);
  });
});

describe('cities', () => {
  test('lists cities with their areas', async () => {
    const cities = await listCities();
    expect(cities.map((c) => c.slug)).toEqual(['bengaluru', 'hyderabad']);
    expect(cities[0]).toMatchObject({ slug: 'bengaluru', name: 'Bengaluru' });
    expect(cities[0]!.areas.map((a) => a.name)).toContain('Indiranagar');
    const res = await app.request('/api/v1/cities');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cities: unknown[] }).cities).toHaveLength(2);
  });
});

describe('drop detail', () => {
  test('returns detail fields', async () => {
    const outlet = await outletIn('Indiranagar', {
      address: '12 100ft Road',
      mapsUrl: 'https://maps.example/x',
      pickupInstructions: 'Ask at the counter',
      fssaiNumber: '12345678901234',
    });
    const drop = await makeDrop({ outletId: outlet.id, description: 'Tasty', allergens: ['gluten', 'milk'] });
    const d = await getDrop(drop.id, NOW);
    expect(d).toMatchObject({
      id: drop.id,
      description: 'Tasty',
      allergens: ['gluten', 'milk'],
      pickupInstructions: 'Ask at the counter',
      address: '12 100ft Road',
      mapsUrl: 'https://maps.example/x',
      fssaiNumber: '12345678901234',
      rating: null,
    });
  });

  test('sold out drop is returned; ended, hidden, or non-live outlet is 404', async () => {
    const outlet = await outletIn();
    const soldOut = await makeDrop({ outletId: outlet.id, quantity: 2, reservedCount: 2 });
    expect((await getDrop(soldOut.id, NOW)).remaining).toBe(0);
    // After sales end but before pickup end it still shows.
    expect((await getDrop(soldOut.id, new Date('2026-11-02T15:20:00Z'))).remaining).toBe(0);
    // Past pickup end (21:00 IST).
    expect(await failure(getDrop(soldOut.id, new Date('2026-11-02T15:30:00Z')))).toMatchObject({ status: 404 });

    const paused = await makeDrop({ outletId: outlet.id, status: 'paused' });
    expect(await failure(getDrop(paused.id, NOW))).toMatchObject({ status: 404 });
    const cancelled = await makeDrop({ outletId: outlet.id, status: 'cancelled' });
    expect(await failure(getDrop(cancelled.id, NOW))).toMatchObject({ status: 404 });

    const draft = await outletIn('Indiranagar', { status: 'draft' });
    const hidden = await makeDrop({ outletId: draft.id });
    expect(await failure(getDrop(hidden.id, NOW))).toMatchObject({ status: 404 });
    expect(await failure(getDrop('not-a-uuid', NOW))).toMatchObject({ status: 404 });
    expect((await app.request(`/api/v1/drops/${hidden.id}`)).status).toBe(404);
    // The route uses the real clock, so this one's window is far in the future.
    const future = await makeDrop({
      outletId: outlet.id,
      quantity: 2,
      reservedCount: 2,
      serviceDate: '2099-01-01',
      pickupStartAt: '2099-01-01T19:00:00+05:30',
      pickupEndAt: '2099-01-01T21:00:00+05:30',
      salesEndAt: '2099-01-01T20:45:00+05:30',
    });
    const res = await app.request(`/api/v1/drops/${future.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { drop: { remaining: number } }).drop.remaining).toBe(0);
  });
});

describe('outlet page', () => {
  test('shows outlet and tonight drops, with rating once there are 5 ratings', async () => {
    const brand = await makeBrand({ name: 'Butterfold', slug: 'butterfold' });
    const outlet = await outletIn('Indiranagar', { brandId: brand.id, branchName: 'Indiranagar', slug: 'indiranagar' });
    const drop = await makeDrop({ outletId: outlet.id });
    await makeDrop({ outletId: outlet.id, status: 'paused' });

    let page = await getOutletPage('butterfold', 'indiranagar', NOW);
    expect(page).toMatchObject({ brandName: 'Butterfold', branchName: 'Indiranagar', area: 'Indiranagar', rating: null });
    expect(page.drops.map((d) => d.id)).toEqual([drop.id]);

    for (const rating of [5, 5, 4, 4]) {
      await makeOrder({ dropId: drop.id, outletId: outlet.id, userId: null, anonId: `anon-${Math.random()}`, status: 'collected', rating });
    }
    page = await getOutletPage('butterfold', 'indiranagar', NOW);
    expect(page.rating).toBeNull();
    const user = await makeUser();
    await makeOrder({ dropId: drop.id, outletId: outlet.id, userId: user.id, status: 'collected', rating: 2 });
    page = await getOutletPage('butterfold', 'indiranagar', NOW);
    expect(page.rating).toBe(4);
  });

  test('404 for unknown or non-live outlet', async () => {
    const brand = await makeBrand({ slug: 'b1' });
    await outletIn('Indiranagar', { brandId: brand.id, slug: 'o1', status: 'suspended' });
    expect(await failure(getOutletPage('b1', 'o1', NOW))).toMatchObject({ status: 404 });
    expect(await failure(getOutletPage('nope', 'nope', NOW))).toMatchObject({ status: 404 });
    expect((await app.request('/api/v1/outlets/b1/o1')).status).toBe(404);
  });
});
