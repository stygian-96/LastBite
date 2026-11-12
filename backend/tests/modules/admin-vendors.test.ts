import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { areas, brands, drops, memberships, outlets } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { app } from '../../src/app.js';
import { createSession } from '../../src/modules/auth/session.js';
import { decideOutlet } from '../../src/modules/admin/review.js';
import { getVendor, getVendorHistory, listInventory, listVendors } from '../../src/modules/admin/vendors.js';
import { collectOrder } from '../../src/modules/pickup/collect.js';
import { makeBrand, makeDrop, makeListing, makeLiveOutlet, makePaidOrder, makeUser } from '../helpers/factories.js';
import { getDropRow, getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

// 18:30 IST on 2026-11-02: tonight is the factories' default service date.
const now = new Date('2026-11-02T13:00:00Z');

beforeEach(resetDb);

async function adminHeaders(isAdmin = true) {
  const user = await makeUser({ isAdmin });
  const token = await createSession(user.id, new Date());
  return { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN, 'content-type': 'application/json' };
}

const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

async function ownerOf(outletId: string, phone?: string) {
  const [o] = await db.select().from(outlets).where(eq(outlets.id, outletId));
  const owner = await makeUser(phone ? { phone } : {});
  await db.insert(memberships).values({ userId: owner.id, brandId: o!.brandId, role: 'owner' });
  return owner;
}

describe('routes', () => {
  test('non-admin gets 403 and signed-out gets 401 on every new route', async () => {
    const id = randomUUID();
    const user = await adminHeaders(false);
    const anon = { 'content-type': 'application/json' };
    for (const headers of [user, anon]) {
      const codes = await Promise.all([
        call(headers, 'GET', '/vendors'),
        call(headers, 'GET', '/inventory'),
        call(headers, 'PATCH', `/drops/${id}`, { status: 'paused' }),
        call(headers, 'POST', `/drops/${id}/cancel`, { reason: 'x', chargedTo: 'platform' }),
      ]);
      expect(codes.map((r) => r.status)).toEqual(Array(4).fill(headers === user ? 403 : 401));
    }
  });

  test('an admin pauses and resumes a drop, and cannot change anything else', async () => {
    const headers = await adminHeaders();
    const drop = await makeDrop();
    expect((await call(headers, 'PATCH', `/drops/${drop.id}`, { status: 'paused' })).status).toBe(200);
    expect((await getDropRow(drop.id)).status).toBe('paused');
    expect((await call(headers, 'PATCH', `/drops/${drop.id}`, { status: 'live' })).status).toBe(200);
    expect((await getDropRow(drop.id)).status).toBe('live');
    expect((await call(headers, 'PATCH', `/drops/${drop.id}`, { quantity: 50 })).status).toBe(400);
    expect((await getDropRow(drop.id)).quantity).toBe(5);
  });

  test('an admin cancel ends the drop and refunds paid orders, charged as the admin says', async () => {
    const headers = await adminHeaders();
    const drop = await makeDrop({ reservedCount: 1 });
    const order = await makePaidOrder({ dropId: drop.id });
    const res = await call(headers, 'POST', `/drops/${drop.id}/cancel`, { reason: 'Food safety check', chargedTo: 'platform' });
    expect(res.status).toBe(200);
    expect((await getDropRow(drop.id)).status).toBe('cancelled');
    expect((await getOrderRow(order.id)).status).toBe('cancelled');
    expect(await refundsFor(order.id)).toMatchObject([{ amountPaise: order.pricePaise, chargedTo: 'platform' }]);
    expect((await call(headers, 'POST', `/drops/${drop.id}/cancel`, { reason: 'again', chargedTo: 'platform' })).status).toBe(409);
  });

  test('a cancel with an unknown payer is refused', async () => {
    const headers = await adminHeaders();
    const drop = await makeDrop();
    expect((await call(headers, 'POST', `/drops/${drop.id}/cancel`, { reason: 'x', chargedTo: 'nobody' })).status).toBe(400);
    expect((await getDropRow(drop.id)).status).toBe('live');
  });
});

describe('listVendors', () => {
  test('lists outlets past draft with owner phone and tonight counts, cancelled drops left out', async () => {
    const live = await makeLiveOutlet();
    await makeLiveOutlet({ status: 'draft' });
    await ownerOf(live.id, '+919812300001');
    await makeDrop({ outletId: live.id, quantity: 6, reservedCount: 2 });
    await makeDrop({ outletId: live.id, quantity: 4, status: 'cancelled' });
    await makeDrop({ outletId: live.id, quantity: 9, serviceDate: '2026-11-01' });

    const { vendors: rows, hasMore } = await listVendors({}, now);
    expect(hasMore).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outlet: { id: live.id, status: 'live' },
      ownerPhone: '+919812300001',
      tonight: { drops: 1, quantity: 6, reserved: 2 },
    });
  });

  test('filters by status and searches brand name, branch and phone', async () => {
    const a = await makeLiveOutlet({ contactPhone: '9876500000' });
    const b = await makeLiveOutlet({ status: 'suspended' });
    await db.update(brands).set({ name: 'Butterfold 50% Bakery' }).where(eq(brands.id, a.brandId));

    const ids = async (f: Parameters<typeof listVendors>[0]) => (await listVendors(f, now)).vendors.map((r) => r.outlet.id);
    expect(await ids({ status: 'suspended' })).toEqual([b.id]);
    expect(await ids({ q: 'butterfold' })).toEqual([a.id]);
    expect(await ids({ q: '50%' })).toEqual([a.id]);
    expect(await ids({ q: '98765' })).toEqual([a.id]);
    expect(await ids({ q: b.branchName })).toEqual([b.id]);
    // A bad filter is dropped, not an error.
    expect((await ids({ status: 'nonsense', areaId: 'nope', offset: '-4' })).sort()).toEqual([a.id, b.id].sort());
  });

  test('filters by area', async () => {
    const [first, second] = await db.select({ id: areas.id }).from(areas).limit(2);
    const here = await makeLiveOutlet({ areaId: first!.id });
    await makeLiveOutlet({ areaId: second!.id });
    expect((await listVendors({ areaId: first!.id }, now)).vendors.map((r) => r.outlet.id)).toEqual([here.id]);
  });

  test('pages 50 at a time with no overlap', async () => {
    const brand = await makeBrand({ name: 'Paged Brand' });
    const made = [];
    for (let i = 0; i < 52; i++) made.push((await makeLiveOutlet({ brandId: brand.id, branchName: `B${String(i).padStart(2, '0')}` })).id);
    const one = await listVendors({}, now);
    expect(one.vendors).toHaveLength(50);
    expect(one.hasMore).toBe(true);
    const two = await listVendors({ offset: '50' }, now);
    expect(two).toMatchObject({ hasMore: false });
    expect([...one.vendors, ...two.vendors].map((r) => r.outlet.id)).toEqual(made);
  });
});

