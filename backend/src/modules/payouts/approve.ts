import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { orders, payments, payoutAccounts, payouts, refunds } from '../../db/schema.js';
import { getGateway, type GatewayTransfer } from '../../integrations/payments.js';
import { audit } from '../../lib/audit.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { absorbNegativePayouts, carriedBalance, negativePayouts } from './balance.js';
import { netOf, sumOrders, type Payout } from './build.js';
import { MAX_LINK_FAILURES, refundIsUnsent } from './transfers.js';

const invalidState = () => new ApiError('invalid_state', 409, 'That change is not allowed from the current status');
const notFound = (what: string) => new ApiError('not_found', 404, `${what} not found`);
const incomplete = () => new ApiError('release_incomplete', 502, 'Some transfers were not released. Try again');
const isId = (id: string) => z.uuid().safeParse(id).success;
const holdReason = z.string().trim().min(1).max(500);
const approvalInProgress = (payoutId: string) =>
  new ApiError('approval_in_progress', 409, 'An approval on this account has to finish first. Retry the payout it stopped on', {
    payoutId,
  });
const gatewayUnavailable = () =>
  new ApiError('gateway_unavailable', 409, 'Could not check this payout with the gateway. Try again shortly');

/**
 * The account is locked first, as buildPayouts and verifyPayoutAccount do, and then the payout. A
 * start takes the account exclusively, so two approvals cannot both see it free.
 */
async function lockPayout(tx: Tx, payoutId: string, accountLock: 'share' | 'update' = 'share'): Promise<Payout> {
  const [known] = await tx
    .select({ accountId: payouts.payoutAccountId })
    .from(payouts)
    .where(eq(payouts.id, payoutId));
  if (!known) throw notFound('Payout');
  await tx.select({ id: payoutAccounts.id }).from(payoutAccounts).where(eq(payoutAccounts.id, known.accountId)).for(accountLock);
  const [payout] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for('update');
  return payout!;
}

/**
 * Transfers still on hold for this payout. A payout carried here while negative counted its orders
 * in its balance, and that balance is in this payout's net, so their transfers go now too. Largest
 * first by the amount sent, which never changes, so a retry works in the first run's order.
 */
