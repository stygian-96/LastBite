import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rateLimits } from '../db/schema.js';
import { ApiError } from './errors.js';

const limited = () => new ApiError('rate_limited', 429, 'Too many requests, try again shortly');

function windowStart(windowSeconds: number, now: Date): string {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
}

/** Adds one to the current fixed window and returns the new count. */
export async function countRateLimit(key: string, windowSeconds: number, now: Date): Promise<number> {
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: windowStart(windowSeconds, now), count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  return row?.count ?? Number.POSITIVE_INFINITY;
}

/** Fixed-window counter: counts this call, and throws 429 once the window's count passes limit. */
export async function rateLimit(key: string, limit: number, windowSeconds: number, now: Date): Promise<void> {
  if ((await countRateLimit(key, windowSeconds, now)) > limit) throw limited();
}

/**
 * Throws 429 once the window already holds limit counts, without adding one. For limits that count
 * only what succeeds: pair it with countRateLimit afterwards. Parallel requests can overshoot a little.
 */
export async function checkRateLimit(key: string, limit: number, windowSeconds: number, now: Date): Promise<void> {
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart(windowSeconds, now))));
  if (row && row.count >= limit) throw limited();
}