describe('listInventory', () => {
  test('tonight only, with order counts, and narrowed to one outlet', async () => {
    const tonight = await makeDrop({ reservedCount: 3 });
    const other = await makeDrop();
    await makeDrop({ serviceDate: '2026-11-01', pickupStartAt: '2026-11-01T19:00:00+05:30', pickupEndAt: '2026-11-01T21:00:00+05:30' });
    await makePaidOrder({ dropId: tonight.id });
    await makePaidOrder({ dropId: tonight.id, status: 'collected' });
    await makePaidOrder({ dropId: tonight.id, status: 'no_show' });

    const all = await listInventory({}, now);
    expect(all.serviceDate).toBe('2026-11-02');
    expect(all.drops.map((r) => r.drop.id).sort()).toEqual([tonight.id, other.id].sort());
    const row = all.drops.find((r) => r.drop.id === tonight.id)!;
    expect(row.orders).toEqual({ paid: 1, collected: 1, noShow: 1, cancelled: 0, soldPaise: 30000 });
    expect(row.drop).toMatchObject({ quantity: 5, reservedCount: 3 });

    const one = await listInventory({ outletId: other.outletId }, now);
    expect(one.drops.map((r) => r.drop.id)).toEqual([other.id]);
    expect((await listInventory({ outletId: 'not-a-uuid' }, now)).drops).toEqual([]);
  });

  test('searches brand, branch and item name, and filters by area', async () => {
    const [first, second] = await db.select({ id: areas.id }).from(areas).limit(2);
    const bakery = await makeLiveOutlet({ areaId: first!.id, branchName: 'Church Street' });
    await db.update(brands).set({ name: 'Crumb & Co' }).where(eq(brands.id, bakery.brandId));
    const cake = await makeDrop({ outletId: bakery.id, name: 'Cake slice box' });
    const other = await makeDrop({ outletId: (await makeLiveOutlet({ areaId: second!.id })).id, name: 'Rice bowl' });

    const ids = async (f: Parameters<typeof listInventory>[0]) => (await listInventory(f, now)).drops.map((r) => r.drop.id);
    expect(await ids({ q: 'crumb' })).toEqual([cake.id]);
    expect(await ids({ q: 'church' })).toEqual([cake.id]);
    expect(await ids({ q: 'RICE' })).toEqual([other.id]);
    expect(await ids({ areaId: second!.id })).toEqual([other.id]);
    expect(await ids({ q: 'cake', areaId: second!.id })).toEqual([]);
  });
});

