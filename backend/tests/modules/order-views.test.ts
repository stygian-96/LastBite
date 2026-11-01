import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { payments, refunds } from '../../src/db/schema.js';
import { ApiError } from '../../src/lib/errors.js';
import { signAnonId } from '../../src/lib/crypto.js';
import { createSession } from '../../src/modules/auth/session.js';
import { generatePickupCode } from '../../src/modules/orders/code.js';
import { getOrder, listMyOrders } from '../../src/modules/orders/views.js';
import { app } from '../../src/app.js';
import { makeDrop, makeOrder, makePaidOrder, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-02. Default drops pick up 19:00-21:00 IST.
const NOW = new Date('2026-11-02T10:00:00Z');
const AFTER_PICKUP = new Date('2026-11-02T16:00:00Z');

beforeEach(resetDb);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

async function refundFor(orderId: string, o: Partial<typeof refunds.$inferInsert> = {}) {
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId));
  await db.insert(refunds).values({
    orderId,
    paymentId: payment!.id,
    amountPaise: 10000,
    reason: 'vendor_cancelled',
    chargedTo: 'vendor',
    ...o,
  });
}

describe('pickup code', () => {
  test('code is one letter and three digits, never I or O', () => {
    for (let i = 0; i < 5000; i++) expect(generatePickupCode()).toMatch(/^[A-HJ-NP-Z]\d{3}$/);
  });

  test('code uses the random source it is given', () => {
    expect(generatePickupCode(() => 0)).toBe('A000');
    expect(generatePickupCode(() => 0.999999)).toBe('Z999');
  });
});

describe('getOrder', () => {
  test('owner sees the full view, with the number formatted and no payout fields', async () => {
    const user = await makeUser();
    const order = await makePaidOrder({ userId: user.id, pickupCode: 'K482' });
    const view = await getOrder({ userId: user.id }, order.id);
    expect(view).toMatchObject({
      id: order.id,
      number: `SJ-${order.number}`,
      status: 'paid',
      pricePaise: 10000,
      valuePaise: 30000,
      type: 'surprise_bag',
      diet: 'veg',
      allergens: [],
      pickupCode: 'K482',
      refund: null,
    });
    expect(view.brandName).toBeTruthy();
    expect(view.branchName).toBeTruthy();
    expect(view.pickupStartAt).toBeTruthy();
    expect(view.holdExpiresAt).toBeTruthy();
    for (const k of ['commissionPaise', 'commissionBps', 'payoutId', 'taxPaise']) {
      expect(Object.keys(view)).not.toContain(k);
    }
  });

  test('another customer gets 404 for my order', async () => {
    const mine = await makeUser();
    const other = await makeUser();
    const order = await makePaidOrder({ userId: mine.id });
    expect(await failure(getOrder({ userId: other.id }, order.id))).toMatchObject({ code: 'not_found', status: 404 });
    expect(await failure(getOrder({}, order.id))).toMatchObject({ status: 404 });
  });

  test('unknown or malformed id is 404', async () => {
    const user = await makeUser();
    expect(await failure(getOrder({ userId: user.id }, '00000000-0000-4000-8000-000000000000'))).toMatchObject({
      status: 404,
    });
    expect(await failure(getOrder({ userId: user.id }, 'nope'))).toMatchObject({ status: 404 });
  });

  test('an anonymous holder sees their own order, and nobody else does', async () => {
    const order = await makeOrder({ userId: null, anonId: 'anon-1' });
    expect((await getOrder({ anonId: 'anon-1' }, order.id)).id).toBe(order.id);
    expect(await failure(getOrder({ anonId: 'anon-2' }, order.id))).toMatchObject({ status: 404 });
  });

  test('pickup code is hidden until paid', async () => {
    const user = await makeUser();
    const held = await makeOrder({ userId: user.id, pickupCode: 'K482' });
    expect((await getOrder({ userId: user.id }, held.id)).pickupCode).toBeNull();
    for (const status of ['expired', 'cancelled', 'no_show']) {
      const o = await makeOrder({ userId: user.id, status, pickupCode: 'K483' });
      expect((await getOrder({ userId: user.id }, o.id)).pickupCode).toBeNull();
    }
    const paid = await makePaidOrder({ userId: user.id, pickupCode: 'K484' });
    expect((await getOrder({ userId: user.id }, paid.id)).pickupCode).toBe('K484');
    const collected = await makePaidOrder({ userId: user.id, status: 'collected', pickupCode: 'K485' });
    expect((await getOrder({ userId: user.id }, collected.id)).pickupCode).toBe('K485');
  });

  test('refund summary is included', async () => {
    const user = await makeUser();
    const order = await makePaidOrder({ userId: user.id, status: 'cancelled' });
    await refundFor(order.id, { status: 'processed' });
    expect((await getOrder({ userId: user.id }, order.id)).refund).toEqual({ status: 'processed', amountPaise: 10000 });
  });
});

