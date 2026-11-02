import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { payments } from '../../src/db/schema.js';
import { makeOrder, makePayment } from '../helpers/factories.js';
import { getOrderRow, resetDb } from '../helpers/db.js';

const SECRET = 'test-cron-secret';
const PRODUCTION_ENV = {
  RAZORPAY_KEY_ID: 'rzp_live_key',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'hook',
  RAZORPAY_LINKED_EMAIL_DOMAIN: 'payouts.example.com',
  MESSAGING_API_URL: 'https://messages.example.com/send',
  MESSAGING_API_KEY: 'key',
  MESSAGING_WEBHOOK_SECRET: 'hook',
  AWS_REGION: 'ap-south-1',
  S3_PUBLIC_BUCKET: 'pub',
  S3_PRIVATE_BUCKET: 'priv',
};

/** The app as it starts under these variables: the route is mounted, or not, when the app loads. */
async function appWith(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  vi.resetModules();
  return (await import('../../src/app.js')).app;
}

const developmentApp = () => appWith({ NODE_ENV: 'development', DEV_FAKE_PROVIDERS: 'true' });

const capture = (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, orderId: string, secret = SECRET) =>
  app.request(`/api/v1/internal/dev/capture/${orderId}`, { method: 'POST', headers: { 'x-cron-secret': secret } });

async function heldOrderWithPayment() {
  const order = await makeOrder({ status: 'held' });
  await makePayment({ orderId: order.id, amountPaise: order.pricePaise });
  return order;
}

beforeEach(resetDb);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /internal/dev/capture/:orderId', () => {
  test('fakes a capture and runs it through, so the order is paid with a pickup code', async () => {
    const order = await heldOrderWithPayment();
    const res = await capture(await developmentApp(), order.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settled: true });
    const row = await getOrderRow(order.id);
    expect(row.status).toBe('paid');
    expect(row.pickupCode).toBeTruthy();
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(payment).toMatchObject({ status: 'captured', amountPaise: order.pricePaise, method: 'upi' });
    expect(payment!.feePaise).toBeGreaterThan(0);
  });

  test('a second capture of the same order changes nothing', async () => {
    const order = await heldOrderWithPayment();
    const app = await developmentApp();
    await capture(app, order.id);
    const again = await capture(app, order.id);
    expect(await again.json()).toEqual({ settled: false });
    expect(await db.select().from(payments).where(eq(payments.orderId, order.id))).toHaveLength(1);
  });

  test('needs the cron secret', async () => {
    const order = await heldOrderWithPayment();
    expect((await capture(await developmentApp(), order.id, 'wrong')).status).toBe(401);
    expect((await getOrderRow(order.id)).status).toBe('held');
  });

  test('an unknown order, a bad ID, and an order not yet sent to pay are refused', async () => {
    const app = await developmentApp();
    expect((await capture(app, '7b0e1f3a-6a7e-4a55-9a53-3f1f6f5b9a10')).status).toBe(404);
    expect((await capture(app, 'not-an-id')).status).toBe(404);
    const unpaid = await capture(app, (await makeOrder({ status: 'held' })).id);
    expect(unpaid.status).toBe(409);
    expect(await unpaid.json()).toMatchObject({ error: { code: 'payment_not_started' } });
  });

  test.each([
    ['in production', { NODE_ENV: 'production', CRON_SECRET: SECRET, ...PRODUCTION_ENV }],
    ['in tests', { NODE_ENV: 'test' }],
    ['in development without the flag', { NODE_ENV: 'development', DEV_FAKE_PROVIDERS: '' }],
    ['in tests, even with the flag', { NODE_ENV: 'test', DEV_FAKE_PROVIDERS: 'true' }],
    ['with NODE_ENV unset, even with the flag', { NODE_ENV: '', DEV_FAKE_PROVIDERS: 'true' }],
  ])('is not there %s', async (_name, vars) => {
    const order = await heldOrderWithPayment();
    const app = await appWith(vars);
    expect((await capture(app, order.id)).status).toBe(404);
    expect((await getOrderRow(order.id)).status).toBe('held');
  });
});
