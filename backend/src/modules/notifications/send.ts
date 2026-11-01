import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { withTx } from '../../db/client.js';
import { notifications, users } from '../../db/schema.js';
import { getMessenger } from '../../integrations/messaging.js';
import { renderMessage, TEMPLATES, type TemplateName, type Vars } from './templates.js';

/** The most messages one run takes. */
const BATCH_SIZE = 100;
/** A claim this old was left by a run that died. The row goes again. */
const CLAIM_MS = 5 * 60_000;
/** Sends tried before a message is given up on. */
export const MAX_SEND_ATTEMPTS = 3;

type Channel = 'whatsapp' | 'sms';
type Claimed = {
  id: string;
  phone: string;
  template: TemplateName;
  variables: Vars;
  channel: Channel;
  attempts: number;
  claimedAt: string;
};

/**
 * Claims a batch of pending messages in a transaction of its own, so the provider calls run outside
 * one. Locked rows are skipped and claimed rows left alone, so two runs never share a row. A
 * customer who has turned WhatsApp off is moved to SMS here, once and for good.
 */
function claim(now: Date): Promise<Claimed[]> {
  const claimedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - CLAIM_MS).toISOString();
  return withTx(async (tx) => {
    const rows = await tx
      .select({
        id: notifications.id,
        phone: notifications.phone,
        template: notifications.template,
        variables: notifications.variables,
        channel: notifications.channel,
        attempts: notifications.attempts,
        whatsappOptIn: users.whatsappOptIn,
      })
      .from(notifications)
      .leftJoin(users, eq(users.phone, notifications.phone))
      .where(
        and(
          eq(notifications.status, 'pending'),
          or(isNull(notifications.sendingAt), lt(notifications.sendingAt, staleBefore)),
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .limit(BATCH_SIZE)
      .for('update', { of: notifications, skipLocked: true });
    if (rows.length === 0) return [];

    await tx
      .update(notifications)
      .set({ sendingAt: claimedAt })
      .where(
        inArray(
          notifications.id,
          rows.map((r) => r.id),
        ),
      );

    const moved: string[] = [];
    const claimed = rows.map((r): Claimed => {
      const optedOut = r.whatsappOptIn === false && TEMPLATES[r.template as TemplateName]?.audience === 'customer';
      const channel: Channel = r.channel === 'whatsapp' && !optedOut ? 'whatsapp' : 'sms';
      if (channel !== r.channel) moved.push(r.id);
      return {
        id: r.id,
        phone: r.phone,
        template: r.template as TemplateName,
        variables: r.variables as Vars,
        channel,
        attempts: r.attempts,
        claimedAt,
      };
    });
    if (moved.length > 0) await tx.update(notifications).set({ channel: 'sms' }).where(inArray(notifications.id, moved));
    return claimed;
  });
}

/** The row as claimed. A run that outlived its claim finds nothing here and leaves the other's result. */
const stillClaimed = (row: Claimed) =>
  and(eq(notifications.id, row.id), eq(notifications.status, 'pending'), eq(notifications.sendingAt, row.claimedAt));

async function recordSent(row: Claimed, providerId: string): Promise<void> {
  await withTx((tx) =>
    tx
      .update(notifications)
      .set({ status: 'sent', providerId, attempts: row.attempts + 1, sendingAt: null })
      .where(stillClaimed(row)),
  );
}

/** A failed WhatsApp send goes to SMS on the next run. The third failure ends the message. */
async function recordFailure(row: Claimed): Promise<void> {
  const attempts = row.attempts + 1;
  await withTx((tx) =>
    tx
      .update(notifications)
      .set({
        attempts,
        status: attempts >= MAX_SEND_ATTEMPTS ? 'failed' : 'pending',
        channel: 'sms',
        sendingAt: null,
      })
      .where(stillClaimed(row)),
  );
}

/**
 * Sends up to 100 pending messages, one try each: WhatsApp first, then SMS. Safe to run twice at
 * once. A message is sent at least once: a run that dies after the provider accepted it, before
 * saving that, sends it again once its claim runs out. Returns how many it sent.
 */
export async function sendPending(now: Date): Promise<number> {
  let sent = 0;
  for (const row of await claim(now)) {
    let providerId: string;
    try {
      const text = renderMessage(row.template, row.channel, row.variables);
      ({ providerId } = await getMessenger().send({
        phone: row.phone,
        channel: row.channel,
        template: row.template,
        variables: row.variables,
        text,
      }));
    } catch (e) {
      console.error(`Message ${row.id} failed on ${row.channel}`, e);
      await recordFailure(row).catch((err: unknown) => console.error(`Could not record message ${row.id}`, err));
      continue;
    }
    sent++;
    // A failed save leaves the claim in place, to run out and go again.
    await recordSent(row, providerId).catch((err: unknown) => console.error(`Could not record message ${row.id}`, err));
  }
  return sent;
}
