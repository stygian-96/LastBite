import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { db, pool } from '../../src/db/client.js';
import { jobRuns, notifications, otpCodes, payments, payouts, rateLimits, sessions } from '../../src/db/schema.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { FakeMessenger, setMessenger } from '../../src/integrations/messaging.js';
import { env } from '../../src/lib/env.js';
import { cleanup, runTick, TICK_LOCK } from '../../src/modules/jobs/tick.js';
import { app } from '../../src/app.js';
import { makeDrop, makeLiveOutlet, makePaidOrder, makePayoutAccount, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

const control = vi.hoisted(() => ({
  failing: false,
  gate: undefined as Promise<void> | undefined,
  entered: () => {},
  breakOneBuild: false,
}));

// One job made to fail or wait, so these tests need no seam in the runner.
vi.mock('../../src/modules/orders/expire.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/orders/expire.js')>();
  return {
    ...actual,
    expireHolds: async (now: Date) => {
      control.entered();
      if (control.gate) await control.gate;
      if (control.failing) throw new Error('expire broke');
      return actual.expireHolds(now);
    },
  };
});

// The first account of a build fails, as one bad account would.
vi.mock('../../src/modules/payouts/build.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/payouts/build.js')>();
  return {
    ...actual,
    buildPayouts: async (periodStart: string, now: Date) => {
      if (control.breakOneBuild) {
        control.breakOneBuild = false;
        vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('account broke'));
      }
      return actual.buildPayouts(periodStart, now);
    },
  };
});

const EVERY_MINUTE = [
  'reconcilePayments',
  'expireHolds',
  'sendPending',
  'processRefunds',
  'queuePickupReminders',
  'createTransfers',
  'syncLinkedAccounts',
];
// Tuesday, 3 November 2026.
const TUESDAY_10AM_IST = new Date('2026-11-03T04:30:00Z');
const ist = (at: string) => new Date(`${at}+05:30`);
const minutes = (from: Date, n: number) => new Date(from.getTime() + n * 60_000);
const days = (from: Date, n: number) => new Date(from.getTime() + n * 86_400_000);
const ran = async (now: Date) => Object.keys((await runTick(now)).ran);

beforeEach(async () => {
  await resetDb();
  control.failing = false;
  control.gate = undefined;
  control.entered = () => {};
  control.breakOneBuild = false;
  setGateway(new FakeGateway());
  setMessenger(new FakeMessenger());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /internal/jobs/tick', () => {
  const tick = (headers: Record<string, string> = {}) =>
    app.request('/api/v1/internal/jobs/tick', { method: 'POST', headers });

  test('tick without the secret returns 401', async () => {
    const res = await tick();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect((await tick({ 'x-cron-secret': 'wrong' })).status).toBe(401);
    expect(await db.select().from(jobRuns)).toEqual([]);
  });

  test('stays shut when CRON_SECRET is not set, even to an empty header', async () => {
    const secret = env().CRON_SECRET;
    env().CRON_SECRET = undefined;
    try {
      expect((await tick({ 'x-cron-secret': '' })).status).toBe(401);
      expect((await tick({ 'x-cron-secret': secret! })).status).toBe(401);
    } finally {
      env().CRON_SECRET = secret;
    }
  });

  test('the right secret runs a tick and reports it', async () => {
    const res = await tick({ 'x-cron-secret': env().CRON_SECRET! });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: boolean; ran: Record<string, number>; failed: unknown[] };
    expect(body.skipped).toBe(false);
    expect(body.failed).toEqual([]);
    expect(Object.keys(body.ran)).toEqual(expect.arrayContaining(EVERY_MINUTE));
  });
});

