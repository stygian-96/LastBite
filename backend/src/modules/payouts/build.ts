import { and, asc, eq, inArray, isNull, lt, lte, ne, notExists, or, type SQL } from 'drizzle-orm';
import { db, withTx, type Tx } from '../../db/client.js';
import { orders, outlets, payments, payoutAccounts, payouts, refunds } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { addDays, isoWeekday } from '../../lib/time.js';

export type Payout = typeof payouts.$inferSelect;

/** Order statuses that earn the vendor their money. */
export const EARNED_STATUSES = ['collected', 'no_show'];
/** Transfer statuses that mean the vendor has, or will have, the transfer. */
const LIVE_TRANSFERS = ['on_hold', 'released'];

const isDate = /^\d{4}-\d{2}-\d{2}$/;

type OrderMoney = { pricePaise: number; commissionPaise: number; feePaise: number | null; taxPaise: number };
export type Totals = Pick<Payout, 'grossPaise' | 'commissionPaise' | 'feesPaise' | 'taxPaise'>;

export function sumOrders(rows: OrderMoney[]): Totals {
  const totals = { grossPaise: 0, commissionPaise: 0, feesPaise: 0, taxPaise: 0 };
  for (const o of rows) {
    totals.grossPaise += o.pricePaise;
    totals.commissionPaise += o.commissionPaise;
    totals.feesPaise += o.feePaise ?? 0;
    totals.taxPaise += o.taxPaise;
  }
  return totals;
}

export const netOf = (t: Totals, adjustmentPaise: number): number =>
  t.grossPaise - t.commissionPaise - t.feesPaise - t.taxPaise + adjustmentPaise;

/** A pending or processed refund is taking this transfer back, so its order earns nothing for now. */
export const noReversingRefund = notExists(
  db
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.paymentId, payments.id), eq(refunds.reverseTransfer, true), ne(refunds.status, 'failed'))),
);

/** Orders up to the end of this period that have not been paid out. An order held back rolls forward. */
const payableOrders = (periodEnd: string, accountId?: string): SQL =>
  and(
    accountId ? eq(outlets.payoutAccountId, accountId) : undefined,
    inArray(orders.status, EARNED_STATUSES),
    isNull(orders.payoutId),
    lte(orders.serviceDate, periodEnd),
    eq(payments.status, 'captured'),
    inArray(payments.transferStatus, LIVE_TRANSFERS),
    noReversingRefund,
  )!;

/**
 * Processed vendor-charged refunds not yet deducted, on orders the vendor earned from. A refund that
 * reversed its transfer took the money back already. So did a whole refund with no transfer, which
 * never paid the vendor. A part refund waits for its order's transfer.
 */
export const adjustableRefunds = (accountId?: string): SQL =>
  and(
    accountId ? eq(outlets.payoutAccountId, accountId) : undefined,
    eq(refunds.status, 'processed'),
    eq(refunds.chargedTo, 'vendor'),
    eq(refunds.reverseTransfer, false),
    isNull(refunds.adjustedPayoutId),
    inArray(orders.status, EARNED_STATUSES),
    inArray(payments.transferStatus, LIVE_TRANSFERS),
    or(eq(payments.transferStatus, 'released'), lt(refunds.amountPaise, payments.amountPaise)),
  )!;

const carriedPayouts = (periodStart: string, accountId?: string): SQL =>
  and(
    accountId ? eq(payouts.payoutAccountId, accountId) : undefined,
    eq(payouts.status, 'held'),
    lt(payouts.netPaise, 0),
    lt(payouts.periodStart, periodStart),
  )!;

/** Accounts with anything to go on this period's payout. */
async function accountsToBuild(periodStart: string, periodEnd: string): Promise<string[]> {
  const [withOrders, withRefunds, withBalance] = await Promise.all([
    db
      .selectDistinct({ id: outlets.payoutAccountId })
      .from(orders)
      .innerJoin(outlets, eq(outlets.id, orders.outletId))
      .innerJoin(payments, eq(payments.orderId, orders.id))
      .where(payableOrders(periodEnd)),
    db
      .selectDistinct({ id: outlets.payoutAccountId })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .innerJoin(outlets, eq(outlets.id, orders.outletId))
      .where(adjustableRefunds()),
    db.selectDistinct({ id: payouts.payoutAccountId }).from(payouts).where(carriedPayouts(periodStart)),
  ]);
  return [...new Set([...withOrders, ...withRefunds, ...withBalance].flatMap((r) => (r.id ? [r.id] : [])))];
}

