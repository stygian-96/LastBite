import { and, asc, eq, inArray, isNotNull, isNull, lt, not, notExists, notInArray, or, sql } from 'drizzle-orm';
import { db, withTx, type Tx } from '../../db/client.js';
import { areas, auditLog, memberships, orders, outlets, payments, payoutAccounts, refunds, users } from '../../db/schema.js';
import { getGateway } from '../../integrations/payments.js';
import { audit } from '../../lib/audit.js';
import { decrypt } from '../../lib/crypto.js';
import { vendorNetPaise } from '../../lib/money.js';
import { NOT_THE_BAG_REASONS } from '../refunds/cancel.js';

/** The most gateway calls of one kind in one run. */
const BATCH_SIZE = 100;
/** A claim this old was left by a run that died or hit an error. The row goes again. */
const CLAIM_MS = 5 * 60_000;
/** Razorpay's limit on reference_id. */
const REFERENCE_LENGTH = 20;
/** Order statuses in which the vendor's bag was sold and not cancelled. */
const TRANSFERABLE_STATUSES = ['paid', 'collected', 'no_show'];

const staleBefore = (now: Date) => new Date(now.getTime() - CLAIM_MS).toISOString();

/** Any captured row beyond the one that bought the bag was refunded as late or duplicate. */
export const isBagPayment = and(
  eq(payments.status, 'captured'),
  notExists(
    db
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.paymentId, payments.id), inArray(refunds.reason, NOT_THE_BAG_REASONS))),
  ),
);

/** The whole payment is going back and the vendor is charged for it, so the vendor earns nothing. */
export const vendorRefundCovers = sql`(
  EXISTS (
    SELECT 1 FROM refunds r
     WHERE r.payment_id = ${payments.id} AND r.charged_to = 'vendor' AND r.status <> 'failed'
  ) AND (
    SELECT coalesce(sum(r.amount_paise), 0) FROM refunds r
     WHERE r.payment_id = ${payments.id} AND r.status <> 'failed'
  ) >= ${payments.amountPaise}
)`;

/**
 * Whether a refund's payload is still ours to change. Being claimed or having had an unclear send
 * means its key may have gone with the payload it has now.
 */
export const refundIsUnsent = (r: { razorpayRefundId: string | null; sendingAt: string | null; sendErrors: number }) =>
  r.razorpayRefundId === null && r.sendingAt === null && r.sendErrors === 0;

// ---------- Linked accounts ----------

type ClaimedAccount = typeof payoutAccounts.$inferSelect & { linkedClaimedAt: string };

/** Claims verified accounts with no linked account, in a transaction of its own. */
function claimLinkedAccounts(now: Date): Promise<ClaimedAccount[]> {
  const claimedAt = now.toISOString();
  return withTx(async (tx) => {
    const rows = await tx
      .select()
      .from(payoutAccounts)
      .where(
        and(
          eq(payoutAccounts.status, 'verified'),
          isNull(payoutAccounts.razorpayAccountId),
          or(isNull(payoutAccounts.linkedClaimedAt), lt(payoutAccounts.linkedClaimedAt, staleBefore(now))),
        ),
      )
      .orderBy(asc(payoutAccounts.createdAt))
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(payoutAccounts)
        .set({ linkedClaimedAt: claimedAt })
        .where(
          inArray(
            payoutAccounts.id,
            rows.map((r) => r.id),
          ),
        );
    }
    return rows.map((r) => ({ ...r, linkedClaimedAt: claimedAt }));
  });
}

/** Who the gateway should know for this account: the member it names, or else the brand owner. */
async function accountContact(account: ClaimedAccount) {
  const [contact] = await db
    .select({ name: users.name, phone: users.phone, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.brandId, account.brandId),
        isNull(memberships.removedAt),
        or(
          eq(memberships.payoutAccountId, account.id),
          and(eq(memberships.role, 'owner'), isNull(memberships.outletId)),
        ),
      ),
    )
    .orderBy(sql`(${memberships.payoutAccountId} IS NOT DISTINCT FROM ${account.id}::uuid) DESC`)
    .limit(1);
  if (!contact) throw new Error(`Payout account ${account.id} has nobody to contact`);
  return contact;
}

