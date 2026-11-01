import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { drops, orders, refunds } from '../../src/db/schema.js';

/** Empties every table except the seeded areas and the migration log. */
export async function resetDb(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT IN ('areas', 'schema_migrations')`,
  );
  if (rows.length === 0) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

export async function getDropRow(id: string) {
  const [row] = await db.select().from(drops).where(eq(drops.id, id));
  if (!row) throw new Error(`drop ${id} not found`);
  return row;
}

export async function getOrderRow(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error(`order ${id} not found`);
  return row;
}

export function refundsFor(orderId: string) {
  return db.select().from(refunds).where(eq(refunds.orderId, orderId));
}
