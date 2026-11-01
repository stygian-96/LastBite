import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { auditLog, memberships, orders, outlets, payouts, rateLimits } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { createSession } from '../../src/modules/auth/session.js';
import { collectByCode, collectOrder } from '../../src/modules/pickup/collect.js';
import { autoMarkNoShows, markNoShow } from '../../src/modules/pickup/no-show.js';
import { listOutletOrders } from '../../src/modules/pickup/list.js';
import { app } from '../../src/app.js';
import { makeDrop, makePaidOrder, makeUser } from '../helpers/factories.js';
import { getOrderRow, resetDb } from '../helpers/db.js';

// 19:30 IST on 2026-11-02, inside the default 19:00-21:00 IST pickup window.
const now = new Date('2026-11-02T14:00:00Z');
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
// Default pickup ends 21:00 IST = 15:30Z.
const PICKUP_END = new Date('2026-11-02T15:30:00Z');

beforeEach(resetDb);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

async function staffOf(outletId: string, role: 'owner' | 'manager' | 'counter' = 'counter') {
  const [outlet] = await db.select({ brandId: outlets.brandId }).from(outlets).where(eq(outlets.id, outletId));
  const user = await makeUser();
  await db
    .insert(memberships)
    .values({ userId: user.id, brandId: outlet!.brandId, outletId: role === 'owner' ? null : outletId, role });
  return user;
}

/** A paid order with a known code on a fresh drop, and a counter staffer at its outlet. */
async function setup(code = 'K472', dropOptions: Parameters<typeof makeDrop>[0] = {}, orderName?: string) {
  const drop = await makeDrop(dropOptions);
  const customer = await makeUser(orderName ? { name: orderName } : {});
  const order = await makePaidOrder({ dropId: drop.id, pickupCode: code, userId: customer.id });
  const staff = await staffOf(drop.outletId);
  return { drop, order, staff, customer };
}