describe('runTick', () => {
  test('tick runs every-minute jobs and skips others until due', async () => {
    expect(await ran(TUESDAY_10AM_IST)).toEqual([...EVERY_MINUTE, 'autoMarkNoShows', 'checkLicences', 'cleanup', 'buildPayouts']);
    expect(await ran(minutes(TUESDAY_10AM_IST, 1))).toEqual(EVERY_MINUTE);
    expect(await ran(minutes(TUESDAY_10AM_IST, 4))).toEqual(EVERY_MINUTE);
    expect(await ran(minutes(TUESDAY_10AM_IST, 5))).toEqual([...EVERY_MINUTE, 'autoMarkNoShows']);
  });

  test('five-minute jobs keep to the clock when ticks come at odd seconds', async () => {
    await ran(new Date(TUESDAY_10AM_IST.getTime() + 1_000));
    // Under five minutes since the last run, but it is a new five-minute slot.
    expect(await ran(minutes(TUESDAY_10AM_IST, 5))).toContain('autoMarkNoShows');
  });

  test('a daily job runs once a day at odd tick times, by the IST date', async () => {
    expect(await ran(ist('2026-11-03T00:10:13'))).toContain('cleanup');
    expect(await ran(ist('2026-11-03T23:59:50'))).not.toContain('cleanup');
    expect(await ran(ist('2026-11-04T00:00:07'))).toContain('cleanup');
  });

  test('daily prompts run once between 17:00 and 17:14 IST', async () => {
    expect(await ran(ist('2026-11-03T16:59:00'))).not.toContain('queueDailyPrompts');
    expect(await ran(ist('2026-11-03T17:00:30'))).toContain('queueDailyPrompts');
    expect(await ran(ist('2026-11-03T17:01:30'))).not.toContain('queueDailyPrompts');
    // A tick that misses the whole window on the next day sends nothing.
    expect(await ran(ist('2026-11-04T17:15:00'))).not.toContain('queueDailyPrompts');
    expect(await ran(ist('2026-11-05T17:14:59'))).toContain('queueDailyPrompts');
  });

  test('licences are checked once between 10:00 and 10:14 IST', async () => {
    expect(await ran(ist('2026-11-03T09:59:00'))).not.toContain('checkLicences');
    expect(await ran(ist('2026-11-03T10:00:30'))).toContain('checkLicences');
    expect(await ran(ist('2026-11-03T10:01:30'))).not.toContain('checkLicences');
    expect(await ran(ist('2026-11-04T10:15:00'))).not.toContain('checkLicences');
    expect(await ran(ist('2026-11-05T10:14:59'))).toContain('checkLicences');
  });

  test('payments are reconciled before holds expire, so a paid hold is not expired first', async () => {
    const order = Object.keys((await runTick(TUESDAY_10AM_IST)).ran);
    expect(order.indexOf('reconcilePayments')).toBeLessThan(order.indexOf('expireHolds'));
  });

  test('one failing job does not stop the rest', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    control.failing = true;
    const result = await runTick(TUESDAY_10AM_IST);
    expect(result.failed).toEqual([{ job: 'expireHolds', error: 'expire broke' }]);
    expect(Object.keys(result.ran)).toEqual([...EVERY_MINUTE.filter((j) => j !== 'expireHolds'), 'autoMarkNoShows', 'checkLicences', 'cleanup', 'buildPayouts']);
    expect(logged).toHaveBeenCalled();
    expect(await db.select().from(jobRuns).where(eq(jobRuns.name, 'expireHolds'))).toEqual([]);
  });

  test('a job that failed is not stamped, so a daily one runs again on the next tick', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outage = vi.spyOn(db, 'delete').mockImplementationOnce(() => {
      throw new Error('database away');
    });
    const first = await runTick(TUESDAY_10AM_IST);
    expect(first.failed.map((f) => f.job)).toEqual(['cleanup']);
    expect(outage).toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    expect(await ran(minutes(TUESDAY_10AM_IST, 1))).toContain('cleanup');
  });

  test('two overlapping ticks do not double-run', async () => {
    let release = () => {};
    control.gate = new Promise((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (control.entered = resolve));
    const first = runTick(TUESDAY_10AM_IST);
    await entered;

    expect(await runTick(TUESDAY_10AM_IST)).toEqual({ skipped: true, ran: {}, failed: [] });
    release();
    expect((await first).skipped).toBe(false);
    // The lock is back, so the next tick runs.
    expect((await runTick(minutes(TUESDAY_10AM_IST, 1))).skipped).toBe(false);
  });

  test('a tick is skipped while another process holds the lock', async () => {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock($1)', [TICK_LOCK]);
      expect((await runTick(TUESDAY_10AM_IST)).skipped).toBe(true);
    } finally {
      await other.end();
    }
    expect(await db.select().from(jobRuns)).toEqual([]);
  });

  async function orderLastWeek() {
    const account = await makePayoutAccount({ razorpayAccountId: `acc_test_${crypto.randomUUID()}` });
    const outlet = await makeLiveOutlet({ brandId: account.brandId, payoutAccountId: account.id });
    const drop = await makeDrop({ outletId: outlet.id, serviceDate: '2026-11-03' });
    const order = await makePaidOrder({ dropId: drop.id, status: 'collected', pickupCode: null });
    await db
      .update(payments)
      .set({ feePaise: 300, transferStatus: 'on_hold', razorpayTransferId: `trf_${order.id}`, transferPaise: 7700 })
      .where(eq(payments.orderId, order.id));
  }

  test('Monday morning IST builds last week once', async () => {
    await orderLastWeek();
    // The Monday before, so the runs below are about this Monday alone.
    await ran(ist('2026-11-02T06:00:00'));

    expect(await ran(ist('2026-11-08T23:59:00'))).not.toContain('buildPayouts');
    expect(await ran(ist('2026-11-09T05:59:00'))).not.toContain('buildPayouts');
    expect(await db.select().from(payouts)).toEqual([]);

    expect(await ran(ist('2026-11-09T06:00:20'))).toContain('buildPayouts');
    const built = await db.select().from(payouts);
    expect(built).toHaveLength(1);
    expect(built[0]!.periodStart).toBe('2026-11-02');

    expect(await ran(ist('2026-11-09T06:01:00'))).not.toContain('buildPayouts');
    expect(await ran(ist('2026-11-11T09:00:00'))).not.toContain('buildPayouts');
    expect(await db.select().from(payouts)).toHaveLength(1);
  });

  test('one account failing leaves the build unstamped, and the next tick builds it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await orderLastWeek();
    await orderLastWeek();
    await ran(ist('2026-11-02T06:00:00'));

    control.breakOneBuild = true;
    const first = await runTick(ist('2026-11-09T06:00:20'));
    expect(first.failed.map((f) => f.job)).toEqual(['buildPayouts']);
    expect(first.failed[0]!.error).toContain('1 of 2');
    expect(await db.select().from(payouts)).toHaveLength(1);
    expect(logged).toHaveBeenCalled();

    expect(await ran(ist('2026-11-09T06:01:20'))).toContain('buildPayouts');
    expect(await db.select().from(payouts)).toHaveLength(2);
    expect(await ran(ist('2026-11-09T06:02:20'))).not.toContain('buildPayouts');
  });

  test('a Monday missed altogether is caught up, still for the week before', async () => {
    await orderLastWeek();
    await ran(ist('2026-11-02T06:00:00'));
    await ran(ist('2026-11-08T23:59:00'));

    expect(await ran(ist('2026-11-10T11:00:00'))).toContain('buildPayouts');
    expect((await db.select().from(payouts))[0]!.periodStart).toBe('2026-11-02');
  });
});

