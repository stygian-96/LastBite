import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { drops, orders, refunds } from '../../src/db/schema.js';

let resetSql: string | undefined;

/** Looked up once per run, so tables added by later migrations are picked up without a hard-coded list. */
async function buildResetSql(): Promise<string> {
  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT IN ('areas', 'schema_migrations')`,
  );
  const seqs = await pool.query<{ sequencename: string }>(
    `SELECT s.sequencename FROM pg_sequences s
      WHERE s.schemaname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
            JOIN pg_class t ON t.oid = d.refobjid
           WHERE d.objid = (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))::regclass
             AND t.relname IN ('areas', 'schema_migrations'))`,
  );
  // Replica role skips FK checks, so table order does not matter.
  return [
    "SET session_replication_role = 'replica'",
    ...tables.rows.map((r) => `DELETE FROM "${r.tablename}"`),
    ...seqs.rows.map((r) => `ALTER SEQUENCE "${r.sequencename}" RESTART`),
    "SET session_replication_role = 'origin'",
  ].join('; ');
}

/** Empties every table except the seeded areas and the migration log, in one round trip. */
export async function resetDb(): Promise<void> {
  resetSql ??= await buildResetSql();
  await pool.query(resetSql);
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
