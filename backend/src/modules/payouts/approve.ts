import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { withTx, type Tx } from '../../db/client.js';
import { orders, payments, payoutAccounts, payouts, refunds } from '../../db/schema.js';
import { getGateway } from '../../integrations/payments.js';
import { audit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { netOf, sumOrders, type Payout } from './build.js';
import { refundIsUnsent } from './transfers.js';

const invalidState = () => new ApiError('invalid_state', 409, 'That change is not allowed from the current status');
const notFound = (what: string) => new ApiError('not_found', 404, `${what} not found`);
const incomplete = () => new ApiError('release_incomplete', 502, 'Some transfers were not released. Try again');
const isId = (id: string) => z.uuid().safeParse(id).success;

/** The account is locked first, as buildPayouts and verifyPayoutAccount do, and then the payout. */
async function lockPayout(tx: Tx, payoutId: string): Promise<Payout> {
  const [known] = await tx
    .select({ accountId: payouts.payoutAccountId })
    .from(payouts)
    .where(eq(payouts.id, payoutId));
  if (!known) throw notFound('Payout');
  await tx.select({ id: payoutAccounts.id }).from(payoutAccounts).where(eq(payoutAccounts.id, known.accountId)).for('share');
  const [payout] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for('update');
  return payout!;
}

/**
 * Transfers still on hold for this payout. A payout carried here while negative counted its orders
 * in its balance, and that balance is in this payout's net, so their transfers go now too.
 */
function heldTransfers(tx: Tx, payout: Payout) {
  return tx
    .select({ paymentId: payments.id, orderId: orders.id, razorpayTransferId: payments.razorpayTransferId })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(payouts, eq(payouts.id, orders.payoutId))
    .where(
      and(
        eq(payouts.payoutAccountId, payout.payoutAccountId),
        or(eq(payouts.id, payout.id), eq(payouts.status, 'released')),
        eq(payments.transferStatus, 'on_hold'),
      ),
    );
}

/** Checks the payout can go, and lists what to release. */
function startApproval(payoutId: string) {
  return withTx(async (tx) => {
    const payout = await lockPayout(tx, payoutId);
    const [account] = await tx
      .select({ status: payoutAccounts.status })
      .from(payoutAccounts)
      .where(eq(payoutAccounts.id, payout.payoutAccountId));
    if (account!.status === 'on_hold') {
      throw new ApiError('account_on_hold', 409, 'This payout account is on hold until its bank details are verified');
    }
    if (payout.status !== 'draft') throw invalidState();

    const held = await heldTransfers(tx, payout);
    if (held.length > 0) {
      const [reversing] = await tx
        .select({ id: refunds.id })
        .from(refunds)
        .where(
          and(
            inArray(
              refunds.paymentId,
              held.map((h) => h.paymentId),
            ),
            eq(refunds.reverseTransfer, true),
            eq(refunds.status, 'pending'),
          ),
        )
        .limit(1);
      if (reversing) throw new ApiError('refund_pending', 409, 'A refund is reversing a transfer on this payout. Try again shortly');
    }
    return held;
  });
}

/**
 * Marks one transfer released under the order lock, which is what a refund holds when it reads the
 * transfer's status. A refund that read on_hold during the release call planned a reversal, and now
 * that cannot happen: unsent, it stops reversing and comes off the next payout as an adjustment.
 * Sent, it is flagged for an admin.
 */
function markReleased(row: { paymentId: string; orderId: string }, razorpayTransferId: string): Promise<void> {
  return withTx(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, row.orderId)).for('update');
    const [marked] = await tx
      .update(payments)
      .set({ transferStatus: 'released' })
      .where(and(eq(payments.id, row.paymentId), eq(payments.transferStatus, 'on_hold')))
      .returning({ id: payments.id });
    if (!marked) return;

    const [refund] = await tx
      .select()
      .from(refunds)
      .where(and(eq(refunds.paymentId, row.paymentId), eq(refunds.reverseTransfer, true), eq(refunds.status, 'pending')))
      .limit(1)
      .for('update');
    if (!refund) return;
    if (refundIsUnsent(refund)) {
      await tx.update(refunds).set({ reverseTransfer: false }).where(eq(refunds.id, refund.id));
      return;
    }
    await audit(tx, {
      actorId: null,
      action: 'transfer.reversal_after_release',
      entity: 'payment',
      entityId: row.paymentId,
      detail: { orderId: row.orderId, razorpayTransferId, refundId: refund.id },
    });
  });
}

/**
 * Takes orders whose transfer was reversed since the build off the payout, as the vendor is not
 * getting that money, and brings its totals back into line. Returns the orders removed.
 */