/**
 * Builds one account's payout. The account lock serialises builds for it, so a repeat finds the row
 * and stops. Orders are held so a refund deciding on a reversal either lands first and is seen, or
 * waits and finds the order on a payout.
 */
async function buildForAccount(tx: Tx, accountId: string, periodStart: string, periodEnd: string, now: Date) {
  const [account] = await tx.select().from(payoutAccounts).where(eq(payoutAccounts.id, accountId)).for('update');
  const [existing] = await tx
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.payoutAccountId, accountId), eq(payouts.periodStart, periodStart)));
  if (existing) return;

  const rows = await tx
    .select({
      id: orders.id,
      pricePaise: orders.pricePaise,
      commissionPaise: orders.commissionPaise,
      taxPaise: orders.taxPaise,
      feePaise: payments.feePaise,
    })
    .from(orders)
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(payableOrders(periodEnd, accountId))
    .orderBy(asc(orders.id))
    .for('update', { of: orders });
  const adjusted = await tx
    .select({ id: refunds.id, amountPaise: refunds.amountPaise })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .where(adjustableRefunds(accountId))
    .for('update', { of: refunds });
  const carried = await tx
    .select({ id: payouts.id, netPaise: payouts.netPaise })
    .from(payouts)
    .where(carriedPayouts(periodStart, accountId))
    .for('update');
  if (rows.length + adjusted.length + carried.length === 0) return;

  const refundedPaise = adjusted.reduce((sum, r) => sum + r.amountPaise, 0);
  const carriedPaise = carried.reduce((sum, p) => sum + p.netPaise, 0);
  const adjustmentPaise = carriedPaise - refundedPaise;
  const totals = sumOrders(rows);
  const netPaise = netOf(totals, adjustmentPaise);

  const [payout] = await tx
    .insert(payouts)
    .values({
      payoutAccountId: accountId,
      periodStart,
      periodEnd,
      ...totals,
      adjustmentPaise,
      netPaise,
      status: account!.status === 'on_hold' || netPaise < 0 ? 'held' : 'draft',
      createdAt: now.toISOString(),
    })
    .returning();
  const payoutId = payout!.id;
  const ids = <T extends { id: string }>(list: T[]) => list.map((r) => r.id);
  if (rows.length > 0) await tx.update(orders).set({ payoutId }).where(inArray(orders.id, ids(rows)));
  if (adjusted.length > 0) {
    await tx.update(refunds).set({ adjustedPayoutId: payoutId }).where(inArray(refunds.id, ids(adjusted)));
  }
  if (carried.length > 0) {
    await tx.update(payouts).set({ status: 'released', paidAt: null }).where(inArray(payouts.id, ids(carried)));
  }
  await audit(tx, {
    actorId: null,
    action: 'payout.build',
    entity: 'payout',
    entityId: payoutId,
    detail: { periodStart, orders: rows.length, refunds: ids(adjusted), carried: ids(carried), netPaise },
  });
}

/**
 * Builds the payouts for a Monday to Sunday week by service date, one per payout account. An account
 * that has its payout already keeps it as it is, and returns it. Later arrivals roll into next week.
 */
export async function buildPayouts(periodStart: string, now: Date): Promise<Payout[]> {
  if (!isDate.test(periodStart) || Number.isNaN(Date.parse(periodStart)) || isoWeekday(periodStart) !== 1) {
    throw new ApiError('invalid_request', 400, 'A payout period starts on a Monday');
  }
  const periodEnd = addDays(periodStart, 6);
  for (const accountId of await accountsToBuild(periodStart, periodEnd)) {
    try {
      await withTx((tx) => buildForAccount(tx, accountId, periodStart, periodEnd, now));
    } catch (e) {
      // Another run finishes this account, and one bad account must not hold up the others.
      console.error(`Could not build a payout for account ${accountId}`, e);
    }
  }
  return db.select().from(payouts).where(eq(payouts.periodStart, periodStart)).orderBy(asc(payouts.createdAt), asc(payouts.id));
}