describe('database connections', () => {
  test('the pool and the tick client listen for errors, and the client is not reused after the lock', async () => {
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    const spies: { on?: MockInstance; off?: MockInstance; release?: MockInstance } = {};
    vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await connect();
      spies.on = vi.spyOn(client, 'on');
      spies.off = vi.spyOn(client, 'removeListener');
      spies.release = vi.spyOn(client, 'release');
      return client;
    });

    await runTick(TUESDAY_10AM_IST);

    const listener = spies.on!.mock.calls.find(([event]) => event === 'error')?.[1];
    expect(listener).toBeInstanceOf(Function);
    expect(spies.off).toHaveBeenCalledWith('error', listener);
    expect(spies.release).toHaveBeenCalledWith(true);
  });
});

describe('cleanup', () => {
  const NOW = TUESDAY_10AM_IST;
  const old = days(NOW, -2).toISOString();
  const recent = minutes(NOW, -30).toISOString();
  const future = minutes(NOW, 30).toISOString();
  const otp = (phone: string, o: { createdAt: string; expiresAt: string; usedAt?: string }) =>
    db.insert(otpCodes).values({ phone, codeHash: 'h', ...o });

  test('cleanup removes old OTPs and sessions', async () => {
    await otp('used-old', { createdAt: old, expiresAt: future, usedAt: old });
    await otp('expired-old', { createdAt: old, expiresAt: old });
    await otp('used-recent', { createdAt: recent, expiresAt: future, usedAt: recent });
    await otp('expired-recent', { createdAt: recent, expiresAt: minutes(NOW, -1).toISOString() });
    await otp('live-old', { createdAt: old, expiresAt: future });

    const user = await makeUser();
    await db.insert(sessions).values([
      { userId: user.id, tokenHash: 'gone', expiresAt: minutes(NOW, -1).toISOString() },
      { userId: user.id, tokenHash: 'kept', expiresAt: future },
    ]);

    await cleanup(NOW);

    const phones = (await db.select({ phone: otpCodes.phone }).from(otpCodes)).map((r) => r.phone);
    expect(phones.sort()).toEqual(['expired-recent', 'live-old', 'used-recent']);
    expect((await db.select({ t: sessions.tokenHash }).from(sessions)).map((r) => r.t)).toEqual(['kept']);
  });

  test('cleanup removes rate limit rows over a day old', async () => {
    await db.insert(rateLimits).values([
      { key: 'old', windowStart: old, count: 1 },
      { key: 'recent', windowStart: recent, count: 1 },
    ]);
    await cleanup(NOW);
    expect((await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key)).toEqual(['recent']);
  });

  test('cleanup removes sent notifications over 90 days old and nothing else', async () => {
    const message = (dedupeKey: string, status: string, createdAt: string) => ({
      dedupeKey,
      phone: '+919000000001',
      template: 'order_confirmed',
      variables: {},
      channel: 'sms',
      status,
      createdAt,
    });
    await db.insert(notifications).values([
      message('sent-old', 'sent', days(NOW, -91).toISOString()),
      message('sent-recent', 'sent', days(NOW, -89).toISOString()),
      message('failed-old', 'failed', days(NOW, -91).toISOString()),
      message('pending-old', 'pending', days(NOW, -91).toISOString()),
    ]);
    await cleanup(NOW);
    const left = (await db.select({ key: notifications.dedupeKey }).from(notifications)).map((r) => r.key);
    expect(left.sort()).toEqual(['failed-old', 'pending-old', 'sent-recent']);
  });
});