describe('listMyOrders', () => {
  test('active excludes refunds and past orders', async () => {
    const user = await makeUser();
    const held = await makeOrder({ userId: user.id });
    const paid = await makePaidOrder({ userId: user.id });
    const collected = await makePaidOrder({ userId: user.id, status: 'collected' });
    const cancelled = await makePaidOrder({ userId: user.id, status: 'cancelled' });
    await refundFor(cancelled.id);
    const expired = await makeOrder({ userId: user.id, status: 'expired' });
    const noShow = await makePaidOrder({ userId: user.id, status: 'no_show' });
    const closedDrop = await makeDrop({
      serviceDate: '2026-11-01',
      pickupStartAt: '2026-11-01T19:00:00+05:30',
      pickupEndAt: '2026-11-01T21:00:00+05:30',
      salesEndAt: '2026-11-01T20:45:00+05:30',
    });
    const closed = await makePaidOrder({ userId: user.id, dropId: closedDrop.id, outletId: closedDrop.outletId });
    const someoneElse = await makePaidOrder({ userId: (await makeUser()).id });

    const active = (await listMyOrders(user.id, 'active', NOW)).map((o) => o.id).sort();
    expect(active).toEqual([held.id, paid.id].sort());

    const past = await listMyOrders(user.id, 'past', NOW);
    const pastIds = past.map((o) => o.id).sort();
    expect(pastIds).toEqual([collected.id, cancelled.id, expired.id, noShow.id, closed.id].sort());
    expect(pastIds).not.toContain(someoneElse.id);
    expect(past.find((o) => o.id === cancelled.id)?.refund).toEqual({ status: 'pending', amountPaise: 10000 });
  });

  test('a paid order moves to past once pickup has closed', async () => {
    const user = await makeUser();
    const paid = await makePaidOrder({ userId: user.id });
    expect((await listMyOrders(user.id, 'active', NOW)).map((o) => o.id)).toEqual([paid.id]);
    expect(await listMyOrders(user.id, 'active', AFTER_PICKUP)).toEqual([]);
    expect((await listMyOrders(user.id, 'past', AFTER_PICKUP)).map((o) => o.id)).toEqual([paid.id]);
  });
});

describe('order routes', () => {
  test('GET /orders/:id works with the session cookie or the signed anon cookie', async () => {
    const user = await makeUser();
    const token = await createSession(user.id, new Date());
    const mine = await makePaidOrder({ userId: user.id });
    const anon = await makeOrder({ userId: null, anonId: 'anon-xyz' });

    const bySession = await app.request(`/api/v1/orders/${mine.id}`, { headers: { cookie: `session=${token}` } });
    expect(bySession.status).toBe(200);
    expect(((await bySession.json()) as { order: { id: string } }).order.id).toBe(mine.id);

    const byAnon = await app.request(`/api/v1/orders/${anon.id}`, {
      headers: { cookie: `anon_id=${signAnonId('anon-xyz')}` },
    });
    expect(byAnon.status).toBe(200);

    const forged = await app.request(`/api/v1/orders/${anon.id}`, { headers: { cookie: 'anon_id=anon-xyz.forged' } });
    expect(forged.status).toBe(404);
    expect((await app.request(`/api/v1/orders/${anon.id}`)).status).toBe(404);
    const stranger = await createSession((await makeUser()).id, new Date());
    expect(
      (await app.request(`/api/v1/orders/${mine.id}`, { headers: { cookie: `session=${stranger}` } })).status,
    ).toBe(404);
  });

  test('GET /me/orders needs sign-in and validates status', async () => {
    expect((await app.request('/api/v1/me/orders?status=active')).status).toBe(401);
    const user = await makeUser();
    const token = await createSession(user.id, new Date());
    const order = await makePaidOrder({ userId: user.id, status: 'collected' });
    const headers = { cookie: `session=${token}` };
    const past = await app.request('/api/v1/me/orders?status=past', { headers });
    expect(past.status).toBe(200);
    expect(((await past.json()) as { orders: { id: string }[] }).orders.map((o) => o.id)).toEqual([order.id]);
    expect((await app.request('/api/v1/me/orders?status=bogus', { headers })).status).toBe(400);
    expect((await app.request('/api/v1/me/orders', { headers })).status).toBe(400);
  });
});