function heldTransfers(tx: Tx, payout: Payout) {
  return tx
    .select({
      paymentId: payments.id,
      orderId: orders.id,
      razorpayTransferId: payments.razorpayTransferId,
      transferPaise: payments.transferPaise,
      reversedPaise: payments.reversedPaise,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(payouts, eq(payouts.id, orders.payoutId))
    .where(
      and(
        eq(payouts.payoutAccountId, payout.payoutAccountId),
        or(eq(payouts.id, payout.id), eq(payouts.status, 'released')),
        eq(payments.transferStatus, 'on_hold'),
      ),
    )
    .then((rows) =>
      rows.sort((a, b) => b.transferPaise! - a.transferPaise! || a.paymentId.localeCompare(b.paymentId)),
    );
}

type Held = Awaited<ReturnType<typeof heldTransfers>>[number];

const remainingPaise = (row: Held) => row.transferPaise! - row.reversedPaise;

/** Every transfer this payout's approval may have touched, on hold or released by it. */
function transfersInScope(payout: Payout) {
  return db
    .select({
      paymentId: payments.id,
      orderId: orders.id,
      razorpayPaymentId: payments.razorpayPaymentId,
      razorpayTransferId: payments.razorpayTransferId,
      transferPaise: payments.transferPaise,
      reversedPaise: payments.reversedPaise,
      transferStatus: payments.transferStatus,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(payouts, eq(payouts.id, orders.payoutId))
    .where(
      and(
        eq(payouts.payoutAccountId, payout.payoutAccountId),
        or(eq(payouts.id, payout.id), eq(payouts.status, 'released')),
        or(eq(payments.transferStatus, 'on_hold'), eq(payments.releasedPayoutId, payout.id)),
      ),
    );
}

type InScope = Awaited<ReturnType<typeof transfersInScope>>[number];

/**
 * Brings one payment in line with what the gateway says, under the order lock. Only a row unchanged
 * since it was read is touched, as an overlapping retry of this payout may have recorded it. A
 * transfer the gateway calls reversed has nothing left, whatever our status: a refund's reversal is
 * for the refund path to record.
 */
function correctFromGateway(payoutId: string, adminId: string, row: InScope, found: GatewayTransfer): Promise<void> {
  const reversedPaise = row.transferPaise! - found.amountPaise;
  const transferStatus = found.status === 'reversed' ? row.transferStatus : found.status;
  if (reversedPaise === row.reversedPaise && transferStatus === row.transferStatus) return Promise.resolve();
  return withTx(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, row.orderId)).for('update');
    const [saved] = await tx
      .update(payments)
      .set({ reversedPaise, transferStatus, releasedPayoutId: transferStatus === 'released' ? payoutId : null })
      .where(
        and(
          eq(payments.id, row.paymentId),
          eq(payments.reversedPaise, row.reversedPaise),
          eq(payments.transferStatus, row.transferStatus),
        ),
      )
      .returning({ id: payments.id });
    if (!saved) return;
    if (transferStatus === 'released' && row.transferStatus !== 'released') await stopReversal(tx, row, row.razorpayTransferId!);
    await audit(tx, {
      actorId: adminId,
      action: 'payout.reconciled_gateway',
      entity: 'payout',
      entityId: payoutId,
      detail: {
        paymentId: row.paymentId,
        orderId: row.orderId,
        razorpayTransferId: row.razorpayTransferId,
        reversedPaise: { from: row.reversedPaise, to: reversedPaise },
        transferStatus: { from: row.transferStatus, to: transferStatus },
      },
    });
  });
}

/**
 * The start of every retry. A failed try may have lost an answer the gateway acted on, so what is
 * recorded cannot be trusted, and everything after this reasons from it. It runs before the retry
 * touches anything: if a transfer cannot be read the mark stays, for another try.
 */
async function reconcileWithGateway(adminId: string, payoutId: string): Promise<void> {
  const [payout] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!payout?.approvingAt) return;
  for (const row of await transfersInScope(payout)) {
    let found: GatewayTransfer | undefined;
    try {
      const listed = await getGateway().listPaymentTransfers(row.razorpayPaymentId!);
      found = listed.find((t) => t.id === row.razorpayTransferId);
    } catch (e) {
      console.error(`Could not read the transfers of payment ${row.paymentId}`, e);
    }
    if (!found) throw gatewayUnavailable();
    await correctFromGateway(payoutId, adminId, row, found);
  }
}

/**
 * Checks the payout can go, brings it into line with the money as it stands, and lists what to
 * release against the net. A negative payout still waiting is taken in here, as the balance counts
 * it. A payout left negative cannot be paid: it goes back to held, to carry forward, and returns
 * nothing.
 *
 * One approval at a time per account, or two would each reverse the same excess. It is marked here
 * and stays marked through a failure, with no timeout: an admin retries that payout, and until it
 * finishes no other on the account can start. A retry has reconciled with the gateway by now, which
 * is what makes it safe for the negative exit to clear the mark.
 */
