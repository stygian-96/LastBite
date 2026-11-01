import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool, withTx } from '../../src/db/client.js';
import { drops, orders, outlets } from '../../src/db/schema.js';
import { signAnonId, verifyAnonId } from '../../src/lib/crypto.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { FakeMessenger, setMessenger } from '../../src/integrations/messaging.js';
import { sendOtp } from '../../src/modules/auth/otp.js';
import { createSession } from '../../src/modules/auth/session.js';
import { expireHolds } from '../../src/modules/orders/expire.js';
import { attachHolds, releaseHold, releaseStock, reserveDrop } from '../../src/modules/orders/reserve.js';
import { getOrder } from '../../src/modules/orders/views.js';
import { app } from '../../src/app.js';
import { makeDrop, makeLiveOutlet, makeOrder, makePaidOrder, makeUser } from '../helpers/factories.js';
import { getDropRow, getOrderRow, resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-02. Default drops stop selling at 20:45 IST.
const now = new Date('2026-11-02T10:00:00Z');
const seconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const HOLD_SECONDS = 5 * 60;
const PHONE = '+919876543210';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

const heldCount = async (dropId: string) =>
  (await db.select().from(orders).where(and(eq(orders.dropId, dropId), eq(orders.status, 'held')))).length;

describe('reserveDrop', () => {
  test('20 parallel reserves on 5 bags give exactly 5 orders', async () => {
    const drop = await makeDrop({ quantity: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => reserveDrop({ dropId: drop.id, anonId: `a${i}`, ip: `1.1.1.${i}` }, now)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as ApiError).code)).toEqual(Array(15).fill('sold_out'));
    expect((await getDropRow(drop.id)).reservedCount).toBe(5);
    expect(await heldCount(drop.id)).toBe(5);
  });

  test('two parallel reserves on the last bag give one order', async () => {
    const drop = await makeDrop({ quantity: 1 });
    const results = await Promise.allSettled([
      reserveDrop({ dropId: drop.id, anonId: 'x', ip: '1.1.1.1' }, now),
      reserveDrop({ dropId: drop.id, anonId: 'y', ip: '1.1.1.2' }, now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('parallel reserves from one anon ID give one hold and take one bag', async () => {
    const drop = await makeDrop({ quantity: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => reserveDrop({ dropId: drop.id, anonId: 'same', ip: `1.1.1.${i}` }, now)),
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as ApiError).code)).toEqual(Array(5).fill('hold_exists'));
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    expect(await heldCount(drop.id)).toBe(1);
  });

  test('parallel reserves from one customer give one order and take one bag', async () => {
    const user = await makeUser();
    const drop = await makeDrop({ quantity: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => reserveDrop({ dropId: drop.id, userId: user.id, ip: `1.1.1.${i}` }, now)),
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as ApiError).code)).toEqual(Array(5).fill('already_ordered'));
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('commission and price are snapshotted on the order', async () => {
    const outlet = await makeLiveOutlet({ commissionBps: 1500 });
    const drop = await makeDrop({ outletId: outlet.id, pricePaise: 12345 });
    const order = await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    expect(order).toMatchObject({
      status: 'held',
      anonId: 'a',
      userId: null,
      outletId: outlet.id,
      serviceDate: drop.serviceDate,
      pricePaise: 12345,
      commissionBps: 1500,
      commissionPaise: 1852,
    });
    expect(new Date(order.holdExpiresAt).getTime()).toBe(seconds(now, HOLD_SECONDS).getTime());

    await db.update(outlets).set({ commissionBps: 3000 }).where(eq(outlets.id, outlet.id));
    await db.update(drops).set({ pricePaise: 99 }).where(eq(drops.id, drop.id));
    expect(await getOrderRow(order.id)).toMatchObject({ pricePaise: 12345, commissionBps: 1500, commissionPaise: 1852 });
  });

  test('a signed-in customer has user_id set immediately', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    expect(await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now)).toMatchObject({
      userId: user.id,
      anonId: null,
    });
  });

  test('paused, cancelled, past-sales and suspended outlet drops return 409', async () => {
    const paused = await makeDrop({ status: 'paused' });
    const cancelled = await makeDrop({ status: 'cancelled' });
    const pastSales = await makeDrop({ salesEndAt: seconds(now, -1).toISOString() });
    const atSalesEnd = await makeDrop({ salesEndAt: now.toISOString() });
    const suspended = await makeDrop({ outletId: (await makeLiveOutlet({ status: 'suspended' })).id });
    const onHoliday = await makeDrop({
      outletId: (await makeLiveOutlet({ pausedUntil: seconds(now, 3600).toISOString() })).id,
    });
    for (const drop of [paused, cancelled, pastSales, atSalesEnd, suspended, onHoliday]) {
      expect(await failure(reserveDrop({ dropId: drop.id, anonId: drop.id, ip: drop.id }, now))).toMatchObject({
        code: 'not_on_sale',
        status: 409,
      });
      expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    }
  });

  test('an outlet whose pause has ended sells again', async () => {
    const outlet = await makeLiveOutlet({ pausedUntil: seconds(now, -1).toISOString() });
    const drop = await makeDrop({ outletId: outlet.id });
    await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
  });

  test('no stock returns 409 sold_out, and an unknown drop 404', async () => {
    const drop = await makeDrop({ quantity: 1 });
    await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    expect(await failure(reserveDrop({ dropId: drop.id, anonId: 'b', ip: '1.1.1.1' }, now))).toMatchObject({
      code: 'sold_out',
      status: 409,
    });
    const unknown = reserveDrop({ dropId: '00000000-0000-4000-8000-000000000000', anonId: 'b', ip: '1.1.1.1' }, now);
    expect(await failure(unknown)).toMatchObject({ code: 'not_found', status: 404 });
  });

  test('second active hold for one anon ID returns 409 hold_exists', async () => {
    const first = await reserveDrop({ dropId: (await makeDrop()).id, anonId: 'a', ip: '1.1.1.1' }, now);
    const other = await makeDrop();
    const err = await failure(reserveDrop({ dropId: other.id, anonId: 'a', ip: '1.1.1.1' }, now));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'hold_exists', status: 409, details: { existingOrderId: first.id } });
    expect((await getDropRow(other.id)).reservedCount).toBe(0);
  });

  test('sixth signed-out hold in an hour from one IP returns 429', async () => {
    const drop = await makeDrop({ quantity: 10 });
    for (let i = 0; i < 5; i++) await reserveDrop({ dropId: drop.id, anonId: `a${i}`, ip: '9.9.9.9' }, now);
    expect(await failure(reserveDrop({ dropId: drop.id, anonId: 'a5', ip: '9.9.9.9' }, now))).toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    expect((await getDropRow(drop.id)).reservedCount).toBe(5);
    await reserveDrop({ dropId: drop.id, anonId: 'a5', ip: '9.9.9.8' }, now);
    await reserveDrop({ dropId: drop.id, anonId: 'a6', ip: '9.9.9.9' }, seconds(now, 3600));
  });

  test('refused attempts do not spend the IP quota', async () => {
    const soldOut = await makeDrop({ quantity: 1 });
    await reserveDrop({ dropId: soldOut.id, anonId: 'holder', ip: '9.9.9.9' }, now);
    const paused = await makeDrop({ status: 'paused' });
    for (let i = 0; i < 6; i++) {
      expect(await failure(reserveDrop({ dropId: soldOut.id, anonId: `t${i}`, ip: '9.9.9.9' }, now))).toMatchObject({
        code: 'sold_out',
      });
      expect(await failure(reserveDrop({ dropId: paused.id, anonId: `t${i}`, ip: '9.9.9.9' }, now))).toMatchObject({
        code: 'not_on_sale',
      });
      expect(await failure(reserveDrop({ dropId: paused.id, anonId: 'holder', ip: '9.9.9.9' }, now))).toMatchObject({
        code: 'hold_exists',
      });
    }
    const open = await makeDrop({ quantity: 10 });
    for (let i = 0; i < 4; i++) await reserveDrop({ dropId: open.id, anonId: `b${i}`, ip: '9.9.9.9' }, now);
    expect(await failure(reserveDrop({ dropId: open.id, anonId: 'b4', ip: '9.9.9.9' }, now))).toMatchObject({
      code: 'rate_limited',
    });
  });

  test('signed-in customers are exempt from the IP limit, and do not spend it', async () => {
    const user = await makeUser();
    for (let i = 0; i < 6; i++) await reserveDrop({ dropId: (await makeDrop()).id, userId: user.id, ip: '9.9.9.9' }, now);

    const drop = await makeDrop({ quantity: 10 });
    for (let i = 0; i < 5; i++) await reserveDrop({ dropId: drop.id, anonId: `a${i}`, ip: '9.9.9.9' }, now);
    await reserveDrop({ dropId: (await makeDrop()).id, userId: user.id, ip: '9.9.9.9' }, now);
  });

  test('signed-in customer with an order at that outlet gets 409 already_ordered', async () => {
    const user = await makeUser();
    const outlet = await makeLiveOutlet();
    const first = await makeDrop({ outletId: outlet.id });
    const second = await makeDrop({ outletId: outlet.id });
    const paid = await makePaidOrder({
      userId: user.id,
      dropId: first.id,
      outletId: outlet.id,
      serviceDate: first.serviceDate,
    });
    const err = await failure(reserveDrop({ dropId: second.id, userId: user.id, ip: '1.1.1.1' }, now));
    expect(err).toMatchObject({ code: 'already_ordered', status: 409, details: { existingOrderId: paid.id } });
    expect((await getDropRow(second.id)).reservedCount).toBe(0);
  });

  test('a customer holding the last bag is shown it rather than sold_out', async () => {
    const user = await makeUser();
    const drop = await makeDrop({ quantity: 1 });
    const held = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
    expect(await failure(reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now))).toMatchObject({
      code: 'already_ordered',
      details: { existingOrderId: held.id },
    });
  });

  test('an expired order does not block a new one', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
    await expireHolds(seconds(now, HOLD_SECONDS + 61));
    await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, seconds(now, HOLD_SECONDS + 62));
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });
});

