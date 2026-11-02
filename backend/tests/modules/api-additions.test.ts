import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { areas, auditLog, memberships, notifications, orders } from '../../src/db/schema.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { env } from '../../src/lib/env.js';
import { decideOutlet } from '../../src/modules/admin/review.js';
import { createSession } from '../../src/modules/auth/session.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { app } from '../../src/app.js';
import { makeBrand, makeDrop, makeLiveOutlet, makeOrder, makePayment, makePayoutAccount, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

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