function startApproval(adminId: string, payoutId: string, now: Date) {
  return withTx(async (tx) => {
    const payout = await lockPayout(tx, payoutId, 'update');
    const [account] = await tx
      .select({ status: payoutAccounts.status })
      .from(payoutAccounts)
      .where(eq(payoutAccounts.id, payout.payoutAccountId));
    if (account!.status === 'on_hold') {
      throw new ApiError('account_on_hold', 409, 'This payout account is on hold until its bank details are verified');
    }
    if (payout.status !== 'draft') throw invalidState();
    const [other] = await tx
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(eq(payouts.payoutAccountId, payout.payoutAccountId), ne(payouts.id, payoutId), isNotNull(payouts.approvingAt)),
      );
    if (other) throw approvalInProgress(other.id);

    const waiting = await tx
      .select({ id: payouts.id })
      .from(payouts)
      .where(and(negativePayouts(payout.payoutAccountId), ne(payouts.id, payoutId)))
      .for('update');
    await absorbNegativePayouts(
      tx,
      waiting.map((p) => p.id),
    );

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

    const netPaise = await reconcilePayout(tx, adminId, payout);
    if (netPaise < 0) {
      await tx.update(payouts).set({ status: 'held', approvingAt: null }).where(eq(payouts.id, payoutId));
      await audit(tx, { actorId: adminId, action: 'payout.held', entity: 'payout', entityId: payoutId, detail: { netPaise } });
      // A retry that lands here may have moved money on its first try.
      if (payout.approvingAt) await flagMismatch(tx, adminId, payoutId, netPaise, { unlessNothingMoved: true });
      return undefined;
    }
    if (!payout.approvingAt) {
      await tx.update(payouts).set({ approvingAt: now.toISOString() }).where(eq(payouts.id, payoutId));
    }
    return { held, netPaise };
  });
}

/** Records a reversal once, however many approvals raced to it. The order lock is what refunds hold. */
function recordReversal(row: Held, amountPaise: number): Promise<void> {
  return withTx(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, row.orderId)).for('update');
    await tx
      .update(payments)
      .set({ reversedPaise: row.reversedPaise + amountPaise })
      .where(and(eq(payments.id, row.paymentId), eq(payments.reversedPaise, row.reversedPaise)));
  });
}

/**
 * Whole transfers can only be released, so what they hold beyond the net, which is what the negative
 * adjustment comes to, is reversed first, largest transfer first. Only reversed_paise counts, so a
 * retry finds nothing left to do. A retry after a lost answer plans the same reversal on the same
 * key: the order is fixed, and each transfer is reversed at most once for a payout. The list comes
 * back in the order it went in.
 */
async function settleAdjustment(payoutId: string, held: Held[], netPaise: number): Promise<Held[]> {
  let owedPaise = held.reduce((sum, row) => sum + remainingPaise(row), 0) - netPaise;
  if (owedPaise <= 0) return held;

  const settled: Held[] = [];
  for (const row of held) {
    const amountPaise = Math.min(owedPaise, remainingPaise(row));
    if (amountPaise === 0) {
      settled.push(row);
      continue;
    }
    try {
      await getGateway().reverseTransferPartial(row.razorpayTransferId!, amountPaise, `reversal-${payoutId}-${row.paymentId}`);
    } catch (e) {
      console.error(`Could not reverse part of the transfer of payment ${row.paymentId}`, e);
      throw incomplete();
    }
    await recordReversal(row, amountPaise);
    owedPaise -= amountPaise;
    settled.push({ ...row, reversedPaise: row.reversedPaise + amountPaise });
  }
  return settled;
}

/**
 * A refund that read on_hold during a release call planned a reversal, and now that cannot happen:
 * unsent, it stops reversing and comes off the next payout as an adjustment. Sent, it is flagged for
 * an admin. The caller holds the order.
 */
async function stopReversal(tx: Tx, row: { paymentId: string; orderId: string }, razorpayTransferId: string): Promise<void> {
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
}

/** Marks one transfer released under the order lock, which is what a refund holds when it reads the status. */
function markReleased(payoutId: string, row: { paymentId: string; orderId: string }, razorpayTransferId: string): Promise<void> {
  return withTx(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, row.orderId)).for('update');
    const [marked] = await tx
      .update(payments)
      .set({ transferStatus: 'released', releasedPayoutId: payoutId })
      .where(and(eq(payments.id, row.paymentId), eq(payments.transferStatus, 'on_hold')))
      .returning({ id: payments.id });
    if (marked) await stopReversal(tx, row, razorpayTransferId);
  });
}

/**
 * Works the payout out afresh: orders whose transfer was reversed since the build come off it, as
 * the vendor is not getting that money, and the balance carried in is worked out again, as a
 * reversal on an earlier payout moves it. Returns the net.
 */