async function accountAddress(accountId: string) {
  const [outlet] = await db
    .select({ street: outlets.address, city: areas.city, postalCode: outlets.pincode })
    .from(outlets)
    .leftJoin(areas, eq(areas.id, outlets.areaId))
    .where(eq(outlets.payoutAccountId, accountId))
    .orderBy(asc(outlets.createdAt))
    .limit(1);
  return outlet ?? { street: null, city: null, postalCode: null };
}

/**
 * Creates one linked account. The bank details are decrypted here and nowhere else. The save goes
 * only on our own claim: a bank change drops the claim, so an ID for the old details is not kept.
 */
async function linkAccount(account: ClaimedAccount): Promise<boolean> {
  const contact = await accountContact(account);
  const { id } = await getGateway().createLinkedAccount({
    referenceId: account.id.replaceAll('-', '').slice(0, REFERENCE_LENGTH),
    legalName: account.legalName,
    contactName: contact.name ?? account.holderName,
    phone: contact.phone,
    email: contact.email,
    pan: decrypt(account.panEncrypted),
    holderName: account.holderName,
    accountNumber: decrypt(account.accountEncrypted),
    ifsc: account.ifsc,
    address: await accountAddress(account.id),
  });
  return withTx(async (tx) => {
    const [saved] = await tx
      .update(payoutAccounts)
      .set({ razorpayAccountId: id, linkedClaimedAt: null })
      .where(
        and(
          eq(payoutAccounts.id, account.id),
          eq(payoutAccounts.status, 'verified'),
          isNull(payoutAccounts.razorpayAccountId),
          eq(payoutAccounts.linkedClaimedAt, account.linkedClaimedAt),
        ),
      )
      .returning({ id: payoutAccounts.id });
    if (!saved) return false;
    await audit(tx, {
      actorId: null,
      action: 'payout_account.linked',
      entity: 'payout_account',
      entityId: account.id,
      detail: { razorpayAccountId: id },
    });
    return true;
  });
}

/** Gives verified payout accounts a linked account. Returns how many it saved. */
export async function syncLinkedAccounts(now: Date): Promise<number> {
  let linked = 0;
  for (const account of await claimLinkedAccounts(now)) {
    try {
      if (await linkAccount(account)) linked++;
    } catch (e) {
      // The claim runs out and the account goes again, and one bad row must not hold up the others.
      console.error(`Could not link payout account ${account.id}`, e);
    }
  }
  return linked;
}

// ---------- Transfers ----------

type ClaimedTransfer = {
  paymentId: string;
  orderId: string;
  razorpayPaymentId: string;
  accountId: string;
  pricePaise: number;
  commissionPaise: number;
  taxPaise: number;
  feePaise: number | null;
};

/**
 * Claims payments due a transfer. Claimed rows are left alone, so a failing row waits its turn. An
 * account must be verified: after a bank change the linked ID still names the old bank, and the
 * order waits for the new one. The account is the order's own, as a franchise can change hands.
 */
