import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { notifications, users } from '../../db/schema.js';
import { TEMPLATES, type TemplateName, type Vars } from './templates.js';

export type NewNotification = { dedupeKey: string; phone: string; template: TemplateName; variables: Vars };

/** A deleted user's phone is rewritten to start with this. They get no messages. */
const DELETED_PREFIX = 'deleted:';
/** Keeps a statement under Postgres's parameter limit. */
const CHUNK = 1000;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/**
 * Queues messages for the send job, inside the caller's transaction so they commit with the change
 * that caused them. A dedupe key already queued is a no-op. Never calls a provider. Returns how many
 * rows it added. Skipped: deleted users, and marketing for anyone who has not opted in.
 */
export async function enqueueMany(tx: Tx, list: NewNotification[]): Promise<number> {
  const wanted = list.filter((n) => !n.phone.startsWith(DELETED_PREFIX));
  for (const n of wanted) if (!(n.template in TEMPLATES)) throw new Error(`Unknown message template ${n.template}`);
  if (wanted.length === 0) return 0;

  const phones = [...new Set(wanted.map((n) => n.phone))];
  const known = new Map<string, { marketingOptIn: boolean; deleted: boolean }>();
  for (const part of chunks(phones)) {
    const rows = await tx
      .select({ phone: users.phone, marketingOptIn: users.marketingOptIn, deletedAt: users.deletedAt })
      .from(users)
      .where(inArray(users.phone, part));
    for (const r of rows) known.set(r.phone, { marketingOptIn: r.marketingOptIn, deleted: r.deletedAt !== null });
  }
  const rows = wanted.filter((n) => {
    const user = known.get(n.phone);
    if (user?.deleted) return false;
    return !TEMPLATES[n.template].marketing || user?.marketingOptIn === true;
  });

  let added = 0;
  for (const part of chunks(rows)) {
    const inserted = await tx
      .insert(notifications)
      .values(
        part.map((n) => ({
          dedupeKey: n.dedupeKey,
          phone: n.phone,
          template: n.template,
          variables: n.variables,
          channel: TEMPLATES[n.template].smsOnly ? 'sms' : 'whatsapp',
        })),
      )
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id });
    added += inserted.length;
  }
  return added;
}

/**
 * Gives up on a phone's pending messages. Deleting an account rewrites its phone, so the send job
 * could no longer tell which queued rows were theirs: the deletion calls this first, in its transaction.
 */
export async function cancelPendingFor(tx: Tx, phone: string): Promise<void> {
  await tx
    .update(notifications)
    .set({ status: 'failed', sendingAt: null })
    .where(and(eq(notifications.phone, phone), eq(notifications.status, 'pending')));
}

/**
 * Takes a person off every message kept for their phone: the phone, the dedupe keys that carry it,
 * and the variables, which hold their name. Call cancelPendingFor first, so none is still going out.
 */
export async function scrubPhone(tx: Tx, phone: string, replacement: string): Promise<void> {
  await tx
    .update(notifications)
    .set({
      phone: replacement,
      variables: {},
      dedupeKey: sql`replace(${notifications.dedupeKey}, ${phone}, ${replacement})`,
    })
    .where(eq(notifications.phone, phone));
}

/** A user's number changed, so what is still queued for them follows it. */
export async function movePendingTo(tx: Tx, from: string, to: string): Promise<void> {
  await tx
    .update(notifications)
    .set({ phone: to })
    .where(and(eq(notifications.phone, from), eq(notifications.status, 'pending')));
}

export async function enqueue(tx: Tx, n: NewNotification): Promise<void> {
  await enqueueMany(tx, [n]);
}
