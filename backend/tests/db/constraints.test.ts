import { beforeEach, describe, expect, test } from 'vitest';
import { db, pool } from '../../src/db/client.js';
import { documents } from '../../src/db/schema.js';
import { getDropRow, resetDb } from '../helpers/db.js';
import { makeDrop, makeLiveOutlet, makeOrder, makePayoutAccount, makeUser } from '../helpers/factories.js';

beforeEach(resetDb);

async function setReserved(dropId: string, count: number) {
  await pool.query('UPDATE drops SET reserved_count = $2 WHERE id = $1', [dropId, count]);
}

/** Asserts the promise fails with the given Postgres error code (drizzle wraps it as `cause`). */
async function expectPgCode(p: PromiseLike<unknown>, code: string) {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e as { code?: string; cause?: { code?: string } },
  );
  expect(err, 'expected the statement to fail').toBeDefined();
  expect(err?.cause?.code ?? err?.code).toBe(code);
}

describe('database constraints', () => {
  test('drops reject more reservations than quantity', async () => {
    const drop = await makeDrop({ quantity: 1, reservedCount: 1 });
    await expect(setReserved(drop.id, 2)).rejects.toThrow(/check/i);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('one active order per user, outlet and night', async () => {
    const drop = await makeDrop();
    const user = await makeUser();
    await makeOrder({ dropId: drop.id, outletId: drop.outletId, userId: user.id });
    await expectPgCode(makeOrder({ dropId: drop.id, outletId: drop.outletId, userId: user.id }), '23505');
  });

  test('expired order frees the unique slot', async () => {
    const drop = await makeDrop();
    const user = await makeUser();
    await makeOrder({ dropId: drop.id, outletId: drop.outletId, userId: user.id, status: 'expired' });
    const again = await makeOrder({ dropId: drop.id, outletId: drop.outletId, userId: user.id });
    expect(again.status).toBe('held');
  });

  test('pickup code unique per outlet and night', async () => {
    const drop = await makeDrop();
    await makeOrder({ dropId: drop.id, outletId: drop.outletId, pickupCode: '4821' });
    await expectPgCode(makeOrder({ dropId: drop.id, outletId: drop.outletId, pickupCode: '4821' }), '23505');
  });

  test('same pickup code allowed on another night', async () => {
    const outlet = await makeLiveOutlet();
    const night1 = await makeDrop({ outletId: outlet.id, serviceDate: '2026-11-02' });
    const night2 = await makeDrop({ outletId: outlet.id, serviceDate: '2026-11-03' });
    await makeOrder({ dropId: night1.id, outletId: outlet.id, pickupCode: '4821' });
    const second = await makeOrder({
      dropId: night2.id,
      outletId: outlet.id,
      serviceDate: '2026-11-03',
      pickupCode: '4821',
    });
    expect(second.pickupCode).toBe('4821');
  });

  test('a document belongs to exactly one owner', async () => {
    const outlet = await makeLiveOutlet();
    const account = await makePayoutAccount();
    const base = { kind: 'fssai', fileKey: 'k' };
    await expectPgCode(db.insert(documents).values(base), '23514');
    await expectPgCode(
      db.insert(documents).values({ ...base, outletId: outlet.id, payoutAccountId: account.id }),
      '23514',
    );
    const [ok] = await db.insert(documents).values({ ...base, outletId: outlet.id }).returning();
    expect(ok?.outletId).toBe(outlet.id);
  });
});
