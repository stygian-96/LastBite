import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { payments, refunds } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';

/** The attempt that fails on reaching this ends the refund, for an admin to pick up. */
export const MAX_REFUND_ATTEMPTS = 3;

export type NewRefund = {
  orderId: string;
  paymentId: string;
  amountPaise: number;
  reason: 'vendor_cancelled' | 'late_payment' | 'duplicate_payment' | 'issue_resolution';
  chargedTo: 'vendor' | 'platform';
  createdBy?: string;
};

/** Records a refund for the refund job to send. A second one for the same payment and reason is a no-op. */
export async function createRefund(tx: Tx, r: NewRefund): Promise<void> {
  await tx
    .insert(refunds)
    .values(r)
    .onConflictDoNothing({ target: [refunds.paymentId, refunds.reason] });
}

/**
 * Counts one definite failure on a pending refund the caller has locked. It goes back to pending
 * with no gateway ID, so the refund job sends it again as a new attempt, until the last attempt ends
 * it for an admin. A gateway ID is remembered, so a later report of it is known. A null ID is a send
 * the gateway refused outright.
 */
export async function countRefundFailure(
  tx: Tx,
  refund: { id: string; attempts: number },
  razorpayRefundId: string | null,
): Promise<void> {
  const attempts = refund.attempts + 1;
  const remembered = razorpayRefundId
    ? { failedRazorpayIds: sql`array_append(${refunds.failedRazorpayIds}, ${razorpayRefundId}::text)` }
    : {};
  if (attempts < MAX_REFUND_ATTEMPTS) {
    await tx
      .update(refunds)
      .set({ attempts, razorpayRefundId: null, sendingAt: null, ...remembered })
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
 * The transfer goes back on hold, so that the resend asks for the reversal again.
 */
export async function settleRefund(
  tx: Tx,
  refund: { id: string; attempts: number; status: string; paymentId: string },
  razorpayRefundId: string,
  result: 'processed' | 'failed',
): Promise<void> {
  if (result === 'processed') {
    await tx.update(refunds).set({ status: 'processed' }).where(eq(refunds.id, refund.id));
    return;
  }
  if (refund.status !== 'pending') return;
  await tx
    .update(payments)
    .set({ transferStatus: 'on_hold' })
    .where(and(eq(payments.id, refund.paymentId), eq(payments.transferStatus, 'reversed')));
  await countRefundFailure(tx, refund, razorpayRefundId);
}
