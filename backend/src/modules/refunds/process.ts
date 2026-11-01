import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { withTx } from '../../db/client.js';
import { payments, refunds } from '../../db/schema.js';
import { getGateway } from '../../integrations/payments.js';
import { countRefundFailure } from '../payments/webhook.js';

const BATCH_SIZE = 100;
/** A claim this old was left by a run that died. The row goes again, with the same key. */
const CLAIM_MS = 5 * 60_000;

type Claimed = {
  id: string;
  attempts: number;
  amountPaise: number;
  paymentId: string;
  razorpayPaymentId: string | null;
  transferStatus: string;
};

/**
 * Claims a batch of unsent refunds in a transaction of its own, so the gateway calls run outside
 * one. Locked rows are skipped and claimed rows left alone, so two runs never share a row.
 */
function claimRefunds(now: Date): Promise<Claimed[]> {
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
        .set({ sendingAt: now.toISOString() })
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

/** The row as claimed. A run that outlived its claim finds nothing here, and leaves the other's result. */
const stillSending = (row: Claimed) =>
  and(
    eq(refunds.id, row.id),
    eq(refunds.status, 'pending'),
    eq(refunds.attempts, row.attempts),
    isNull(refunds.razorpayRefundId),
  );

/** Saves the gateway's answer. It may say processed already, as that webhook can beat this write. */
function recordSent(row: Claimed, sent: { id: string; status: string }): Promise<void> {
  return withTx(async (tx) => {
    const [saved] = await tx
      .update(refunds)
      .set({ razorpayRefundId: sent.id, sendingAt: null, status: sent.status === 'processed' ? 'processed' : 'pending' })
      .where(stillSending(row))
      .returning({ id: refunds.id });
    if (saved && row.transferStatus === 'on_hold') {
      await tx
        .update(payments)
        .set({ transferStatus: 'reversed' })
        .where(and(eq(payments.id, row.paymentId), eq(payments.transferStatus, 'on_hold')));
    }
  });
}

function recordFailure(row: Claimed): Promise<void> {
  return withTx(async (tx) => {
    const [refund] = await tx
      .select({ id: refunds.id, attempts: refunds.attempts })
      .from(refunds)
      .where(stillSending(row))
      .for('update');
    if (refund) await countRefundFailure(tx, refund, null);
  });
}

/**
 * Sends one claimed refund. The key is fixed for the attempt, so a resend after a crash gets the
 * same refund back. Only the gateway call is guarded: a failure to save its answer must not count
 * as a failed send, or the next try would carry a new key.
 */
async function sendRefund(row: Claimed): Promise<boolean> {
  let sent;
  try {
    sent = await getGateway().refund({
      paymentId: row.razorpayPaymentId!,
      amountPaise: row.amountPaise,
      reverseTransfer: row.transferStatus === 'on_hold',
      idempotencyKey: `${row.id}-${row.attempts}`,
    });
  } catch (e) {
    console.error(`Refund ${row.id} failed`, e);
    await recordFailure(row);
    return false;
  }
  await recordSent(row, sent);
  return true;
}

/** Sends pending refunds to the gateway, at most 100 a run. Returns how many it sent. */
export async function processRefunds(now: Date): Promise<number> {
  let sent = 0;
  for (const row of await claimRefunds(now)) {
    try {
      if (await sendRefund(row)) sent++;
    } catch (e) {
      // The row stays claimed and goes again later, and one bad row must not hold up the others.
      console.error(`Could not record refund ${row.id}`, e);
    }
  }
  return sent;
}
