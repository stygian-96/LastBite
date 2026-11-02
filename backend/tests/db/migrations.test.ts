import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, test } from 'vitest';
import { pool } from '../../src/db/client.js';
import { makeDrop, makeLiveOutlet, makeOrder, makePayoutAccount } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

beforeEach(resetDb);

const orderAt = async (outletId: string) => makeOrder({ dropId: (await makeDrop({ outletId })).id });

describe('0014_linked_account_steps backfill', () => {
  test('accounts already linked read as done, and the rest start from none', async () => {
    const linked = await makePayoutAccount({ razorpayAccountId: 'acc_existing' });
    const unlinked = await makePayoutAccount();

    const migration = await readFile(new URL('../../db/migrations/0014_linked_account_steps.sql', import.meta.url), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `ALTER TABLE payout_accounts
           DROP COLUMN linked_account_step, DROP COLUMN linked_product_id,
           DROP COLUMN linked_account_failures, DROP COLUMN linked_account_generation`,
      );
      await client.query(migration);
      const { rows } = await client.query<{ id: string; linked_account_step: string }>('SELECT id, linked_account_step FROM payout_accounts');
      const step = new Map(rows.map((r) => [r.id, r.linked_account_step]));
      expect(step.get(linked.id)).toBe('done');
      expect(step.get(unlinked.id)).toBe('none');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('0010_payout_snapshot backfill', () => {
  // DDL is transactional, so the file runs for real on these rows and the rollback puts the schema back.
  test('existing orders take the account of their outlet, and orders of an outlet with none stay null', async () => {
    const first = await makePayoutAccount();
    const second = await makePayoutAccount();
    const firstOutlet = await makeLiveOutlet({ brandId: first.brandId, payoutAccountId: first.id });
    const secondOutlet = await makeLiveOutlet({ brandId: second.brandId, payoutAccountId: second.id });
    const unlinked = await makeLiveOutlet();
    const a = await orderAt(firstOutlet.id);
    const b = await orderAt(secondOutlet.id);
    const c = await orderAt(unlinked.id);
    await pool.query('UPDATE outlets SET payout_account_id = NULL WHERE id = $1', [unlinked.id]);

    const migration = await readFile(new URL('../../db/migrations/0010_payout_snapshot.sql', import.meta.url), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE orders DROP COLUMN payout_account_id CASCADE');
      await client.query('ALTER TABLE payments DROP COLUMN reversed_paise CASCADE');
      await client.query(migration);
      const { rows } = await client.query<{ id: string; payout_account_id: string | null }>(
        'SELECT id, payout_account_id FROM orders',
      );
      const account = new Map(rows.map((r) => [r.id, r.payout_account_id]));
      expect(account.get(a.id)).toBe(first.id);
      expect(account.get(b.id)).toBe(second.id);
      expect(account.get(c.id)).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
