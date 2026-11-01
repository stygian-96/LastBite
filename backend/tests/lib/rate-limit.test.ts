import { beforeEach, describe, expect, test } from 'vitest';
import { rateLimit } from '../../src/lib/rate-limit.js';
import { ApiError } from '../../src/lib/errors.js';
import { resetDb } from '../helpers/db.js';

beforeEach(resetDb);

describe('rateLimit', () => {
  test('allows up to limit, then throws, then resets in the next window', async () => {
    const t0 = new Date('2026-11-01T10:00:10Z');
    await rateLimit('k', 2, 60, t0);
    await rateLimit('k', 2, 60, t0);
    const err = await rateLimit('k', 2, 60, t0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('rate_limited');
    expect((err as ApiError).status).toBe(429);

    await rateLimit('other', 2, 60, t0);
    await rateLimit('k', 2, 60, new Date('2026-11-01T10:01:00Z'));
  });
});