describe('expireHolds', () => {
  test('expireHolds waits 60 seconds past hold_expires_at', async () => {
    const drop = await makeDrop();
    const order = await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    expect(await expireHolds(seconds(now, HOLD_SECONDS))).toBe(0);
    expect(await expireHolds(seconds(now, HOLD_SECONDS + 59))).toBe(0);
    expect((await getOrderRow(order.id)).status).toBe('held');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);

    expect(await expireHolds(seconds(now, HOLD_SECONDS + 61))).toBe(1);
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('expireHolds returns stock once when run twice', async () => {
    const drop = await makeDrop();
    await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    await reserveDrop({ dropId: drop.id, anonId: 'b', ip: '1.1.1.1' }, seconds(now, HOLD_SECONDS));
    const later = seconds(now, HOLD_SECONDS + 61);
    expect(await expireHolds(later)).toBe(1);
    expect(await expireHolds(later)).toBe(0);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('parallel runs return each hold once, across more holds than one batch', async () => {
    const drop = await makeDrop({ quantity: 130 });
    const expired = seconds(now, -120).toISOString();
    await db.update(drops).set({ reservedCount: 130 }).where(eq(drops.id, drop.id));
    await db.insert(orders).values(
      Array.from({ length: 130 }, (_, i) => ({
        anonId: `a${i}`,
        dropId: drop.id,
        outletId: drop.outletId,
        serviceDate: drop.serviceDate,
        pricePaise: 10000,
        commissionBps: 2000,
        commissionPaise: 2000,
        holdExpiresAt: expired,
      })),
    );
    const counts = await Promise.all([expireHolds(now), expireHolds(now), expireHolds(now)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(130);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('parallel batches meeting two drops in opposite order do not deadlock', async () => {
    const a = await makeDrop({ quantity: 100, reservedCount: 100 });
    const b = await makeDrop({ quantity: 100, reservedCount: 100 });
    // By expiry: 50 on a, 100 on b, 50 on a. The first batch meets a then b, the second b then a.
    const dropAt = (i: number) => (i < 50 || i >= 150 ? a : b);
    await db.insert(orders).values(
      Array.from({ length: 200 }, (_, i) => ({
        anonId: `a${i}`,
        dropId: dropAt(i).id,
        outletId: dropAt(i).outletId,
        serviceDate: a.serviceDate,
        pricePaise: 10000,
        commissionBps: 2000,
        commissionPaise: 2000,
        holdExpiresAt: seconds(now, -3600 + i).toISOString(),
      })),
    );
    const counts = await Promise.all([expireHolds(now), expireHolds(now)]);
    expect(counts[0]! + counts[1]!).toBe(200);
    expect((await getDropRow(a.id)).reservedCount).toBe(0);
    expect((await getDropRow(b.id)).reservedCount).toBe(0);
  });

  test('a batch holding back on a drop leaves a re-reserve free to finish', async () => {
    const user = await makeUser();
    const outlet = await makeLiveOutlet();
    const options = { outletId: outlet.id, reservedCount: 1 };
    const [first, second] = [await makeDrop(options), await makeDrop(options)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const expired = seconds(now, -120).toISOString();
    const shared = { outletId: outlet.id, serviceDate: first!.serviceDate, holdExpiresAt: expired };
    await makeOrder({ ...shared, userId: user.id, dropId: first!.id });
    await makeOrder({ ...shared, userId: null, anonId: 'other', dropId: second!.id });

    // Stands in for a reserve by the same customer: it has the second drop's row, and has yet to insert.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE drops SET reserved_count = reserved_count WHERE id = $1', [second!.id]);
      const job = expireHolds(now);
      await vi.waitFor(async () => {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        expect(rows[0]!.n).toBeGreaterThan(0);
      });

      const insert = await client
        .query(
          `INSERT INTO orders (user_id, drop_id, outlet_id, service_date, price_paise, commission_bps,
                               commission_paise, hold_expires_at)
           VALUES ($1, $2, $3, $4, 1, 1, 1, $5)`,
          [user.id, second!.id, outlet.id, first!.serviceDate, now.toISOString()],
        )
        .catch((e: { code?: string }) => e.code);
      expect(insert).toBe('23505');
      await client.query('ROLLBACK');
      expect(await job).toBe(2);
    } finally {
      client.release();
    }
  });

  test('a locked hold is skipped, not waited for', async () => {
    const drop = await makeDrop();
    const locked = await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    const free = await reserveDrop({ dropId: drop.id, anonId: 'b', ip: '1.1.1.1' }, now);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [locked.id]);
      expect(await expireHolds(seconds(now, HOLD_SECONDS + 61))).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await getOrderRow(free.id)).status).toBe('expired');
    expect((await getOrderRow(locked.id)).status).toBe('held');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('paid orders are left alone', async () => {
    const drop = await makeDrop({ reservedCount: 1 });
    const paid = await makePaidOrder({
      dropId: drop.id,
      outletId: drop.outletId,
      serviceDate: drop.serviceDate,
      holdExpiresAt: seconds(now, -600).toISOString(),
    });
    expect(await expireHolds(now)).toBe(0);
    expect((await getOrderRow(paid.id)).status).toBe('paid');
  });

  test('racing a re-reserve against expiry neither deadlocks nor miscounts', async () => {
    const user = await makeUser();
    const drop = await makeDrop({ quantity: 5 });
    const later = seconds(now, HOLD_SECONDS + 61);
    for (let i = 0; i < 8; i++) {
      await reserveDrop({ dropId: drop.id, userId: user.id, ip: `2.2.2.${i}` }, now);
      const [reserved] = await Promise.allSettled([
        reserveDrop({ dropId: drop.id, userId: user.id, ip: `3.3.3.${i}` }, later),
        expireHolds(later),
      ]);
      if (reserved.status === 'rejected') expect(reserved.reason).toBeInstanceOf(ApiError);
      expect((await getDropRow(drop.id)).reservedCount).toBe(await heldCount(drop.id));
      await expireHolds(seconds(later, HOLD_SECONDS * 2));
    }
  });

  test('stock always matches the holds while reserves race expiry', async () => {
    const drop = await makeDrop({ quantity: 5 });
    for (let i = 0; i < 5; i++) await reserveDrop({ dropId: drop.id, anonId: `old${i}`, ip: '1.1.1.1' }, now);
    const later = seconds(now, HOLD_SECONDS + 61);
    await Promise.allSettled([
      expireHolds(later),
      ...Array.from({ length: 12 }, (_, i) => reserveDrop({ dropId: drop.id, anonId: `new${i}`, ip: `4.4.4.${i}` }, later)),
      expireHolds(later),
    ]);
    const row = await getDropRow(drop.id);
    expect(row.reservedCount).toBe(await heldCount(drop.id));
    expect(row.reservedCount).toBeLessThanOrEqual(5);
  });
});

describe('releaseStock', () => {
  test('never goes below zero', async () => {
    const drop = await makeDrop({ reservedCount: 1 });
    await withTx((tx) => releaseStock(tx, drop.id));
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    await withTx((tx) => releaseStock(tx, drop.id));
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });
});

describe('releaseHold', () => {
  test('releaseHold returns stock, and only the owner can do it', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    const anon = await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    const signedIn = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);

    for (const stranger of [{ anonId: 'b' }, { userId: (await makeUser()).id }, {}]) {
      expect(await failure(releaseHold(stranger, anon.id, now))).toMatchObject({ code: 'not_found', status: 404 });
    }
    expect(await failure(releaseHold({ anonId: 'a' }, 'nope', now))).toMatchObject({ status: 404 });
    expect((await getDropRow(drop.id)).reservedCount).toBe(2);

    await releaseHold({ anonId: 'a' }, anon.id, now);
    expect((await getOrderRow(anon.id)).status).toBe('expired');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    await releaseHold({ userId: user.id }, signedIn.id, now);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('releasing twice returns stock once, and a paid order cannot be released', async () => {
    const user = await makeUser();
    const drop = await makeDrop({ reservedCount: 1 });
    const paid = await makePaidOrder({
      userId: user.id,
      dropId: drop.id,
      outletId: drop.outletId,
      serviceDate: drop.serviceDate,
    });
    expect(await failure(releaseHold({ userId: user.id }, paid.id, now))).toMatchObject({
      code: 'hold_not_active',
      status: 409,
    });

    const held = await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    const results = await Promise.allSettled([
      releaseHold({ anonId: 'a' }, held.id, now),
      releaseHold({ anonId: 'a' }, held.id, now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });
});

describe('attachHolds', () => {
  test('OTP attaches the anonymous hold, keeping its expiry', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    const order = await reserveDrop({ dropId: drop.id, anonId: 'a', ip: '1.1.1.1' }, now);
    expect(await attachHolds('a', user.id, seconds(now, 120))).toEqual({ attachedOrderId: order.id });
    const row = await getOrderRow(order.id);
    expect(row.userId).toBe(user.id);
    expect(row.holdExpiresAt).toBe(order.holdExpiresAt);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('once attached, the anon ID no longer owns the order', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    const order = await reserveDrop({ dropId: drop.id, anonId: 'shared-browser', ip: '1.1.1.1' }, now);
    await attachHolds('shared-browser', user.id, now);

    const nextPerson = { anonId: 'shared-browser' };
    expect(await failure(getOrder(nextPerson, order.id))).toMatchObject({ code: 'not_found', status: 404 });
    expect(await failure(releaseHold(nextPerson, order.id, now))).toMatchObject({ code: 'not_found', status: 404 });
    const otherUser = { userId: (await makeUser()).id, anonId: 'shared-browser' };
    expect(await failure(getOrder(otherUser, order.id))).toMatchObject({ status: 404 });
    expect((await getOrderRow(order.id)).status).toBe('held');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);

    expect((await getOrder({ userId: user.id, anonId: 'shared-browser' }, order.id)).id).toBe(order.id);
    await releaseHold({ userId: user.id }, order.id, now);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('nothing to attach, or a hold already past its expiry, returns nothing', async () => {
    const user = await makeUser();
    expect(await attachHolds('nobody', user.id, now)).toEqual({});
    const order = await reserveDrop({ dropId: (await makeDrop()).id, anonId: 'a', ip: '1.1.1.1' }, now);
    expect(await attachHolds('a', user.id, seconds(now, HOLD_SECONDS + 1))).toEqual({});
    expect((await getOrderRow(order.id)).userId).toBeNull();
  });

  test('two devices, same phone, same outlet keep one order', async () => {
    const user = await makeUser();
    const drop = await makeDrop({ quantity: 5 });
    const first = await reserveDrop({ dropId: drop.id, anonId: 'anonA', ip: '1.1.1.1' }, now);
    const second = await reserveDrop({ dropId: drop.id, anonId: 'anonB', ip: '1.1.1.1' }, now);
    expect(await attachHolds('anonA', user.id, now)).toEqual({ attachedOrderId: first.id });
    expect((await getDropRow(drop.id)).reservedCount).toBe(2);

    expect(await attachHolds('anonB', user.id, now)).toEqual({ existingOrderId: first.id });
    expect((await getOrderRow(second.id)).status).toBe('expired');
    expect((await getOrderRow(first.id)).status).toBe('held');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('both devices verifying at once still keep one order', async () => {
    const user = await makeUser();
    const drop = await makeDrop({ quantity: 5 });
    await reserveDrop({ dropId: drop.id, anonId: 'anonA', ip: '1.1.1.1' }, now);
    await reserveDrop({ dropId: drop.id, anonId: 'anonB', ip: '1.1.1.1' }, now);
    const results = await Promise.all([attachHolds('anonA', user.id, now), attachHolds('anonB', user.id, now)]);
    expect(results.filter((r) => r.attachedOrderId)).toHaveLength(1);
    expect(results.filter((r) => r.existingOrderId)).toHaveLength(1);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    expect(await heldCount(drop.id)).toBe(1);
  });

  test('a hold at another outlet attaches alongside an existing order', async () => {
    const user = await makeUser();
    await makeOrder({ userId: user.id });
    const order = await reserveDrop({ dropId: (await makeDrop()).id, anonId: 'a', ip: '1.1.1.1' }, now);
    expect(await attachHolds('a', user.id, now)).toEqual({ attachedOrderId: order.id });
  });
});

describe('hold routes', () => {
  const FUTURE = Date.now() + 2 * 3_600_000;
  const onSaleDrop = (quantity = 5) =>
    makeDrop({
      quantity,
      pickupStartAt: new Date(FUTURE).toISOString(),
      pickupEndAt: new Date(FUTURE + 3_600_000).toISOString(),
      salesEndAt: new Date(FUTURE + 2_700_000).toISOString(),
    });
  const post = (dropId: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.7', ...headers },
      body: JSON.stringify({ dropId }),
    });
  const anonFrom = (res: Response) =>
    decodeURIComponent(/anon_id=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '');
  type Body = { order: { id: string; status: string; number: string } };
  type Failure = { error: { code: string; existingOrderId?: string } };

  test('POST /orders sets a signed 1-day anon cookie and returns the order view', async () => {
    const drop = await onSaleDrop();
    const res = await post(drop.id);
    expect(res.status).toBe(200);
    const { order } = (await res.json()) as Body;
    expect(order).toMatchObject({ status: 'held', number: expect.stringMatching(/^SJ-/) });
    expect(Object.keys(order)).not.toContain('commissionPaise');

    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Max-Age=86400/i);
    const anonId = verifyAnonId(anonFrom(res));
    expect(anonId).toBeTruthy();
    expect((await getOrderRow(order.id)).anonId).toBe(anonId);
  });

  test('a valid anon cookie is reused; a forged one is replaced', async () => {
    const reuse = await post((await onSaleDrop()).id, {
      cookie: `anon_id=${encodeURIComponent(signAnonId('mine'))}`,
      origin: env().FRONTEND_ORIGIN,
    });
    expect(reuse.status).toBe(200);
    expect(reuse.headers.get('set-cookie')).toBeNull();
    expect((await getOrderRow(((await reuse.json()) as Body).order.id)).anonId).toBe('mine');

    const forged = await post((await onSaleDrop()).id, {
      cookie: 'anon_id=mine.forged',
      origin: env().FRONTEND_ORIGIN,
    });
    expect(forged.status).toBe(200);
    expect(verifyAnonId(anonFrom(forged))).not.toBe('mine');
    expect(verifyAnonId(anonFrom(forged))).toBeTruthy();
  });

  test('a signed-in customer holds under their user and gets no anon cookie', async () => {
    const user = await makeUser();
    const token = await createSession(user.id, new Date());
    const res = await post((await onSaleDrop()).id, { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await getOrderRow(((await res.json()) as Body).order.id)).userId).toBe(user.id);
  });

  test('errors carry the code and existing order, and the body is validated', async () => {
    expect((await post('not-a-uuid')).status).toBe(400);

    const cookie = `anon_id=${encodeURIComponent(signAnonId('mine'))}`;
    const headers = { cookie, origin: env().FRONTEND_ORIGIN };
    const first = (await (await post((await onSaleDrop()).id, headers)).json()) as Body;
    const res = await post((await onSaleDrop()).id, headers);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Failure).error).toMatchObject({
      code: 'hold_exists',
      existingOrderId: first.order.id,
    });
  });

  test('DELETE /orders/:id/hold releases for the owner only', async () => {
    const drop = await onSaleDrop();
    const res = await post(drop.id);
    const { order } = (await res.json()) as Body;
    const del = (headers: Record<string, string>) =>
      app.request(`/api/v1/orders/${order.id}/hold`, { method: 'DELETE', headers });

    const mine = `anon_id=${encodeURIComponent(anonFrom(res))}`;
    expect((await del({})).status).toBe(404);
    const stranger = `anon_id=${encodeURIComponent(signAnonId('stranger'))}`;
    expect((await del({ cookie: stranger, origin: env().FRONTEND_ORIGIN })).status).toBe(404);
    expect((await del({ cookie: mine })).status).toBe(403);
    expect((await del({ cookie: mine, origin: 'https://evil.test' })).status).toBe(403);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);

    expect((await del({ cookie: mine, origin: env().FRONTEND_ORIGIN })).status).toBe(200);
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  describe('OTP verify', () => {
    let fake: FakeMessenger;
    beforeEach(() => {
      fake = new FakeMessenger();
      setMessenger(fake);
    });
    const verify = async (cookie: string) => {
      await sendOtp(PHONE, '1.1.1.1', new Date());
      const code = (fake.sent.at(-1)!.variables as { code: string }).code;
      return app.request('/api/v1/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: env().FRONTEND_ORIGIN },
        body: JSON.stringify({ phone: PHONE, code }),
      });
    };

    test('verify attaches the hold and reports it', async () => {
      const held = await post((await onSaleDrop()).id);
      const { order } = (await held.json()) as Body;
      const res = await verify(`anon_id=${encodeURIComponent(anonFrom(held))}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { id: string }; attachedOrderId?: string };
      expect(body.attachedOrderId).toBe(order.id);
      expect((await getOrderRow(order.id)).userId).toBe(body.user.id);
    });

    test('verify reports the existing order when the hold is released', async () => {
      const user = await makeUser({ phone: PHONE });
      const drop = await onSaleDrop();
      const paid = await makePaidOrder({
        userId: user.id,
        dropId: drop.id,
        outletId: drop.outletId,
        serviceDate: drop.serviceDate,
      });
      const held = await post(drop.id);
      const { order } = (await held.json()) as Body;
      const res = await verify(`anon_id=${encodeURIComponent(anonFrom(held))}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ existingOrderId: paid.id });
      expect((await getOrderRow(order.id)).status).toBe('expired');
    });

    test('a failed attach never fails sign-in', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      // A NUL byte passes the signature check but Postgres rejects it, so attachHolds throws.
      const res = await verify(`anon_id=${encodeURIComponent(signAnonId('bad\0id'))}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toMatch(/^session=/);
      expect(logged).toHaveBeenCalled();
    });
  });
});
