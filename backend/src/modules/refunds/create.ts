import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { payments, refunds } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { queueRefundIssued } from '../notifications/events.js';

/** The attempt that fails on reaching this ends the refund, for an admin to pick up. */
export const MAX_REFUND_ATTEMPTS = 3;
/** The least time between attempts after a definite failure, so one bad spell cannot use them all up. */
const RETRY_SPACING_MS = 15 * 60_000;

export type NewRefund = {
  orderId: string;
  paymentId: string;
  amountPaise: number;
  reason: 'vendor_cancelled' | 'late_payment' | 'duplicate_payment' | 'issue_resolution';
  chargedTo: 'vendor' | 'platform';
  createdBy?: string;
  /**
   * Whether the gateway reverses the transfer: for a vendor-charged refund of all that is left of the
   * payment, while the transfer is on hold. A released one is deducted from the next payout. Fixed
   * here, so one idempotency key always carries one payload.
   */
  reverseTransfer?: boolean;
  createdAt?: string;
};

/**
 * Records a refund for the refund job to send, and returns its ID. A second one for the same payment
 * and reason is a no-op, returning undefined.
 */
export async function createRefund(tx: Tx, r: NewRefund): Promise<string | undefined> {
  const [created] = await tx
    .insert(refunds)
    .values(r)
    .onConflictDoNothing({ target: [refunds.paymentId, refunds.reason] })
    .returning({ id: refunds.id });
  return created?.id;
}

/**
 * Puts a failed refund back in the queue with new terms, returning its ID, or undefined if this
 * payment and reason has no failed refund. Attempts stay, so the send carries a new key: the old
 * ones went with other payloads. Failed gateway IDs stay too, so late reports of them are known.
 */
export async function reopenFailedRefund(
  tx: Tx,
  r: Pick<NewRefund, 'paymentId' | 'reason' | 'amountPaise' | 'chargedTo' | 'createdBy' | 'reverseTransfer'>,
): Promise<string | undefined> {
  const { paymentId, reason, ...terms } = r;
  const [reopened] = await tx
    .update(refunds)
    .set({ ...terms, status: 'pending', razorpayRefundId: null, sendErrors: 0, sendingAt: null, lastCheckedAt: null, retryAt: null })
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.reason, reason), eq(refunds.status, 'failed')))
    .returning({ id: refunds.id });
  return reopened?.id;
}

/**
 * Counts one definite failure on a pending refund the caller has locked. It goes back to pending
 * with no gateway ID, so the refund job sends it again as a new attempt 15 minutes on, until the last
 * attempt ends it for an admin. A gateway ID is remembered, so a later report of it is known. A null
 * ID is a send the gateway refused outright.
 */
export async function countRefundFailure(
  tx: Tx,
  refund: { id: string; attempts: number },
  razorpayRefundId: string | null,
  at: Date,
): Promise<void> {
  const attempts = refund.attempts + 1;
  const remembered = razorpayRefundId
    ? { failedRazorpayIds: sql`array_append(${refunds.failedRazorpayIds}, ${razorpayRefundId}::text)` }
    : {};
  if (attempts < MAX_REFUND_ATTEMPTS) {
    await tx
      .update(refunds)
      .set({
        attempts,
        razorpayRefundId: null,
        sendingAt: null,
        retryAt: new Date(at.getTime() + RETRY_SPACING_MS).toISOString(),
        ...remembered,
      })
      .where(eq(refunds.id, refund.id));
    return;
  }
  await tx
    .update(refunds)
    .set({ attempts, status: 'failed', sendingAt: null, ...remembered })
    .where(eq(refunds.id, refund.id));
  await audit(tx, {
    actorId: null,
    action: 'refund.failed',
    entity: 'refund',
    entityId: refund.id,
    detail: { razorpayRefundId, attempts },
  });
}

/**
 * Applies the final word on a refund the gateway has an ID for, from a webhook or the sweep. The
 * caller has locked the row. Only pending rows count a failure, so a repeated report counts once.
 * A refund that reversed the transfer puts it back on hold, as its resend reverses it again. Any
 * other refund leaves the transfer alone: a reversal it finds came from another refund.
 */
export async function settleRefund(
  tx: Tx,
  refund: { id: string; attempts: number; status: string; paymentId: string; reverseTransfer: boolean },
  razorpayRefundId: string,
  result: 'processed' | 'failed',
  at: Date,
): Promise<void> {
  if (result === 'processed') {
    await tx.update(refunds).set({ status: 'processed' }).where(eq(refunds.id, refund.id));
    await queueRefundIssued(tx, refund.id);
    return;
  }
  if (refund.status !== 'pending') return;
  if (refund.reverseTransfer) {
    await tx
      .update(payments)
      .set({ transferStatus: 'on_hold' })
      .where(and(eq(payments.id, refund.paymentId), eq(payments.transferStatus, 'reversed')));
  }
  await countRefundFailure(tx, refund, razorpayRefundId, at);
}