describe('collectByCode', () => {
  test('valid code marks collected and records staff', async () => {
    const { order, staff, drop } = await setup();
    const view = await collectByCode(staff.id, drop.outletId, 'K472', now);
    expect(view).toMatchObject({ id: order.id, status: 'collected', pickupCode: 'K472' });
    const row = await getOrderRow(order.id);
    expect(row.status).toBe('collected');
    expect(row.collectedBy).toBe(staff.id);
    expect(new Date(row.collectedAt!).getTime()).toBe(now.getTime());
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, order.id));
    expect(audits.map((a) => a.action)).toContain('order.collect');
  });

  test('parallel collect succeeds once', async () => {
    const { staff, drop } = await setup();
    const other = await staffOf(drop.outletId);
    const results = await Promise.all([
      failure(collectByCode(staff.id, drop.outletId, 'K472', now)),
      failure(collectByCode(other.id, drop.outletId, 'K472', now)),
    ]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    const losers = results.filter((r) => r !== undefined);
    expect(losers[0]).toMatchObject({ status: 409, code: 'already_collected' });
  });

  test('wrong code returns 404 code_not_found', async () => {
    const { staff, drop } = await setup();
    expect(await failure(collectByCode(staff.id, drop.outletId, 'Z999', now))).toMatchObject({
      status: 404,
      code: 'code_not_found',
    });
    expect(await failure(collectByCode(staff.id, drop.outletId, '', now))).toMatchObject({ code: 'code_not_found' });
  });

  test('already collected returns 409 with collected_at', async () => {
    const { staff, drop } = await setup();
    await collectByCode(staff.id, drop.outletId, 'K472', now);
    const err = await failure(collectByCode(staff.id, drop.outletId, 'K472', minutes(now, 5)));
    expect(err).toMatchObject({ status: 409, code: 'already_collected' });
    expect(err!.details).toEqual({ collectedAt: expect.any(String) });
    expect(new Date(err!.details!.collectedAt as string).getTime()).toBe(now.getTime());
  });

  test('code from another branch returns 404', async () => {
    const { drop } = await setup();
    const other = await makeDrop();
    const otherStaff = await staffOf(other.outletId);
    expect(await failure(collectByCode(otherStaff.id, other.outletId, 'K472', now))).toMatchObject({
      status: 404,
      code: 'code_not_found',
    });
    // And a staffer of another branch cannot use this branch at all.
    expect(await failure(collectByCode(otherStaff.id, drop.outletId, 'K472', now))).toMatchObject({ status: 403 });
  });

  test('eleventh wrong try in a minute returns 429', async () => {
    const { staff, drop } = await setup();
    for (let i = 0; i < 10; i++) {
      expect(await failure(collectByCode(staff.id, drop.outletId, 'Z999', now))).toMatchObject({ status: 404 });
    }
    expect(await failure(collectByCode(staff.id, drop.outletId, 'Z999', now))).toMatchObject({ status: 429 });
    // Even the right code waits out the minute, then works again.
    expect(await failure(collectByCode(staff.id, drop.outletId, 'K472', now))).toMatchObject({ status: 429 });
    expect((await collectByCode(staff.id, drop.outletId, 'K472', minutes(now, 1))).status).toBe('collected');
  });

  test('a correct code never costs quota', async () => {
    const { staff, drop } = await setup();
    await collectByCode(staff.id, drop.outletId, 'K472', now);
    const rows = await db.select().from(rateLimits).where(eq(rateLimits.key, `collect:${staff.id}`));
    expect(rows).toHaveLength(0);
    // Repeating a used code is not a wrong try either.
    for (let i = 0; i < 12; i++) {
      expect(await failure(collectByCode(staff.id, drop.outletId, 'K472', now))).toMatchObject({
        code: 'already_collected',
      });
    }
  });

  test('code is case-insensitive', async () => {
    const { order, staff, drop } = await setup();
    await collectByCode(staff.id, drop.outletId, ' k472 ', now);
    expect((await getOrderRow(order.id)).status).toBe('collected');
  });

  test('collect at 00:20 IST finds a window that began last night', async () => {
    const drop = await makeDrop({
      serviceDate: '2026-11-01',
      pickupStartAt: new Date('2026-11-01T17:30:00Z').toISOString(),
      pickupEndAt: new Date('2026-11-01T19:00:00Z').toISOString(),
    });
    const o = await makePaidOrder({ dropId: drop.id, pickupCode: 'K472' });
    const staff = await staffOf(drop.outletId);
    await collectByCode(staff.id, drop.outletId, 'K472', new Date('2026-11-01T18:50:00Z'));
    expect((await getOrderRow(o.id)).status).toBe('collected');
  });

  test('a window closed more than 30 minutes ago no longer matches', async () => {
    const { staff, drop } = await setup();
    expect(await failure(collectByCode(staff.id, drop.outletId, 'K472', minutes(PICKUP_END, 31)))).toMatchObject({
      code: 'code_not_found',
    });
    expect((await collectByCode(staff.id, drop.outletId, 'K472', minutes(PICKUP_END, 29))).status).toBe('collected');
  });

  test('all three roles can collect', async () => {
    for (const role of ['owner', 'manager', 'counter'] as const) {
      await resetDb();
      const { drop } = await setup();
      const staff = await staffOf(drop.outletId, role);
      expect((await collectByCode(staff.id, drop.outletId, 'K472', now)).status).toBe('collected');
    }
  });

  test('suspended outlet can still collect paid orders', async () => {
    const { order, staff, drop } = await setup();
    await db.update(outlets).set({ status: 'suspended' }).where(eq(outlets.id, drop.outletId));
    await collectByCode(staff.id, drop.outletId, 'K472', now);
    expect((await getOrderRow(order.id)).status).toBe('collected');
  });

  test('cancelled and no-show orders are not found by code', async () => {
    const { order, staff, drop } = await setup();
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, order.id));
    expect(await failure(collectByCode(staff.id, drop.outletId, 'K472', now))).toMatchObject({
      code: 'code_not_found',
    });
  });
});

