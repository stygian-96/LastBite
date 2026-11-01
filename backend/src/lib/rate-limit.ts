import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rateLimits } from '../db/schema.js';
import { ApiError } from './errors.js';

/** Fixed-window counter: counts this call, and throws 429 once the window's count passes limit. */
export async function rateLimit(key: string, limit: number, windowSeconds: number, now: Date): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  if (!row || row.count > limit) {
    throw new ApiError('rate_limited', 429, 'Too many requests, try again shortly');
  }
}
