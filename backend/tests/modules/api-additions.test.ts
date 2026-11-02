import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { areas, auditLog, issues, memberships, notifications, orders, outlets, payments, payoutAccounts } from '../../src/db/schema.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { env } from '../../src/lib/env.js';
import { decideOutlet } from '../../src/modules/admin/review.js';
import { adminRefund } from '../../src/modules/admin/support.js';
import { createSession } from '../../src/modules/auth/session.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { app } from '../../src/app.js';
import { makeBrand, makeDrop, makeLiveOutlet, makeOrder, makePaidOrder, makePayment, makePayoutAccount, makeUser } from '../helpers/factories.js';
import { getDropRow, getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

// 15:30 IST, with drops on sale until 20:45.
const NOW = new Date('2026-11-02T10:00:00Z');

let gateway: FakeGateway;

beforeEach(async () => {
  await resetDb();
  gateway = new FakeGateway();
  setGateway(gateway);
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(method: string, path: string, userId?: string, body?: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(userId ? { cookie: `session=${await createSession(userId, new Date())}`, origin: env().FRONTEND_ORIGIN } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const admin = () => makeUser({ isAdmin: true });
const auditRows = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

async function owns(brandId: string) {
  const user = await makeUser();
  await db.insert(memberships).values({ userId: user.id, brandId, role: 'owner' });
  return user;
}

async function staffAt(outlet: { id: string; brandId: string }, role: 'manager' | 'counter', payoutAccountId?: string) {
  const user = await makeUser();
  await db.insert(memberships).values({ userId: user.id, brandId: outlet.brandId, outletId: outlet.id, role, payoutAccountId });
  return user;
}

describe('public responses carry the outlet', () => {
  const identity = (outlet: { id: string; slug: string }, brandSlug: string) => ({
    outletId: outlet.id,
    brandSlug,
    outletSlug: outlet.slug,
    city: expect.any(String),
    salesEndAt: '2026-11-02T15:15:00.000Z',
  });

  async function onSale() {
    const brand = await makeBrand();
    const outlet = await makeLiveOutlet({ brandId: brand.id });
    const drop = await makeDrop({ outletId: outlet.id });
    const [area] = await db.select().from(areas).where(eq(areas.id, outlet.areaId!));
    return { brand, outlet, drop, city: area!.city };
  }

  test('the feed', async () => {
    const { brand, outlet, city } = await onSale();
    const { json } = await call('GET', `/drops?city=${city}`);
    expect(json.drops[0]).toMatchObject({ ...identity(outlet, brand.slug), city });
  });

  test('a drop', async () => {
    const { brand, outlet, drop } = await onSale();
    const { json } = await call('GET', `/drops/${drop.id}`);
    expect(json.drop).toMatchObject(identity(outlet, brand.slug));
  });

  test('an outlet page, and its drops', async () => {
    const { brand, outlet } = await onSale();
    const { json } = await call('GET', `/outlets/${brand.slug}/${outlet.slug}`);
    expect(json.outlet).toMatchObject({ outletId: outlet.id, brandSlug: brand.slug, outletSlug: outlet.slug, city: expect.any(String) });
    expect(json.outlet.drops[0]).toMatchObject(identity(outlet, brand.slug));
  });
});

describe('message links', () => {
  test('the order link carries the order ID, which GET /orders/:id takes', async () => {
    const drop = await makeDrop();
    const user = await makeUser();
    const order = await makeOrder({ dropId: drop.id, userId: user.id });
    const payment = await makePayment({ orderId: order.id });
    const gp = gateway.addPayment({
      id: 'pay_1',
      orderId: payment.razorpayOrderId,
      status: 'captured',
      amountPaise: 10000,
      feePaise: 236,
      method: 'upi',
    });
    await applyCapture(gp, NOW);

    const [message] = await db.select().from(notifications).where(eq(notifications.dedupeKey, `confirm:${order.id}`));
    expect((message!.variables as { link: string }).link).toBe(`${env().FRONTEND_ORIGIN}/o/${order.id}`);
  });
});

describe('GET /vendor/outlets/:id/staff', () => {
  test('lists the people who can work there, brand-wide members included', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await owns(outlet.brandId);
    const manager = await staffAt(outlet, 'manager');
    const elsewhere = await makeLiveOutlet({ brandId: outlet.brandId });
    await staffAt(elsewhere, 'counter');
    const gone = await staffAt(outlet, 'counter');
    await db.update(memberships).set({ removedAt: NOW.toISOString() }).where(eq(memberships.userId, gone.id));

    const { status, json } = await call('GET', `/vendor/outlets/${outlet.id}/staff`, manager.id);

    expect(status).toBe(200);
    expect(json.staff.map((s: { userId: string }) => s.userId).sort()).toEqual([owner.id, manager.id].sort());
    expect(json.staff.find((s: { userId: string }) => s.userId === manager.id)).toEqual({
      membershipId: expect.any(String),
      userId: manager.id,
      name: manager.name,
      phone: manager.phone,
      role: 'manager',
      outletId: outlet.id,
    });
  });

  test('is refused to counter staff and strangers', async () => {
    const outlet = await makeLiveOutlet();
    expect((await call('GET', `/vendor/outlets/${outlet.id}/staff`, (await staffAt(outlet, 'counter')).id)).status).toBe(403);
    expect((await call('GET', `/vendor/outlets/${outlet.id}/staff`, (await makeUser()).id)).status).toBe(403);
  });
});

describe('GET /vendor/payout-accounts', () => {
  const secret = ['panEncrypted', 'accountEncrypted', 'razorpayAccountId'];

  test('gives a brand owner the brand accounts, safe fields only, without a franchisee account', async () => {
    const brand = await makeBrand();
    const own = await makePayoutAccount({ brandId: brand.id });
    const franchise = await makePayoutAccount({ brandId: brand.id });
    await makePayoutAccount();
    const outlet = await makeLiveOutlet({ brandId: brand.id, payoutAccountId: own.id });
    await staffAt(outlet, 'manager', franchise.id);

    const { status, json } = await call('GET', `/vendor/payout-accounts?brand_id=${brand.id}`, (await owns(brand.id)).id);

    expect(status).toBe(200);
    expect(json.payoutAccounts.map((a: { id: string }) => a.id)).toEqual([own.id]);
    expect(json.payoutAccounts[0]).toMatchObject({ id: own.id, panLast4: '1234', accountLast4: '6789', status: 'verified' });
    for (const field of secret) expect(json.payoutAccounts[0]).not.toHaveProperty(field);
  });

  test('gives a franchisee only the account named on their membership', async () => {
    const brand = await makeBrand();
    const own = await makePayoutAccount({ brandId: brand.id });
    const franchise = await makePayoutAccount({ brandId: brand.id });
    const outlet = await makeLiveOutlet({ brandId: brand.id, payoutAccountId: own.id });
    const manager = await staffAt(outlet, 'manager', franchise.id);

    const { json } = await call('GET', `/vendor/payout-accounts?brand_id=${brand.id}`, manager.id);

    expect(json.payoutAccounts.map((a: { id: string }) => a.id)).toEqual([franchise.id]);
  });

  test('is refused to anyone else, and a bad brand reads the same', async () => {
    const brand = await makeBrand();
    const user = await makeUser();
    expect((await call('GET', `/vendor/payout-accounts?brand_id=${brand.id}`, user.id)).status).toBe(403);
    expect((await call('GET', '/vendor/payout-accounts?brand_id=nope', user.id)).status).toBe(403);
    expect((await call('GET', '/vendor/payout-accounts', user.id)).status).toBe(400);
  });
});

describe('GET /admin/users', () => {
  test('finds a user by phone', async () => {
    const user = await makeUser({ phone: '+919812345678' });
    const { json } = await call('GET', '/admin/users?phone=9812345678', (await admin()).id);
    expect(json.users).toEqual([
      { id: user.id, name: user.name, phone: '+919812345678', isAdmin: false, createdAt: expect.any(String) },
    ]);
  });

  test('an unknown number finds nobody, and a bad one is refused', async () => {
    const adminId = (await admin()).id;
    expect((await call('GET', '/admin/users?phone=9812345678', adminId)).json.users).toEqual([]);
    expect((await call('GET', '/admin/users?phone=12', adminId)).json.error.code).toBe('invalid_phone');
    expect((await call('GET', '/admin/users', adminId)).status).toBe(400);
  });

  test('is for admins', async () => {
    expect((await call('GET', '/admin/users?phone=9812345678', (await makeUser()).id)).status).toBe(403);
  });
});

describe('GET /admin/payout-accounts', () => {
  test('lists accounts in a status, safe fields only', async () => {
    const held = await makePayoutAccount({ status: 'on_hold' });
    await makePayoutAccount({ status: 'verified' });

    const { status, json } = await call('GET', '/admin/payout-accounts?status=on_hold', (await admin()).id);

    expect(status).toBe(200);
    expect(json.payoutAccounts).toHaveLength(1);
    expect(json.payoutAccounts[0]).toMatchObject({
      id: held.id,
      brandId: held.brandId,
      brandName: expect.any(String),
      legalName: 'Test Legal Name',
      panLast4: '1234',
      accountLast4: '6789',
      status: 'on_hold',
    });
    expect(json.payoutAccounts[0]).not.toHaveProperty('panEncrypted');
    expect(json.payoutAccounts[0]).not.toHaveProperty('accountEncrypted');
  });

  test('a status is optional, and a bad one is refused', async () => {
    await makePayoutAccount();
    const adminId = (await admin()).id;
    expect((await call('GET', '/admin/payout-accounts', adminId)).json.payoutAccounts).toHaveLength(1);
    expect((await call('GET', '/admin/payout-accounts?status=nope', adminId)).status).toBe(400);
  });

  test('is for admins', async () => {
    expect((await call('GET', '/admin/payout-accounts', (await makeUser()).id)).status).toBe(403);
  });
});

describe('changes_needed says why', () => {
  async function inReview() {
    const outlet = await makeLiveOutlet({ status: 'in_review' });
    return { outlet, owner: await owns(outlet.brandId) };
  }
  const fixes = async (outletId: string, userId: string) =>
    (await call('GET', `/vendor/outlets/${outletId}/status`, userId)).json.fixes as { code: string; message: string }[];

  test('the reason comes back from /status as a fix', async () => {
    const { outlet, owner } = await inReview();
    await decideOutlet((await admin()).id, outlet.id, { decision: 'request_changes', reason: 'The photos are blurred' }, NOW);
    expect(await fixes(outlet.id, owner.id)).toContainEqual({ code: 'changes_requested', message: 'The photos are blurred' });
  });

  test('a request for changes needs a reason', async () => {
    const { outlet } = await inReview();
    await expect(decideOutlet((await admin()).id, outlet.id, { decision: 'request_changes' }, NOW)).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });
});

describe('GET /me/orders', () => {
  test('with no status returns every order, newest first', async () => {
    const user = await makeUser();
    const live = await makeOrder({ userId: user.id, status: 'paid' });
    const past = await makeOrder({ userId: user.id, status: 'expired' });
    await db.update(orders).set({ createdAt: '2026-11-01T10:00:00Z' }).where(eq(orders.id, past.id));

    const { status, json } = await call('GET', '/me/orders', user.id);

    expect(status).toBe(200);
    expect(json.orders.map((o: { id: string }) => o.id)).toEqual([live.id, past.id]);
  });
});

describe('holiday closure', () => {
  const until = '2026-11-05T00:00:00+05:30';
  const close = (outletId: string, userId?: string, body: unknown = { until, reason: 'Diwali' }) =>
    call('POST', `/vendor/outlets/${outletId}/pause`, userId, body);

  test('takes the outlet off sale until the date, audited, telling no customers', async () => {
    const outlet = await makeLiveOutlet();
    const drop = await makeDrop({ outletId: outlet.id });
    const order = await makeOrder({ dropId: drop.id, status: 'paid' });
    const owner = await owns(outlet.brandId);

    const { status, json } = await close(outlet.id, owner.id);

    expect(status).toBe(200);
    expect(json.outlet).toMatchObject({ id: outlet.id, pauseReason: 'Diwali' });
    expect(new Date(json.outlet.pausedUntil as string).toISOString()).toBe(new Date(until).toISOString());
    const [area] = await db.select().from(areas).where(eq(areas.id, outlet.areaId!));
    expect((await call('GET', `/drops?city=${area!.city}`)).json.drops).toEqual([]);
    expect(await auditRows('outlet.pause')).toMatchObject([
      { actorId: owner.id, entity: 'outlet', entityId: outlet.id, detail: { until, reason: 'Diwali' } },
    ]);
    expect(await db.select().from(notifications)).toEqual([]);
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });

  test('a manager may, counter staff and strangers may not', async () => {
    const outlet = await makeLiveOutlet();
    expect((await close(outlet.id, (await staffAt(outlet, 'manager')).id)).status).toBe(200);
    expect((await close(outlet.id, (await staffAt(outlet, 'counter')).id)).status).toBe(403);
    expect((await close(outlet.id, (await makeUser()).id)).status).toBe(403);
  });

  test('needs a reason and a time ahead', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await owns(outlet.brandId);
    for (const body of [
      { until },
      { until, reason: ' ' },
      { reason: 'Diwali' },
      { until: '2026-11-01T00:00:00+05:30', reason: 'Diwali' },
      { until: '2026-02-30T00:00:00+05:30', reason: 'Diwali' },
      { until: 'tomorrow', reason: 'Diwali' },
    ]) {
      expect((await close(outlet.id, owner.id, body)).status).toBe(400);
    }
  });

  test('only a live outlet can close for a holiday', async () => {
    const outlet = await makeLiveOutlet({ status: 'suspended' });
    const { status, json } = await close(outlet.id, (await owns(outlet.brandId)).id);
    expect(status).toBe(409);
    expect(json.error.code).toBe('outlet_not_live');
  });

  test('resume puts it back on sale at once, audited', async () => {
    const outlet = await makeLiveOutlet({ pausedUntil: until, pauseReason: 'Diwali' });
    const owner = await owns(outlet.brandId);

    const { status, json } = await call('POST', `/vendor/outlets/${outlet.id}/resume`, owner.id);

    expect(status).toBe(200);
    expect(json.outlet).toMatchObject({ pausedUntil: null, pauseReason: null });
    expect(await auditRows('outlet.resume')).toMatchObject([{ actorId: owner.id, entityId: outlet.id }]);
  });

  test('resume by counter staff is refused', async () => {
    const outlet = await makeLiveOutlet({ pausedUntil: until });
    expect((await call('POST', `/vendor/outlets/${outlet.id}/resume`, (await staffAt(outlet, 'counter')).id)).status).toBe(403);
  });
});

describe('PATCH /vendor/outlets/:id/settings', () => {
  const save = (outletId: string, userId: string, body: unknown) =>
    call('PATCH', `/vendor/outlets/${outletId}/settings`, userId, body);

  test('edits a live outlet, audited', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await owns(outlet.brandId);
    const [area] = await db.select().from(areas).limit(1);
    const body = {
      openingHours: { mon: [['09:00', '21:00']] },
      address: '1 New Road',
      pincode: '560002',
      areaId: area!.id,
      mapsUrl: 'https://maps.app.goo.gl/xyz',
      pickupInstructions: 'Ring the bell',
      contactPhone: '9876543210',
      photoKeys: [`photos/${owner.id}/a.jpg`],
    };

    const { status, json } = await save(outlet.id, owner.id, body);

    expect(status).toBe(200);
    expect(json.outlet).toMatchObject({ ...body, contactPhone: '+919876543210', status: 'live' });
    expect(await auditRows('outlet.settings')).toMatchObject([
      { actorId: owner.id, entityId: outlet.id, detail: { fields: Object.keys(body) } },
    ]);
  });

  test('applies the onboarding checks', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await owns(outlet.brandId);
    for (const body of [
      { pincode: '12' },
      { mapsUrl: 'https://example.com/maps' },
      { contactPhone: '12' },
      { openingHours: { mon: [['25:00', '21:00']] } },
      { photoKeys: ['photos/someone-else/a.jpg'] },
      { areaId: '00000000-0000-4000-8000-000000000000' },
      { areaId: 'nope' },
    ]) {
      expect((await save(outlet.id, owner.id, body)).status).toBe(400);
    }
  });

  test('keeps to its list: the legal details are not editable here', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await owns(outlet.brandId);
    for (const body of [{ fssaiNumber: '12345678901234' }, { branchName: 'New' }, { payoutAccountId: outlet.payoutAccountId }]) {
      expect((await save(outlet.id, owner.id, body)).status).toBe(400);
    }
  });

  test('a manager may, counter staff may not', async () => {
    const outlet = await makeLiveOutlet();
    expect((await save(outlet.id, (await staffAt(outlet, 'manager')).id, { address: 'x' })).status).toBe(200);
    expect((await save(outlet.id, (await staffAt(outlet, 'counter')).id, { address: 'x' })).status).toBe(403);
  });

  test('is for live outlets', async () => {
    const outlet = await makeLiveOutlet({ status: 'draft' });
    const { status, json } = await save(outlet.id, (await owns(outlet.brandId)).id, { address: 'x' });
    expect(status).toBe(409);
    expect(json.error.code).toBe('outlet_not_live');
  });

  test('photos already on the outlet stay valid', async () => {
    const outlet = await makeLiveOutlet({ photoKeys: ['photos/someone-else/a.jpg'] });
    const owner = await owns(outlet.brandId);
    expect((await save(outlet.id, owner.id, { photoKeys: ['photos/someone-else/a.jpg'] })).status).toBe(200);
  });
});