describe('no-show', () => {
  test('autoMarkNoShows waits 30 minutes past pickup end', async () => {
    const { order } = await setup();
    expect(await autoMarkNoShows(minutes(PICKUP_END, 29))).toBe(0);
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect(await autoMarkNoShows(minutes(PICKUP_END, 31))).toBe(1);
    expect((await getOrderRow(order.id)).status).toBe('no_show');
    // Safe to run twice.
    expect(await autoMarkNoShows(minutes(PICKUP_END, 31))).toBe(0);
  });

  test('autoMarkNoShows leaves collected and other statuses alone', async () => {
    const { order, staff, drop } = await setup();
    await collectByCode(staff.id, drop.outletId, 'K472', now);
    const cancelled = await makePaidOrder({ dropId: drop.id, pickupCode: 'M111', status: 'cancelled' });
    expect(await autoMarkNoShows(minutes(PICKUP_END, 90))).toBe(0);
    expect((await getOrderRow(order.id)).status).toBe('collected');
    expect((await getOrderRow(cancelled.id)).status).toBe('cancelled');
  });

  test('autoMarkNoShows handles more than one batch', async () => {
    const drop = await makeDrop();
    for (let i = 0; i < 3; i++) await makePaidOrder({ dropId: drop.id, pickupCode: `A10${i}` });
    expect(await autoMarkNoShows(minutes(PICKUP_END, 31))).toBe(3);
  });

  test('markNoShow is allowed only from paid and only after pickup ends', async () => {
    const { order, staff } = await setup();
    expect(await failure(markNoShow(staff.id, order.id, now))).toMatchObject({
      status: 409,
      code: 'pickup_not_ended',
    });
    await markNoShow(staff.id, order.id, minutes(PICKUP_END, 1));
    expect((await getOrderRow(order.id)).status).toBe('no_show');
    expect(await failure(markNoShow(staff.id, order.id, minutes(PICKUP_END, 2)))).toMatchObject({ status: 409 });
  });

  test('markNoShow refuses a stranger and an unknown order', async () => {
    const { order } = await setup();
    const stranger = await makeUser();
    expect(await failure(markNoShow(stranger.id, order.id, minutes(PICKUP_END, 1)))).toMatchObject({ status: 403 });
    expect(await failure(markNoShow(stranger.id, 'nope', now))).toMatchObject({ status: 404 });
  });

  test('no-show can be corrected to collected until payout approval', async () => {
    const { order, staff } = await setup();
    await autoMarkNoShows(minutes(PICKUP_END, 31));
    const view = await collectOrder(staff.id, order.id, minutes(PICKUP_END, 60));
    expect(view.status).toBe('collected');
    const row = await getOrderRow(order.id);
    expect(row.collectedBy).toBe(staff.id);
    expect(row.collectedAt).not.toBeNull();
  });

  test('a draft payout still allows correction, a released one does not', async () => {
    const { order, staff, drop } = await setup();
    await db.update(orders).set({ status: 'no_show' }).where(eq(orders.id, order.id));
    const [outlet] = await db.select().from(outlets).where(eq(outlets.id, drop.outletId));
    const [payout] = await db
      .insert(payouts)
      .values({
        payoutAccountId: outlet!.payoutAccountId!,
        periodStart: '2026-10-26',
        periodEnd: '2026-11-01',
        grossPaise: 10000,
        commissionPaise: 2000,
        feesPaise: 0,
        netPaise: 8000,
        status: 'released',
      })
      .returning();
    await db.update(orders).set({ payoutId: payout!.id }).where(eq(orders.id, order.id));
    expect(await failure(collectOrder(staff.id, order.id, now))).toMatchObject({ status: 409 });
    expect((await getOrderRow(order.id)).status).toBe('no_show');

    await db.update(payouts).set({ status: 'draft' }).where(eq(payouts.id, payout!.id));
    expect((await collectOrder(staff.id, order.id, now)).status).toBe('collected');
  });

  test('collectOrder on a collected order is 409 already_collected', async () => {
    const { order, staff, drop } = await setup();
    await collectByCode(staff.id, drop.outletId, 'K472', now);
    expect(await failure(collectOrder(staff.id, order.id, now))).toMatchObject({
      status: 409,
      code: 'already_collected',
    });
  });

  test('collectOrder refuses a stranger', async () => {
    const { order } = await setup();
    const stranger = await makeUser();
    expect(await failure(collectOrder(stranger.id, order.id, now))).toMatchObject({ status: 403 });
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });
});

