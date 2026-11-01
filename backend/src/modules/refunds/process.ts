import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, withTx } from '../../db/client.js';
import { payments, refunds } from '../../db/schema.js';
import { getGateway, GatewayRefusedError, type GatewayRefund } from '../../integrations/payments.js';
import { audit } from '../../lib/audit.js';
import { queueRefundIssued } from '../notifications/events.js';
import { countRefundFailure, settleRefund } from './create.js';

/** The most gateway calls in one run, sends and checks together. */
const BATCH_SIZE = 100;
/** A claim this old was left by a run that died. The row goes again, with the same key. */
const CLAIM_MS = 5 * 60_000;
/** How long a sent refund waits for its webhook before the gateway is asked. */
const CHECK_AFTER_MS = 15 * 60_000;
/** This many sends with an unclear result flag the refund for an admin. */
const STUCK_SEND_ERRORS = 5;

type Claimed = {
  id: string;
  attempts: number;
  amountPaise: number;
  paymentId: string;
  razorpayPaymentId: string | null;
  transferStatus: string;
  claimedAt: string;
};

/**
 * Claims a batch of unsent refunds in a transaction of its own, so the gateway calls run outside
 * one. Locked rows are skipped and claimed rows left alone, so two runs never share a row.
 */
function claimRefunds(now: Date): Promise<Claimed[]> {
  const claimedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - CLAIM_MS).toISOString();
  return withTx(async (tx) => {
    const rows = await tx
      .select({
        id: refunds.id,
        attempts: refunds.attempts,
        amountPaise: refunds.amountPaise,
        paymentId: refunds.paymentId,
        razorpayPaymentId: payments.razorpayPaymentId,
        transferStatus: payments.transferStatus,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNull(refunds.razorpayRefundId),
          or(isNull(refunds.sendingAt), lt(refunds.sendingAt, staleBefore)),
        ),
      )
      .orderBy(asc(refunds.createdAt))
      .limit(BATCH_SIZE)
      .for('update', { of: refunds, skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(refunds)
        .set({ sendingAt: claimedAt })
        .where(
          inArray(
            refunds.id,
            rows.map((r) => r.id),
          ),
        );
    }
    return rows.map((r) => ({ ...r, claimedAt }));
  });
}

/** The row as claimed. A run that outlived its claim finds nothing here, and leaves the other's result. */
const stillSending = (row: Claimed) =>
  and(
    eq(refunds.id, row.id),
    eq(refunds.status, 'pending'),
    eq(refunds.attempts, row.attempts),
    isNull(refunds.razorpayRefundId),
  );

/** Stamps the claim afresh just before a send, unless another run has taken the row over since. */
async function renewClaim(row: Claimed, at: Date): Promise<boolean> {
  const [renewed] = await db
    .update(refunds)
    .set({ sendingAt: at.toISOString() })
    .where(and(stillSending(row), eq(refunds.sendingAt, row.claimedAt)))
    .returning({ id: refunds.id });
  return renewed !== undefined;
}

/** Saves the gateway's answer. It may say processed already, as that webhook can beat this write. */
function recordSent(row: Claimed, sent: GatewayRefund, at: Date): Promise<void> {
  return withTx(async (tx) => {
    const [saved] = await tx
      .update(refunds)
      .set({
        razorpayRefundId: sent.id,
        sendingAt: null,
        lastCheckedAt: at.toISOString(),
        status: sent.status === 'processed' ? 'processed' : 'pending',
      })
      .where(stillSending(row))
      .returning({ id: refunds.id });
    if (saved && sent.status === 'processed') await queueRefundIssued(tx, row.id);
    if (saved && row.transferStatus === 'on_hold') {
      await tx
        .update(payments)
        .set({ transferStatus: 'reversed' })
        .where(and(eq(payments.id, row.paymentId), eq(payments.transferStatus, 'on_hold')));
    }
  });
}

/** The gateway said no, so this attempt is over and the next carries a new key. */
function recordFailure(row: Claimed, razorpayRefundId: string | null): Promise<void> {
  return withTx(async (tx) => {
    const [refund] = await tx
      .select({ id: refunds.id, attempts: refunds.attempts })
      .from(refunds)
      .where(stillSending(row))
      .for('update');
    if (refund) await countRefundFailure(tx, refund, razorpayRefundId);
  });
}

/**
 * The gateway may or may not have taken this refund. It goes again next run on the same key, which
 * cannot pay out twice. Moving to a new key could: a partial refund is within the payment's amount,
 * so the gateway would not stop a second one.
 */