describe('franchise switch', () => {
  const patch = async (outletId: string, payoutAccountId: unknown) =>
    call('PATCH', `/admin/outlets/${outletId}`, (await admin()).id, { payoutAccountId });

  test('moves the outlet to a verified account of the brand, and orders keep their snapshot', async () => {
    const outlet = await makeLiveOutlet();
    const order = await makeOrder({ dropId: (await makeDrop({ outletId: outlet.id })).id, status: 'paid' });
    const next = await makePayoutAccount({ brandId: outlet.brandId });

    expect((await patch(outlet.id, next.id)).status).toBe(200);

    const [row] = await db.select().from(outlets).where(eq(outlets.id, outlet.id));
    expect(row!.payoutAccountId).toBe(next.id);
    expect((await getOrderRow(order.id)).payoutAccountId).toBe(outlet.payoutAccountId);
    expect(await auditRows('outlet.admin_update')).toMatchObject([
      { detail: { payoutAccountId: { from: outlet.payoutAccountId, to: next.id } } },
    ]);
  });

  test('refuses another brand, an unverified account and an unknown one', async () => {
    const outlet = await makeLiveOutlet();
    expect((await patch(outlet.id, (await makePayoutAccount()).id)).status).toBe(400);
    const pending = await makePayoutAccount({ brandId: outlet.brandId, status: 'pending' });
    const refused = await patch(outlet.id, pending.id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('payout_account_unverified');
    expect((await patch(outlet.id, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await patch(outlet.id, 'nope')).status).toBe(400);
    const [row] = await db.select().from(outlets).where(eq(outlets.id, outlet.id));
    expect(row!.payoutAccountId).toBe(outlet.payoutAccountId);
  });

  test('moving brand and account together takes an account of the new brand, and leaves the old one behind', async () => {
    const outlet = await makeLiveOutlet();
    const next = await makePayoutAccount();
    const { status } = await call('PATCH', `/admin/outlets/${outlet.id}`, (await admin()).id, { brandId: next.brandId, payoutAccountId: next.id });

    expect(status).toBe(200);
    const [row] = await db.select().from(outlets).where(eq(outlets.id, outlet.id));
    expect(row).toMatchObject({ brandId: next.brandId, payoutAccountId: next.id });
    const [old] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, outlet.payoutAccountId!));
    expect(old!.brandId).toBe(outlet.brandId);
  });
});