describe('one vendor', () => {
  test('detail has facts, stats, listings with archived last, and tonight only', async () => {
    const outlet = await makeLiveOutlet({ address: '12 Church Street', fssaiNumber: '12345678901234' });
    const old = await makeListing({ outletId: outlet.id, name: 'Old bag', archivedAt: '2026-10-01T00:00:00Z' });
    const bag = await makeListing({ outletId: outlet.id, name: 'Bread bag' });
    const tonight = await makeDrop({ outletId: outlet.id, listingId: bag.id });
    await makeDrop({ outletId: outlet.id, listingId: bag.id, serviceDate: '2026-11-01', pickupStartAt: '2026-11-01T19:00:00+05:30', pickupEndAt: '2026-11-01T21:00:00+05:30' });

    const v = await getVendor(outlet.id, now);
    expect(v.outlet.id).toBe(outlet.id);
    expect(v.details).toMatchObject({ address: '12 Church Street', fssaiNumber: '12345678901234' });
    expect(v.stats).toMatchObject({ orders30d: 0 });
    expect(v.listings.map((l) => l.id)).toEqual([bag.id, old.id]);
    expect(v.tonightDrops.map((r) => r.drop.id)).toEqual([tonight.id]);
  });

  test('history covers the 30 nights before tonight, newest first, with what was sold', async () => {
    const outlet = await makeLiveOutlet();
    const bag = await makeListing({ outletId: outlet.id });
    const night = (date: string) =>
      makeDrop({ outletId: outlet.id, listingId: bag.id, serviceDate: date, pickupStartAt: `${date}T19:00:00+05:30`, pickupEndAt: `${date}T21:00:00+05:30` });
    await makeDrop({ outletId: outlet.id, listingId: bag.id }); // tonight, not history
    const yesterday = await night('2026-11-01');
    const older = await night('2026-10-20');
    await night('2026-09-01'); // too old
    await makePaidOrder({ dropId: yesterday.id, status: 'collected' });
    await makePaidOrder({ dropId: yesterday.id, status: 'no_show' });
    await makePaidOrder({ dropId: yesterday.id, status: 'cancelled' });

    const h = await getVendorHistory(outlet.id, now);
    expect(h).toMatchObject({ from: '2026-10-03', to: '2026-11-02', days: 30 });
    expect(h.drops.map((r) => r.drop.id)).toEqual([yesterday.id, older.id]);
    expect(h.drops[0]!.orders).toEqual({ paid: 0, collected: 1, noShow: 1, cancelled: 1, soldPaise: 20000 });

    expect((await getVendorHistory(outlet.id, now, '7')).drops.map((r) => r.drop.id)).toEqual([yesterday.id]);
    const wide = await getVendorHistory(outlet.id, now, '90');
    expect(wide).toMatchObject({ from: '2026-08-04', days: 90 });
    expect(wide.drops).toHaveLength(3);
    expect((await getVendorHistory(outlet.id, now, '9999')).days).toBe(30);
  });

  test('draft, unknown and malformed outlets are 404 over HTTP', async () => {
    const headers = await adminHeaders();
    const draft = await makeLiveOutlet({ status: 'draft' });
    for (const id of [draft.id, randomUUID(), 'nope']) {
      expect((await call(headers, 'GET', `/vendors/${id}`)).status).toBe(404);
    }
    expect((await call(headers, 'GET', `/vendors/${randomUUID()}/history`)).status).toBe(404);
    const live = await makeLiveOutlet();
    expect((await call(headers, 'GET', `/vendors/${live.id}`)).status).toBe(200);
    expect((await call(headers, 'GET', `/vendors/${live.id}/history`)).status).toBe(200);
  });
});

describe('inactive outlet', () => {
  test('orders already paid can still be collected after the outlet is made inactive', async () => {
    const admin = await makeUser({ isAdmin: true });
    const drop = await makeDrop();
    const order = await makePaidOrder({ dropId: drop.id });
    const owner = await ownerOf(drop.outletId);

    await decideOutlet(admin.id, drop.outletId, { decision: 'suspend', reason: 'Paused by admin' }, now);
    const view = await collectOrder(owner.id, order.id, new Date('2026-11-02T14:00:00Z'));
    expect(view.status).toBe('collected');
    expect((await db.select().from(drops).where(eq(drops.id, drop.id)))[0]!.status).toBe('live');
  });
});
