import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { env } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { runTick } from '../modules/jobs/tick.js';
import { devCapture } from '../modules/payments/dev-capture.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Compares digests, so the check takes the same time whatever the length of what was sent. */
function isCronSecret(given: string): boolean {
  const secret = env().CRON_SECRET;
  return !!secret && timingSafeEqual(digest(given), digest(secret));
}

function requireCronSecret(given: string | undefined): void {
  if (!isCronSecret(given ?? '')) throw new ApiError('unauthenticated', 401, 'Invalid cron secret');
}

// Not built on route(): the caller is the cron service, which has a secret and no cookies.
export const internal = new Hono().post('/internal/jobs/tick', async (c) => {
  requireCronSecret(c.req.header('x-cron-secret'));
  return c.json(await runTick(new Date()));
});

/** Local development only: app.ts mounts this with DEV_FAKE_PROVIDERS on, and never otherwise. */
export const internalDev = new Hono().post('/internal/dev/capture/:orderId', async (c) => {
  requireCronSecret(c.req.header('x-cron-secret'));
  return c.json({ settled: await devCapture(c.req.param('orderId'), new Date()) });
});