function claimTransfers(now: Date): Promise<ClaimedTransfer[]> {
  return withTx(async (tx) => {
    const rows = await tx
      .select({
        paymentId: payments.id,
        orderId: orders.id,
        razorpayPaymentId: payments.razorpayPaymentId,
        accountId: payoutAccounts.razorpayAccountId,
        pricePaise: orders.pricePaise,
        commissionPaise: orders.commissionPaise,
        taxPaise: orders.taxPaise,
        feePaise: payments.feePaise,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(payoutAccounts, eq(payoutAccounts.id, orders.payoutAccountId))
      .where(
        and(
          isBagPayment,
          eq(payments.transferStatus, 'none'),
          isNotNull(payments.razorpayPaymentId),
          inArray(orders.status, TRANSFERABLE_STATUSES),
          eq(payoutAccounts.status, 'verified'),
          isNotNull(payoutAccounts.razorpayAccountId),
          not(vendorRefundCovers),
          or(isNull(payments.transferClaimedAt), lt(payments.transferClaimedAt, staleBefore(now))),
        ),
      )
      .orderBy(asc(payments.createdAt))
      .limit(BATCH_SIZE)
      .for('update', { of: payments, skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(payments)
        .set({ transferClaimedAt: now.toISOString() })
        .where(
          inArray(
            payments.id,
            rows.map((r) => r.paymentId),
          ),
        );
    }
    return rows as ClaimedTransfer[];
  });
}

/**
 * The transfer went out as the bag stopped being the vendor's. The refund has to reverse it: an
 * unsent one can still be told to. One already sent cannot, so an admin must deal with the transfer.
 */
async function reverseOrFlag(tx: Tx, row: ClaimedTransfer, razorpayTransferId: string): Promise<void> {
  const [refund] = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.paymentId, row.paymentId), eq(refunds.chargedTo, 'vendor'), eq(refunds.status, 'pending')))
    .orderBy(sql`(${refunds.reason} = 'vendor_cancelled') DESC`)
    .limit(1)
    .for('update');
  if (refund && refundIsUnsent(refund)) {
    await tx.update(refunds).set({ reverseTransfer: true }).where(eq(refunds.id, refund.id));
    return;
  }
  await audit(tx, {
    actorId: null,
    action: 'transfer.orphaned',
    entity: 'payment',
    entityId: row.paymentId,
    detail: { orderId: row.orderId, razorpayTransferId, refundId: refund?.id ?? null },
  });
}

/**
 * Saves a transfer under the order lock, which cancels and admin refunds also hold. Either of those
 * may have landed during the gateway call, and the refund path can see the transfer only once it is
 * saved here, so it is saved whatever happened. Saving nothing means another run got there first.
 */
function saveTransfer(row: ClaimedTransfer, razorpayTransferId: string, feePaise: number, transferPaise: number) {
  return withTx(async (tx) => {
    const [order] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, row.orderId))
      .for('update');
    const [saved] = await tx
      .update(payments)
      .set({ razorpayTransferId, transferPaise, feePaise, transferStatus: 'on_hold', transferClaimedAt: null })
      .where(and(eq(payments.id, row.paymentId), eq(payments.transferStatus, 'none')))
      .returning({ id: payments.id });
    if (!saved) return false;

    const [covered] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.id, row.paymentId), vendorRefundCovers));
    if (order!.status === 'cancelled' || covered) await reverseOrFlag(tx, row, razorpayTransferId);
    return true;
  });
}

/** A sale that leaves the vendor nothing has no transfer to make. Flagged once, for an admin. */
function flagNoNet(row: ClaimedTransfer, netPaise: number): Promise<void> {
  return withTx(async (tx) => {
    const [flagged] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'transfer.no_net'), eq(auditLog.entityId, row.paymentId)));
    if (flagged) return;
    await audit(tx, {
      actorId: null,
      action: 'transfer.no_net',
      entity: 'payment',
      entityId: row.paymentId,
      detail: { orderId: row.orderId, netPaise },
    });
  });
}

/**
 * Sends one claimed transfer, keyed by the payment, so a resend after a crash or an unclear result
 * gets the same transfer back. A fee the capture did not carry is asked for: without it the net is
 * unknown, and the row waits for the next claim.
 */
async function sendTransfer(row: ClaimedTransfer): Promise<boolean> {
  const feePaise = row.feePaise ?? (await getGateway().fetchPayment(row.razorpayPaymentId)).feePaise;
  if (feePaise === null) return false;
  const amountPaise = vendorNetPaise({ ...row, feePaise });
  if (amountPaise <= 0) {
    await flagNoNet(row, amountPaise);
    return false;
  }
  const { id } = await getGateway().createTransfer({
    paymentId: row.razorpayPaymentId,
    accountId: row.accountId,
    amountPaise,
    idempotencyKey: `transfer-${row.paymentId}`,
  });
  return saveTransfer(row, id, feePaise, amountPaise);
}

type StaleClaim = { paymentId: string; orderId: string; razorpayPaymentId: string; claimedAt: string };

/**
 * Claims payments whose transfer claim ran out and whose bag is no longer the vendor's, as nothing
 * else will look at them again. An account on hold only delays a transfer, so those keep their claim.
 */
