import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../../src/db/client.js';
import { auditLog, memberships, payouts } from '../../src/db/schema.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { env } from '../../src/lib/env.js';
import { isoTimestamps } from '../../src/lib/time.js';
import { createSession } from '../../src/modules/auth/session.js';
import { app } from '../../src/app.js';
import { makeDrop, makeLiveOutlet, makePaidOrder, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

beforeEach(async () => {
  await resetDb();
  setGateway(new FakeGateway());
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Anything that looks like a date with a time on it. A plain date, such as a service date, is fine. */
const LOOKS_LIKE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

/** Every string in a response that looks like a timestamp, with where it was found. */
function timestamps(value: unknown, path = '$'): [string, string][] {
  if (typeof value === 'string') return LOOKS_LIKE_TIME.test(value) ? [[path, value]] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => timestamps(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => timestamps(v, `${path}.${k}`));
  return [];
}

async function get(path: string, userId: string) {
  const res = await app.request(`/api/v1${path}`, {
    headers: { cookie: `session=${await createSession(userId, new Date())}`, origin: env().FRONTEND_ORIGIN },
  });
  expect(res.status, path).toBe(200);
  return res.json();
}

describe('every timestamp in a response is ISO 8601', () => {
  test('across customer, vendor and admin responses', async () => {
    const outlet = await makeLiveOutlet({ pausedUntil: '2026-11-01T10:00:00Z' });
    const customer = await makeUser();
    const drop = await makeDrop({ outletId: outlet.id });
    const order = await makePaidOrder({ dropId: drop.id, userId: customer.id, status: 'collected', collectedAt: '2026-11-02T15:00:00Z' });
    const owner = await makeUser();
    await db.insert(memberships).values({ userId: owner.id, brandId: outlet.brandId, role: 'owner' });
    await db.insert(payouts).values({
      payoutAccountId: outlet.payoutAccountId!,
      periodStart: '2026-10-26',
      periodEnd: '2026-11-01',
      grossPaise: 0,
      commissionPaise: 0,
      feesPaise: 0,
      netPaise: 0,
      status: 'paid',
      paidAt: '2026-11-03T05:00:00Z',
    });
    await db.insert(auditLog).values({ action: 'refund.failed', entity: 'refund', entityId: order.id });
    const admin = await makeUser({ isAdmin: true });

    const responses = [
      await get(`/orders/${order.id}`, customer.id),
      await get('/me/orders', customer.id),
      await get('/vendor/outlets', owner.id),
      await get(`/vendor/outlets/${outlet.id}/today`, owner.id),
      await get(`/vendor/outlets/${outlet.id}/orders?date=2026-11-02`, owner.id),
      await get(`/vendor/outlets/${outlet.id}/listings`, owner.id),
      await get(`/vendor/earnings?payout_account=${outlet.payoutAccountId}`, owner.id),
      await get('/admin/orders', admin.id),
      await get('/admin/payouts', admin.id),
      await get('/admin/payout-accounts', admin.id),
      await get('/admin/alerts', admin.id),
    ];

    const found = timestamps(responses);
    expect(found.length).toBeGreaterThan(15);
    expect(found.filter(([, v]) => !ISO.test(v))).toEqual([]);
  });
});

describe('isoTimestamps', () => {
  test('turns Postgres timestamptz text into ISO at any depth and leaves the rest', () => {
    expect(
      isoTimestamps({
        a: '2026-11-02 05:54:25.493+00',
        b: [{ c: '2026-11-02 11:24:25+05:30' }],
        date: '2026-11-02',
        text: 'Pickup at 2026-11-02 05:54:25+00, please',
        n: 3,
        none: null,
      }),
    ).toEqual({
      a: '2026-11-02T05:54:25.493Z',
      b: [{ c: '2026-11-02T05:54:25.000Z' }],
      date: '2026-11-02',
      text: 'Pickup at 2026-11-02 05:54:25+00, please',
      n: 3,
      none: null,
    });
  });

  test('the order view itself sends ISO, as the frontend found it did not', async () => {
    const customer = await makeUser();
    const order = await makePaidOrder({ userId: customer.id });
    const { order: view } = (await get(`/orders/${order.id}`, customer.id)) as { order: Record<string, string> };
    for (const field of ['holdExpiresAt', 'pickupStartAt', 'pickupEndAt']) expect(view[field]).toMatch(ISO);
  });
});
