import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../lib/env.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 20 });

// An idle connection that drops emits this, and with no listener it would take the process down.
pool.on('error', (e) => console.error('An idle database connection failed', e));

export const db = drizzle(pool, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Runs fn in one transaction: commits when it resolves, rolls back when it throws. */
export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
