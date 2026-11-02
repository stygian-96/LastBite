import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/client.js';
import { auditLog } from '../../src/db/schema.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { env } from '../../src/lib/env.js';
import { createSession } from '../../src/modules/auth/session.js';
import { app } from '../../src/app.js';
import { makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

beforeEach(async () => {
  await resetDb();
  setGateway(new FakeGateway());
});
afterEach(() => vi.restoreAllMocks());

const headers = async (userId: string) => ({
  cookie: `session=${await createSession(userId, new Date())}`,
  origin: env().FRONTEND_ORIGIN,
  'content-type': 'application/json',
});
const admin = () => makeUser({ isAdmin: true });
const get = async (path: string, userId: string) => app.request(`/api/v1/admin${path}`, { headers: await headers(userId) });

const logged = (action: string, createdAt = '2026-11-02T10:00:00Z') =>
  db.insert(auditLog).values({ action, entity: 'refund', entityId: randomUUID(), detail: { note: action }, createdAt });

describe('GET /admin/alerts', () => {
  const ALERTS = [
    'refund.failed',
    'refund.stuck',
    'payment.amount_mismatch',
    'payment.unmatched',
    'transfer.orphaned',
    'transfer.no_net',
    'transfer.failed',
    'payout.mismatch',
    'linked_account.stuck',
    'refund.unknown',
  ];

  test('lists every alert, the newest first, and nothing else from the log', async () => {
    for (const action of ALERTS) await logged(action);
    await logged('order.cancel');

    const res = await get('/alerts', (await admin()).id);

    expect(res.status).toBe(200);
    const { alerts } = (await res.json()) as { alerts: { id: string; action: string; entity: string; detail: unknown }[] };
    expect(alerts.map((a) => a.action)).toEqual([...ALERTS].reverse());
    expect(alerts[0]).toMatchObject({ id: expect.any(String), entity: 'refund', detail: { note: 'refund.unknown' } });
  });

  test('filters by action and by time', async () => {
    await logged('refund.failed', '2026-11-01T10:00:00Z');
    await logged('refund.failed', '2026-11-03T10:00:00Z');
    await logged('refund.stuck', '2026-11-03T10:00:00Z');
    const adminId = (await admin()).id;

    const byAction = (await (await get('/alerts?action=refund.stuck', adminId)).json()) as { alerts: unknown[] };
    expect(byAction.alerts).toHaveLength(1);

    const since = (await (await get('/alerts?action=refund.failed&from=2026-11-02T00:00:00Z', adminId)).json()) as { alerts: unknown[] };
    expect(since.alerts).toHaveLength(1);

    const until = (await (await get('/alerts?to=2026-11-02T00:00:00Z', adminId)).json()) as { alerts: unknown[] };
    expect(until.alerts).toHaveLength(1);
  });

  test('refuses an action that is not an alert, and a bad time', async () => {
    const adminId = (await admin()).id;
    expect((await get('/alerts?action=order.cancel', adminId)).status).toBe(400);
    expect((await get('/alerts?from=yesterday', adminId)).status).toBe(400);
  });

  test('is for admins only', async () => {
    expect((await app.request('/api/v1/admin/alerts')).status).toBe(401);
    expect((await get('/alerts', (await makeUser()).id)).status).toBe(403);
  });
});