async function reconcilePayout(tx: Tx, adminId: string, payout: Payout): Promise<number> {
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
  const [own] = await tx
    .select({ paise: sql<number>`coalesce(sum(${refunds.amountPaise}), 0)::int` })
    .from(refunds)
    .where(eq(refunds.adjustedPayoutId, payout.id));
  const adjustmentPaise = (await carriedBalance(tx, payout.payoutAccountId, payout.id)) - own!.paise;
  const totals = sumOrders(rows.filter((r) => r.transferStatus !== 'reversed'));
  const netPaise = netOf(totals, adjustmentPaise);
  if (removed.length === 0 && adjustmentPaise === payout.adjustmentPaise) return netPaise;

  if (removed.length > 0) await tx.update(orders).set({ payoutId: null }).where(inArray(orders.id, removed));
  await tx.update(payouts).set({ ...totals, adjustmentPaise, netPaise }).where(eq(payouts.id, payout.id));
  await audit(tx, {
    actorId: adminId,
    action: 'payout.reconciled',
    entity: 'payout',
    entityId: payout.id,
    detail: { removedOrders: removed, adjustmentPaise, netPaise },
  });
  return netPaise;
}

/** Flags money moved by an approval that differs from the net. The next balance makes it good by itself. */
async function flagMismatch(
  tx: Tx,
  adminId: string,
  payoutId: string,
  netPaise: number,
  { unlessNothingMoved = false } = {},
): Promise<void> {
  const [moved] = await tx
    .select({ paise: sql<number>`coalesce(sum(${payments.transferPaise} - ${payments.reversedPaise}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.releasedPayoutId, payoutId), eq(payments.transferStatus, 'released')));
  if (moved!.paise === netPaise || (unlessNothingMoved && moved!.paise === 0)) return;
  await audit(tx, {
    actorId: adminId,
    action: 'payout.mismatch',
    entity: 'payout',
    entityId: payoutId,
    detail: { movedPaise: moved!.paise, netPaise, differencePaise: moved!.paise - netPaise },
  });
}

/**
 * Ends the approval once every transfer has gone. If what landed meanwhile turns the net negative,
 * the payout stays held and carries, as any negative one does. Money moved may then differ from the
 * net: that is flagged, and the next payout's balance makes it good by itself.
 */
function finishApproval(adminId: string, payoutId: string, now: Date): Promise<void> {
  return withTx(async (tx) => {
    const payout = await lockPayout(tx, payoutId);
    if (payout.status !== 'draft') return;
    const netPaise = await reconcilePayout(tx, adminId, payout);
    if ((await heldTransfers(tx, payout)).length > 0) throw incomplete();
    const status = netPaise < 0 ? 'held' : 'released';
    await tx.update(payouts).set({ status, approvingAt: null }).where(eq(payouts.id, payoutId));
    await flagMismatch(tx, adminId, payoutId, netPaise);
    await audit(tx, {
      actorId: adminId,
      action: 'payout.approve',
      entity: 'payout',
      entityId: payoutId,
      detail: { status, netPaise, at: now.toISOString() },
    });
  });
}

/**
 * Settles a draft payout's adjustment against its transfers, then releases them, all outside any
 * transaction, so what the vendor receives is the net exactly. A transfer reversed in full has
 * nothing to release. Each is marked as its call returns, and the payout moves only after all have
 * gone, so a failure leaves a draft and a retry picks up the rest. A transfer a refund reversed in
 * the meantime is passed over.
 */
export async function approvePayout(adminId: string, payoutId: string, now: Date): Promise<void> {
  if (!isId(payoutId)) throw notFound('Payout');
  await reconcileWithGateway(adminId, payoutId);
  const started = await startApproval(adminId, payoutId, now);
  if (!started) throw new ApiError('payout_negative', 409, 'The transfers cannot cover this payout, so it stays held and carries forward');

  for (const row of await settleAdjustment(payoutId, started.held, started.netPaise)) {
    const [current] = await db
      .select({ transferStatus: payments.transferStatus })
      .from(payments)
      .where(eq(payments.id, row.paymentId));
    if (current!.transferStatus !== 'on_hold') continue;
    try {
      if (remainingPaise(row) > 0) await getGateway().releaseTransfer(row.razorpayTransferId!);
    } catch (e) {
      console.error(`Could not release the transfer of payment ${row.paymentId}`, e);
      throw incomplete();
    }
    await markReleased(payoutId, row, row.razorpayTransferId!);
  }
  await finishApproval(adminId, payoutId, now);
}

/** Stops a draft going while an admin looks into it, such as a vendor who has gone dark. */
export async function holdPayout(adminId: string, payoutId: string, rawReason: string, now: Date): Promise<void> {
  if (!isId(payoutId)) throw notFound('Payout');
  const reason = parseInput(holdReason, rawReason);
  await withTx(async (tx) => {
    const payout = await lockPayout(tx, payoutId);
    if (payout.approvingAt) throw approvalInProgress(payout.id);
    if (payout.status !== 'draft') throw invalidState();
    await tx.update(payouts).set({ status: 'held', holdReason: reason }).where(eq(payouts.id, payoutId));
    await audit(tx, { actorId: adminId, action: 'payout.hold', entity: 'payout', entityId: payoutId, detail: { reason, at: now.toISOString() } });
  });
}

/** Ends an admin's hold. A payout held for its account or a negative net is not theirs to end here. */
export async function unholdPayout(adminId: string, payoutId: string, now: Date): Promise<void> {
  if (!isId(payoutId)) throw notFound('Payout');
  await withTx(async (tx) => {
    const payout = await lockPayout(tx, payoutId);
    if (payout.status !== 'held' || payout.holdReason === null) throw invalidState();
    await tx.update(payouts).set({ status: 'draft', holdReason: null }).where(eq(payouts.id, payoutId));
    await audit(tx, { actorId: adminId, action: 'payout.unhold', entity: 'payout', entityId: payoutId, detail: { at: now.toISOString() } });
  });
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

/** An admin clears a linked account the job gave up on. It resumes where it stopped, on the same email. */
async function retryLinkedAccount(tx: Tx, adminId: string, accountId: string, failures: number, now: Date): Promise<void> {
  await tx
    .update(payoutAccounts)
    .set({ linkedAccountFailures: 0, linkedClaimedAt: null })
    .where(eq(payoutAccounts.id, accountId));
  await audit(tx, {
    actorId: adminId,
    action: 'payout_account.link_retry',
    entity: 'payout_account',
    entityId: accountId,
    detail: { failures, at: now.toISOString() },
  });
}

/**
 * An admin's decision on changed bank details. The linked account is cleared, so the job makes a new
 * one from them on a new email, and payouts held for the account can go. A negative one stays held to
 * be carried, and one an admin holds stays until they say. On a verified account the job gave up
 * linking, with no bank change, this only sets it going again.
 */
export async function verifyPayoutAccount(adminId: string, accountId: string, now: Date): Promise<void> {
  if (!isId(accountId)) throw notFound('Payout account');
  await withTx(async (tx) => {
    const [account] = await tx.select().from(payoutAccounts).where(eq(payoutAccounts.id, accountId)).for('update');
    if (!account) throw notFound('Payout account');
    if (account.status === 'verified' && account.linkedAccountFailures >= MAX_LINK_FAILURES) {
      return retryLinkedAccount(tx, adminId, accountId, account.linkedAccountFailures, now);
    }
    if (account.status !== 'on_hold') throw invalidState();
    await tx
      .update(payoutAccounts)
      .set({
        status: 'verified',
        razorpayAccountId: null,
        linkedProductId: null,
        linkedAccountStep: 'none',
        linkedAccountFailures: 0,
        linkedAccountGeneration: account.linkedAccountGeneration + 1,
        linkedClaimedAt: null,
      })
      .where(eq(payoutAccounts.id, accountId));
    const held = await tx.select().from(payouts).where(and(eq(payouts.payoutAccountId, accountId), eq(payouts.status, 'held'))).for('update');
    const freed = held.filter((p) => p.netPaise >= 0 && p.holdReason === null).map((p) => p.id);
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

