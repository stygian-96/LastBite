import type { Tx } from '../../db/client.js';
import { refunds } from '../../db/schema.js';

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