function recordSendError(row: Claimed): Promise<void> {
  return withTx(async (tx) => {
    const [counted] = await tx
      .update(refunds)
      .set({ sendErrors: sql`${refunds.sendErrors} + 1`, sendingAt: null })
      .where(stillSending(row))
      .returning({ sendErrors: refunds.sendErrors });
    if (counted?.sendErrors !== STUCK_SEND_ERRORS) return;
    await audit(tx, {
      actorId: null,
      action: 'refund.stuck',
      entity: 'refund',
      entityId: row.id,
      detail: { sendErrors: counted.sendErrors, attempts: row.attempts },
    });
  });
}

/**
 * Sends one claimed refund. The key is fixed for the attempt, so a resend after a crash or an
 * unclear result gets the same refund back. Only the gateway call is guarded: a failure to save its
 * answer leaves the claim in place, to run out and go again on the same key.
 */
async function sendRefund(row: Claimed, clock: () => Date): Promise<boolean> {
  let sent: GatewayRefund;
  try {
    sent = await getGateway().refund({
      paymentId: row.razorpayPaymentId!,
      amountPaise: row.amountPaise,
      reverseTransfer: row.transferStatus === 'on_hold',
      idempotencyKey: `${row.id}-${row.attempts}`,
    });
  } catch (e) {
    console.error(`Refund ${row.id} failed`, e);
    if (e instanceof GatewayRefusedError) await recordFailure(row, null);
    else await recordSendError(row);
    return false;
  }
  if (sent.status === 'failed') {
    await recordFailure(row, sent.id);
    return false;
  }
  await recordSent(row, sent, clock());
  return true;
}

type Check = { id: string; razorpayRefundId: string | null };

/** Claims the sent refunds longest unchecked, stamped before asking so a bad row takes its turn at the back. */
function claimChecks(now: Date, limit: number): Promise<Check[]> {
  const before = new Date(now.getTime() - CHECK_AFTER_MS).toISOString();
  return withTx(async (tx) => {
    const rows = await tx
      .select({ id: refunds.id, razorpayRefundId: refunds.razorpayRefundId })
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'pending'),
          isNotNull(refunds.razorpayRefundId),
          or(isNull(refunds.lastCheckedAt), lt(refunds.lastCheckedAt, before)),
        ),
      )
      .orderBy(sql`${refunds.lastCheckedAt} ASC NULLS FIRST`)
      .limit(limit)
      .for('update', { skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(refunds)
        .set({ lastCheckedAt: now.toISOString() })
        .where(
          inArray(
            refunds.id,
            rows.map((r) => r.id),
          ),
        );
    }
    return rows;
  });
}

/** Asks the gateway about one sent refund, and applies a final answer as a webhook would. */
async function checkRefund(check: Check): Promise<void> {
  const razorpayRefundId = check.razorpayRefundId!;
  const { status } = await getGateway().fetchRefund(razorpayRefundId);
  if (status !== 'processed' && status !== 'failed') return;
  await withTx(async (tx) => {
    const [refund] = await tx
      .select({
        id: refunds.id,
        attempts: refunds.attempts,
        status: refunds.status,
        paymentId: refunds.paymentId,
      })
      .from(refunds)
      .where(
        and(
          eq(refunds.id, check.id),
          eq(refunds.status, 'pending'),
          eq(refunds.razorpayRefundId, razorpayRefundId),
        ),
      )
      .for('update');
    if (refund) await settleRefund(tx, refund, razorpayRefundId, status);
  });
}

/**
 * Sends pending refunds, then asks about sent ones that have heard nothing for 15 minutes, in case
 * the webhook was lost or beat the saved ID. One run makes at most 100 gateway calls, and sends go
 * first. Returns how many it sent.
 */
export async function processRefunds(now: Date): Promise<number> {
  // Tests set `now`, so a long batch's claims move on by the time this run has really taken.
  const started = Date.now();
  const clock = () => new Date(now.getTime() + Date.now() - started);

  let sent = 0;
  const claimed = await claimRefunds(now);
  for (const row of claimed) {
    try {
      if ((await renewClaim(row, clock())) && (await sendRefund(row, clock))) sent++;
    } catch (e) {
      // The row stays claimed and goes again later, and one bad row must not hold up the others.
      console.error(`Could not record refund ${row.id}`, e);
    }
  }

  const room = BATCH_SIZE - claimed.length;
  if (room === 0) return sent;
  for (const check of await claimChecks(now, room)) {
    try {
      await checkRefund(check);
    } catch (e) {
      // Its stamp sends it to the back, and one bad row must not hold up the others.
      console.error(`Could not check refund ${check.id}`, e);
    }
  }
  return sent;
}
