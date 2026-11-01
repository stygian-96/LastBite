import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { isUniqueViolation } from '../../src/lib/db-errors.js';
import { resetDb } from '../helpers/db.js';

beforeEach(resetDb);

const insertUser = (phone: string) => db.insert(users).values({ phone });

describe('isUniqueViolation', () => {
  test('sees the driver error that Drizzle wraps, and can name the constraint', async () => {
    await insertUser('+919000000001');
    const err: unknown = await insertUser('+919000000001').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBeUndefined();
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(err, 'users_phone_key')).toBe(true);
    expect(isUniqueViolation(err, 'some_other_index')).toBe(false);
  });

  test('also accepts an unwrapped driver error, and rejects anything else', () => {
    expect(isUniqueViolation({ code: '23505', constraint: 'x' }, 'x')).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