async function removeReversedOrders(tx: Tx, payout: Payout): Promise<{ removed: string[]; netPaise: number }> {
  const rows = await tx
    .select({
      id: orders.id,
      pricePaise: orders.pricePaise,
      commissionPaise: orders.commissionPaise,
      taxPaise: orders.taxPaise,
      feePaise: payments.feePaise,
      transferStatus: payments.transferStatus,
    })
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(and(eq(orders.payoutId, payout.id), inArray(payments.transferStatus, ['released', 'on_hold', 'reversed'])));
  const removed = rows.filter((r) => r.transferStatus === 'reversed').map((r) => r.id);
  if (removed.length === 0) return { removed, netPaise: payout.netPaise };

  await tx.update(orders).set({ payoutId: null }).where(inArray(orders.id, removed));
  const totals = sumOrders(rows.filter((r) => r.transferStatus !== 'reversed'));
  const netPaise = netOf(totals, payout.adjustmentPaise);
  await tx.update(payouts).set({ ...totals, netPaise }).where(eq(payouts.id, payout.id));
  return { removed, netPaise };
}

/**
 * Ends the approval once every transfer has gone. If removing reversed orders turns the net
 * negative, the payout stays held and carries into the next build, as any negative one does.
 */
function finishApproval(adminId: string, payoutId: string, now: Date): Promise<void> {
  return withTx(async (tx) => {
    const payout = await lockPayout(tx, payoutId);
    if (payout.status !== 'draft') return;
    const { removed, netPaise } = await removeReversedOrders(tx, payout);
    if ((await heldTransfers(tx, payout)).length > 0) throw incomplete();
    const status = netPaise < 0 ? 'held' : 'released';
    await tx.update(payouts).set({ status }).where(eq(payouts.id, payoutId));
    await audit(tx, {
      actorId: adminId,
      action: 'payout.approve',
      entity: 'payout',
      entityId: payoutId,
      detail: { status, netPaise, removedOrders: removed, at: now.toISOString() },
    });
  });
}

/**
 * Releases a draft payout's transfers, outside any transaction, marking each as its call returns.
 * The payout moves only after all have gone, so a failure leaves a draft and a retry picks up the rest.
 */
export async function approvePayout(adminId: string, payoutId: string, now: Date): Promise<void> {
  if (!isId(payoutId)) throw notFound('Payout');
  for (const row of await startApproval(payoutId)) {
    try {
      await getGateway().releaseTransfer(row.razorpayTransferId!);
    } catch (e) {
      console.error(`Could not release the transfer of payment ${row.paymentId}`, e);
      throw incomplete();
    }
    await markReleased(row, row.razorpayTransferId!);
  }
  await finishApproval(adminId, payoutId, now);
}

/** Records that the money arrived. A carried negative payout is released too, but no money went. */
export async function markPayoutPaid(adminId: string, payoutId: string, now: Date): Promise<void> {
  if (!isId(payoutId)) throw notFound('Payout');
  await withTx(async (tx) => {
    const [payout] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for('update');
    if (!payout) throw notFound('Payout');
    if (payout.status !== 'released' || payout.netPaise < 0) throw invalidState();
    await tx.update(payouts).set({ status: 'paid', paidAt: now.toISOString() }).where(eq(payouts.id, payoutId));
    await audit(tx, { actorId: adminId, action: 'payout.mark_paid', entity: 'payout', entityId: payoutId, detail: { netPaise: payout.netPaise } });
  });
}

/**
 * An admin's decision on changed bank details. The linked account is cleared, so the job makes a new
 * one from them, and payouts held for the account can go. A negative one stays held to be carried.
 */
export async function verifyPayoutAccount(adminId: string, accountId: string, now: Date): Promise<void> {
  if (!isId(accountId)) throw notFound('Payout account');
  await withTx(async (tx) => {
    const [account] = await tx.select().from(payoutAccounts).where(eq(payoutAccounts.id, accountId)).for('update');
    if (!account) throw notFound('Payout account');
    if (account.status !== 'on_hold') throw invalidState();
    await tx
      .update(payoutAccounts)
      .set({ status: 'verified', razorpayAccountId: null, linkedClaimedAt: null })
      .where(eq(payoutAccounts.id, accountId));
    const held = await tx.select().from(payouts).where(and(eq(payouts.payoutAccountId, accountId), eq(payouts.status, 'held'))).for('update');
    const freed = held.filter((p) => p.netPaise >= 0).map((p) => p.id);
    if (freed.length > 0) await tx.update(payouts).set({ status: 'draft' }).where(inArray(payouts.id, freed));
    await audit(tx, {
      actorId: adminId,
      action: 'payout_account.verify',
      entity: 'payout_account',
      entityId: accountId,
      detail: { previousLinkedAccount: account.razorpayAccountId, payoutsFreed: freed, at: now.toISOString() },
    });
  });
}