function claimStaleTransfers(now: Date): Promise<StaleClaim[]> {
  const claimedAt = now.toISOString();
  return withTx(async (tx) => {
    const rows = await tx
      .select({ paymentId: payments.id, orderId: orders.id, razorpayPaymentId: payments.razorpayPaymentId })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          eq(payments.status, 'captured'),
          eq(payments.transferStatus, 'none'),
          isNotNull(payments.razorpayPaymentId),
          lt(payments.transferClaimedAt, staleBefore(now)),
          or(notInArray(orders.status, TRANSFERABLE_STATUSES), vendorRefundCovers),
        ),
      )
      .orderBy(asc(payments.createdAt))
      .limit(BATCH_SIZE)
      .for('update', { of: payments, skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(payments)
        .set({ transferClaimedAt: claimedAt })
        .where(
          inArray(
            payments.id,
            rows.map((r) => r.paymentId),
          ),
        );
    }
    return rows.map((r) => ({ ...r, razorpayPaymentId: r.razorpayPaymentId!, claimedAt }));
  });
}

/** Saves what the sweep found. The refund path never saw this transfer, so an admin is told, once. */
function recordOrphan(row: StaleClaim, transfer: { id: string; amountPaise: number }): Promise<void> {
  return withTx(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, row.orderId)).for('update');
    await tx
      .update(payments)
      .set({
        razorpayTransferId: transfer.id,
        transferPaise: transfer.amountPaise,
        reversedPaise: transfer.amountPaise,
        transferStatus: 'reversed',
        transferClaimedAt: null,
      })
      .where(and(eq(payments.id, row.paymentId), eq(payments.transferStatus, 'none')));
    const [flagged] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'transfer.orphaned'), eq(auditLog.entityId, row.paymentId)));
    if (flagged) return;
    await audit(tx, {
      actorId: null,
      action: 'transfer.orphaned',
      entity: 'payment',
      entityId: row.paymentId,
      detail: { orderId: row.orderId, razorpayTransferId: transfer.id, reversedPaise: transfer.amountPaise },
    });
  });
}

/**
 * Settles one stale claim. The run behind it may have died after the gateway took the transfer, so
 * the gateway says. Anything there is reversed in full and recorded, even if a lost run had reversed
 * it already. With nothing there the claim just ends.
 */
async function sweepClaim(row: StaleClaim): Promise<void> {
  const found = await getGateway().listPaymentTransfers(row.razorpayPaymentId);
  for (const transfer of found) {
    if (transfer.status !== 'reversed' && transfer.amountPaise > 0) {
      await getGateway().reverseTransferPartial(transfer.id, transfer.amountPaise, `orphan-${row.paymentId}-${transfer.id}`);
    }
    await recordOrphan(row, transfer);
  }
  if (found.length > 0) return;
  await db
    .update(payments)
    .set({ transferClaimedAt: null })
    .where(and(eq(payments.id, row.paymentId), eq(payments.transferClaimedAt, row.claimedAt)));
}

async function sweepStaleTransfers(now: Date): Promise<void> {
  for (const row of await claimStaleTransfers(now)) {
    try {
      await sweepClaim(row);
    } catch (e) {
      // The new claim runs out and the row goes again, and one bad row must not hold up the others.
      console.error(`Could not sweep the transfer claim on payment ${row.paymentId}`, e);
    }
  }
}

/**
 * Creates held transfers for sold bags, at most 100 a run, with the gateway calls outside any
 * transaction, then settles claims left behind on bags since cancelled or refunded. Returns how many
 * it saved. Safe to run twice.
 */
export async function createTransfers(now: Date): Promise<number> {
  let created = 0;
  for (const row of await claimTransfers(now)) {
    try {
      if (await sendTransfer(row)) created++;
    } catch (e) {
      // The claim runs out and the row goes again on the same key, and one bad row must not hold up the others.
      console.error(`Could not create a transfer for payment ${row.paymentId}`, e);
    }
  }
  await sweepStaleTransfers(now);
  return created;
}