describe('listOutletOrders', () => {
  test('search matches customer name', async () => {
    const { staff, drop } = await setup('K472', {}, 'Asha Kumar');
    const other = await makeUser({ name: 'Ravi Shah' });
    await makePaidOrder({ dropId: drop.id, pickupCode: 'M111', userId: other.id });
    const hit = await listOutletOrders(staff.id, drop.outletId, { q: 'asha' }, now);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ customerLabel: 'Asha K.', status: 'paid' });
    expect(await listOutletOrders(staff.id, drop.outletId, {}, now)).toHaveLength(2);
    expect(await listOutletOrders(staff.id, drop.outletId, { q: '100%' }, now)).toHaveLength(0);
  });

  test('vendor rows never contain phone', async () => {
    const { staff, drop, customer } = await setup('K472', {}, 'Asha Kumar');
    const rows = await listOutletOrders(staff.id, drop.outletId, {}, now);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(customer.phone);
    expect(json).not.toContain('phone');
  });

  test('customerLabel is first name plus last initial, with a fallback', async () => {
    const drop = await makeDrop();
    const staff = await staffOf(drop.outletId);
    const names = ['Asha Devi Kumar', 'Meera', '  ', null];
    for (const [i, name] of names.entries()) {
      const u = await makeUser({ name });
      await makePaidOrder({ dropId: drop.id, pickupCode: `B10${i}`, userId: u.id });
    }
    const labels = (await listOutletOrders(staff.id, drop.outletId, {}, now)).map((r) => r.customerLabel).sort();
    expect(labels).toEqual(['Asha K.', 'Customer', 'Customer', 'Meera']);
  });

  test('default date is the IST date and keeps a window still open past midnight', async () => {
    const drop = await makeDrop({
      serviceDate: '2026-11-01',
      pickupStartAt: new Date('2026-11-01T17:30:00Z').toISOString(),
      pickupEndAt: new Date('2026-11-01T19:00:00Z').toISOString(),
    });
    await makePaidOrder({ dropId: drop.id, pickupCode: 'K472' });
    const staff = await staffOf(drop.outletId);
    // 00:20 IST on 2 Nov: the 1 Nov window ended at 00:30 IST and is within its 30 minutes.
    const at = new Date('2026-11-01T18:50:00Z');
    expect(await listOutletOrders(staff.id, drop.outletId, {}, at)).toHaveLength(1);
    // Well after the grace, the default view is only today's.
    expect(await listOutletOrders(staff.id, drop.outletId, {}, new Date('2026-11-01T22:00:00Z'))).toHaveLength(0);
    // An explicit date shows that date, whatever the time.
    expect(await listOutletOrders(staff.id, drop.outletId, { date: '2026-11-01' }, new Date('2026-11-05T00:00:00Z')))
      .toHaveLength(1);
  });

  test('rejects a malformed date and a stranger', async () => {
    const { staff, drop } = await setup();
    expect(await failure(listOutletOrders(staff.id, drop.outletId, { date: '02-11-2026' }, now))).toMatchObject({
      status: 400,
    });
    const stranger = await makeUser();
    expect(await failure(listOutletOrders(stranger.id, drop.outletId, {}, now))).toMatchObject({ status: 403 });
  });
});

describe('vendor routes', () => {
  // Routes read the real clock, so the pickup window is built around it.
  const liveWindow = () => ({
    pickupStartAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    pickupEndAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, userId?: string) =>
    app.request(`/api/v1/vendor${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(userId
          ? { cookie: `session=${await createSession(userId, new Date())}`, origin: env().FRONTEND_ORIGIN }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('POST /outlets/:id/collect collects by code', async () => {
    const { order, staff, drop } = await setup('K472', liveWindow());
    expect((await call('POST', `/outlets/${drop.outletId}/collect`, { code: 'K472' })).status).toBe(401);
    expect((await call('POST', `/outlets/${drop.outletId}/collect`, {}, staff.id)).status).toBe(400);
    const miss = await call('POST', `/outlets/${drop.outletId}/collect`, { code: 'Z999' }, staff.id);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ error: { code: 'code_not_found' } });
    const ok = await call('POST', `/outlets/${drop.outletId}/collect`, { code: 'k472' }, staff.id);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: order.id, status: 'collected' });
  });

  test('already collected carries collectedAt in the envelope', async () => {
    const { staff, drop } = await setup('K472', liveWindow());
    await call('POST', `/outlets/${drop.outletId}/collect`, { code: 'K472' }, staff.id);
    const again = await call('POST', `/outlets/${drop.outletId}/collect`, { code: 'K472' }, staff.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: { code: 'already_collected', collectedAt: expect.any(String) },
    });
  });

  test('POST /orders/:id/collect and /no-show', async () => {
    const { order, staff, drop } = await setup('K472', liveWindow());
    expect((await call('POST', `/orders/${order.id}/no-show`, undefined, staff.id)).status).toBe(409);
    const ok = await call('POST', `/orders/${order.id}/collect`, undefined, staff.id);
    expect(ok.status).toBe(200);
    expect((await getOrderRow(order.id)).status).toBe('collected');
    expect(drop.id).toBeTruthy();
  });

  test('GET /outlets/:id/orders lists with q', async () => {
    const { staff, drop } = await setup('K472', liveWindow(), 'Asha Kumar');
    const res = await call('GET', `/outlets/${drop.outletId}/orders?q=asha&date=2026-11-02`, undefined, staff.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: { customerLabel: string }[] };
    expect(body.orders.map((o) => o.customerLabel)).toEqual(['Asha K.']);
    expect((await call('GET', `/outlets/${drop.outletId}/orders?date=bad`, undefined, staff.id)).status).toBe(400);
  });
});
