import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { env } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { runTick } from '../modules/jobs/tick.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Compares digests, so the check takes the same time whatever the length of what was sent. */
function isCronSecret(given: string): boolean {
  const secret = env().CRON_SECRET;
  return !!secret && timingSafeEqual(digest(given), digest(secret));
}

// Not built on route(): the caller is the cron service, which has a secret and no cookies.
export const internal = new Hono().post('/internal/jobs/tick', async (c) => {
  if (!isCronSecret(c.req.header('x-cron-secret') ?? '')) {
    throw new ApiError('unauthenticated', 401, 'Invalid cron secret');
  }
  return c.json(await runTick(new Date()));
});