describe('franchisee earnings', () => {
  const add = (outletId: string, userId: string, body: Record<string, unknown>) =>
    call('POST', `/vendor/outlets/${outletId}/staff`, userId, { phone: '9812345678', name: 'Franchisee', role: 'manager', ...body });

  test('a manager added with an account can read its earnings', async () => {
    const outlet = await makeLiveOutlet();
    const account = await makePayoutAccount({ brandId: outlet.brandId });
    const owner = await owns(outlet.brandId);

    const { status, json } = await add(outlet.id, owner.id, { payoutAccountId: account.id });

    expect(status).toBe(200);
    expect(json.membership).toMatchObject({ role: 'manager', payoutAccountId: account.id });
    expect((await call('GET', `/vendor/earnings?payout_account=${account.id}`, json.membership.userId as string)).status).toBe(200);
    expect(await auditRows('staff.add')).toMatchObject([{ detail: { payoutAccountId: account.id } }]);
  });

  test('only a manager can have one', async () => {
    const outlet = await makeLiveOutlet();
    const account = await makePayoutAccount({ brandId: outlet.brandId });
    const owner = await owns(outlet.brandId);
    expect((await add(outlet.id, owner.id, { role: 'counter', payoutAccountId: account.id })).status).toBe(400);
  });

  test('the account must be the brand own', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await owns(outlet.brandId);
    expect((await add(outlet.id, owner.id, { payoutAccountId: (await makePayoutAccount()).id })).status).toBe(400);
    expect((await add(outlet.id, owner.id, { payoutAccountId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
  });

  test('a manager cannot do this', async () => {
    const outlet = await makeLiveOutlet();
    const account = await makePayoutAccount({ brandId: outlet.brandId });
    const manager = await staffAt(outlet, 'manager');
    expect((await add(outlet.id, manager.id, { payoutAccountId: account.id })).status).toBe(403);
  });
});

describe('POST /admin/orders/:id/cancel', () => {
  const cancel = async (orderId: string, body: unknown, userId?: string) =>
    call('POST', `/admin/orders/${orderId}/cancel`, userId ?? (await admin()).id, body);

  async function paid(transfer = 'none') {
    const drop = await makeDrop({ reservedCount: 1 });
    const order = await makePaidOrder({ dropId: drop.id, userId: (await makeUser()).id });
    await db.update(orders).set({ pickupCode: 'K472' }).where(eq(orders.id, order.id));
    await db
      .update(payments)
      .set({ transferStatus: transfer, razorpayTransferId: transfer === 'none' ? null : `trf_${order.id}` })
      .where(eq(payments.orderId, order.id));
    return { drop, order };
  }

  test('cancels, refunds whoever is charged, returns stock, and keeps the code dead', async () => {
    const { drop, order } = await paid();
    const adminUser = await admin();

    const { status } = await cancel(order.id, { reason: 'Food safety report', chargedTo: 'platform' }, adminUser.id);

    expect(status).toBe(200);
    expect(await getOrderRow(order.id)).toMatchObject({ status: 'cancelled', cancelledBy: adminUser.id, cancelReason: 'Food safety report' });
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    expect(await refundsFor(order.id)).toMatchObject([
      { reason: 'vendor_cancelled', chargedTo: 'platform', createdBy: adminUser.id, amountPaise: 10000, reverseTransfer: false },
    ]);
    expect(await auditRows('order.cancel')).toMatchObject([{ actorId: adminUser.id, detail: { chargedTo: 'platform' } }]);

    const staff = await owns((await db.select().from(outlets).where(eq(outlets.id, drop.outletId)))[0]!.brandId);
    const collected = await call('POST', `/vendor/outlets/${drop.outletId}/collect`, staff.id, { code: 'K472' });
    expect(collected.json.error.code).toBe('code_not_found');
  });

  test('a vendor-charged cancel reverses a held transfer, a platform-charged one does not', async () => {
    const vendor = await paid('on_hold');
    await cancel(vendor.order.id, { reason: 'x', chargedTo: 'vendor' });
    expect((await refundsFor(vendor.order.id))[0]).toMatchObject({ chargedTo: 'vendor', reverseTransfer: true });

    const platform = await paid('on_hold');
    await cancel(platform.order.id, { reason: 'x', chargedTo: 'platform' });
    expect((await refundsFor(platform.order.id))[0]).toMatchObject({ chargedTo: 'platform', reverseTransfer: false });
  });

  test('only a paid order, with a reason and who pays', async () => {
    const { order } = await paid();
    expect((await cancel(order.id, { chargedTo: 'vendor' })).status).toBe(400);
    expect((await cancel(order.id, { reason: ' ', chargedTo: 'vendor' })).status).toBe(400);
    expect((await cancel(order.id, { reason: 'x', chargedTo: 'nobody' })).status).toBe(400);
    expect((await cancel('nope', { reason: 'x', chargedTo: 'vendor' })).status).toBe(404);

    await db.update(orders).set({ status: 'collected' }).where(eq(orders.id, order.id));
    const { status, json } = await cancel(order.id, { reason: 'x', chargedTo: 'vendor' });
    expect(status).toBe(409);
    expect(json.error.code).toBe('not_cancellable');
  });

  test('is for admins', async () => {
    const { order } = await paid();
    expect((await cancel(order.id, { reason: 'x', chargedTo: 'vendor' }, (await makeUser()).id)).status).toBe(403);
  });
});

describe('POST /admin/issues/:id/resolve', () => {
  async function issueOn(status = 'collected') {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, status });
    const [issue] = await db.insert(issues).values({ orderId: order.id, userId: user.id, reason: 'quality' }).returning();
    return { issue: issue!, order };
  }
  const resolve = async (id: string, body: unknown, userId?: string) =>
    call('POST', `/admin/issues/${id}/resolve`, userId ?? (await admin()).id, body);

  test('closes an issue with a note and no refund, audited', async () => {
    const { issue, order } = await issueOn();
    const adminUser = await admin();

    expect((await resolve(issue.id, { resolution: 'Spoke to the customer' }, adminUser.id)).status).toBe(200);

    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row).toMatchObject({ status: 'resolved', resolution: 'Spoke to the customer', resolvedBy: adminUser.id });
    expect(await refundsFor(order.id)).toEqual([]);
    expect(await auditRows('issue.resolve')).toMatchObject([{ actorId: adminUser.id, entityId: issue.id }]);
  });

  test('a new issue on a refunded order can be closed this way', async () => {
    const drop = await makeDrop();
    const user = await makeUser();
    const order = await makePaidOrder({ dropId: drop.id, userId: user.id, status: 'collected' });
    await adminRefund((await admin()).id, order.id, { amountPaise: 10000, chargedTo: 'platform' }, NOW);
    const [issue] = await db.insert(issues).values({ orderId: order.id, userId: user.id, reason: 'other' }).returning();

    expect((await resolve(issue!.id, { resolution: 'Already refunded' })).status).toBe(200);
  });

  test('an issue closes once, and needs a note', async () => {
    const { issue } = await issueOn();
    expect((await resolve(issue.id, { resolution: ' ' })).status).toBe(400);
    expect((await resolve(issue.id, {})).status).toBe(400);
    await resolve(issue.id, { resolution: 'Done' });
    const again = await resolve(issue.id, { resolution: 'Again' });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('issue_resolved');
  });

  test('an unknown issue is a 404, and it is for admins', async () => {
    const { issue } = await issueOn();
    expect((await resolve('nope', { resolution: 'x' })).status).toBe(404);
    expect((await resolve('00000000-0000-4000-8000-000000000000', { resolution: 'x' })).status).toBe(404);
    expect((await resolve(issue.id, { resolution: 'x' }, (await makeUser()).id)).status).toBe(403);
  });
});

describe('bank name mismatch', () => {
  const details = (holderName: string) => ({
    legalName: 'Butterfold Foods Private Limited',
    pan: 'ABCDE1234F',
    holderName,
    accountNumber: '123456789012',
    ifsc: 'HDFC0000001',
  });
  const create = async (holderName: string, ownerName = 'Asha Rao') => {
    const brand = await makeBrand();
    const owner = await makeUser({ name: ownerName });
    await db.insert(memberships).values({ userId: owner.id, brandId: brand.id, role: 'owner' });
    return call('POST', '/vendor/payout-accounts', owner.id, { brandId: brand.id, ...details(holderName) });
  };

  test('warns when the holder matches neither the legal name nor the owner, and still saves', async () => {
    const { status, json } = await create('Someone Else');
    expect(status).toBe(200);
    expect(json.payoutAccount).toMatchObject({ holderName: 'Someone Else', nameWarning: true });
  });

  test('a match on either, in any case and spacing, does not warn', async () => {
    for (const name of ['Butterfold Foods Private Limited', 'BUTTERFOLD  foods private   limited', 'Asha Rao', '  asha   RAO ']) {
      expect((await create(name)).json.payoutAccount.nameWarning).toBe(false);
    }
  });
});
