import { and, asc, desc, eq, inArray, isNull, ne, not } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { brands, orders, outlets, payments, payoutAccounts, payouts, refunds } from '../../db/schema.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { requirePayoutAccount } from '../auth/access.js';
import { carriedBalance } from './balance.js';
import { adjustableRefunds, EARNED_STATUSES, netOf, noReversingRefund, sumOrders, type Payout, type Totals } from './build.js';
import { isBagPayment, vendorRefundCovers } from './transfers.js';

const LIST_LIMIT = 100;

const statusFilter = z.enum(['draft', 'held', 'released', 'paid']).optional();

/** The 100 newest payouts, for admin review. */
export async function listPayouts(status?: string) {
  const wanted = parseInput(statusFilter, status);
  return db
    .select({
      id: payouts.id,
      payoutAccountId: payouts.payoutAccountId,
      legalName: payoutAccounts.legalName,
      accountStatus: payoutAccounts.status,
      periodStart: payouts.periodStart,
      periodEnd: payouts.periodEnd,
      grossPaise: payouts.grossPaise,
      commissionPaise: payouts.commissionPaise,
      feesPaise: payouts.feesPaise,
      taxPaise: payouts.taxPaise,
      adjustmentPaise: payouts.adjustmentPaise,
      netPaise: payouts.netPaise,
      status: payouts.status,
      approvingAt: payouts.approvingAt,
      paidAt: payouts.paidAt,
      createdAt: payouts.createdAt,
    })
    .from(payouts)
    .innerJoin(payoutAccounts, eq(payoutAccounts.id, payouts.payoutAccountId))
    .where(wanted ? eq(payouts.status, wanted) : undefined)
    .orderBy(desc(payouts.periodStart), asc(payouts.id))
    .limit(LIST_LIMIT);
}

const accountStatusFilter = z.enum(['pending', 'verified', 'rejected', 'on_hold']).optional();

/** The 100 newest payout accounts, for admin review. Encrypted columns never leave the server. */
export async function listAdminPayoutAccounts(status?: string) {
  const wanted = parseInput(accountStatusFilter, status);
  return db
    .select({
      id: payoutAccounts.id,
      brandId: payoutAccounts.brandId,
      brandName: brands.name,
      legalName: payoutAccounts.legalName,
      panLast4: payoutAccounts.panLast4,
      holderName: payoutAccounts.holderName,
      accountLast4: payoutAccounts.accountLast4,
      ifsc: payoutAccounts.ifsc,
      status: payoutAccounts.status,
      linkedAccountStep: payoutAccounts.linkedAccountStep,
      linkedAccountFailures: payoutAccounts.linkedAccountFailures,
      createdAt: payoutAccounts.createdAt,
    })
    .from(payoutAccounts)
    .innerJoin(brands, eq(brands.id, payoutAccounts.brandId))
    .where(wanted ? eq(payoutAccounts.status, wanted) : undefined)
    .orderBy(desc(payoutAccounts.createdAt), asc(payoutAccounts.id))
    .limit(LIST_LIMIT);
}

export type EarningsView = {
  payouts: Payout[];
  /** Everything earned that no payout has taken yet, with any balance owed, so what the next one will hold so far. */
  thisWeek: Totals & { orders: number; adjustmentPaise: number; netPaise: number };
};

/** The account's payouts, newest first, and what is waiting for the next one. */
export async function getEarnings(userId: string, payoutAccountId: string): Promise<EarningsView> {
  await requirePayoutAccount(userId, payoutAccountId);

  const [rows, open, refunded, carriedPaise] = await Promise.all([
    db.select().from(payouts).where(eq(payouts.payoutAccountId, payoutAccountId)).orderBy(desc(payouts.periodStart)),
    db
      .select({
        pricePaise: orders.pricePaise,
        commissionPaise: orders.commissionPaise,
        taxPaise: orders.taxPaise,
        feePaise: payments.feePaise,
      })
      .from(orders)
      .innerJoin(payments, eq(payments.orderId, orders.id))
      .where(
        and(
          eq(orders.payoutAccountId, payoutAccountId),
          inArray(orders.status, EARNED_STATUSES),
          isNull(orders.payoutId),
          isBagPayment,
          ne(payments.transferStatus, 'reversed'),
          noReversingRefund,
          not(vendorRefundCovers),
        ),
      ),
    db
      .select({ amountPaise: refunds.amountPaise })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(adjustableRefunds(payoutAccountId)),
    carriedBalance(db, payoutAccountId),
  ]);

  const totals = sumOrders(open);
  const adjustmentPaise = carriedPaise - refunded.reduce((sum, r) => sum + r.amountPaise, 0);
  return {
    payouts: rows,
    thisWeek: { orders: open.length, ...totals, adjustmentPaise, netPaise: netOf(totals, adjustmentPaise) },
  };
}

type Row = {
  order: string;
  date: string;
  outlet: string;
  gross: number;
  commission: number;
  fee: number;
  tax: number;
  net: number;
};

const rupees = (paise: number) => (paise / 100).toFixed(2);

/** Quotes a cell that needs it, and defuses text a spreadsheet would run as a formula. */
function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const csvRow = (r: Row) =>
  [csvText(r.order), r.date, csvText(r.outlet), ...[r.gross, r.commission, r.fee, r.tax, r.net].map(rupees)].join(',');

/** A statement for the vendor to download: these exist once a payout has gone (spec 7.6). */
export async function downloadStatement(userId: string, payoutId: string): Promise<string> {
  const csv = await statementCsv(userId, payoutId);
  const [payout] = await db.select({ status: payouts.status }).from(payouts).where(eq(payouts.id, payoutId));
  if (payout!.status !== 'released' && payout!.status !== 'paid') {
    throw new ApiError('statement_not_ready', 409, 'The statement is ready once this payout is released');
  }
  return csv;
}

/**
 * One payout's statement. Orders and refunds have a row each, and a balance carried from a negative
 * payout has one too, being whatever of the adjustment no refund explains. The last line adds the
 * rows up, so it can be checked against the payout. A draft keeps an order reversed since the build
 * until approval takes it off, so its rows still add up to the draft.
 */
export async function statementCsv(userId: string, payoutId: string): Promise<string> {
  if (!z.uuid().safeParse(payoutId).success) throw new ApiError('forbidden', 403, 'Not allowed');
  const [payout] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!payout) throw new ApiError('forbidden', 403, 'Not allowed');
  await requirePayoutAccount(userId, payout.payoutAccountId);

  const sold = await db
    .select({
      number: orders.number,
      serviceDate: orders.serviceDate,
      outlet: outlets.branchName,
      pricePaise: orders.pricePaise,
      commissionPaise: orders.commissionPaise,
      taxPaise: orders.taxPaise,
      feePaise: payments.feePaise,
    })
    .from(orders)
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(and(eq(orders.payoutId, payoutId), inArray(payments.transferStatus, ['on_hold', 'released', 'reversed'])))
    .orderBy(asc(orders.serviceDate), asc(orders.number));
  const deducted = await db
    .select({
      number: orders.number,
      serviceDate: orders.serviceDate,
      outlet: outlets.branchName,
      amountPaise: refunds.amountPaise,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .where(eq(refunds.adjustedPayoutId, payoutId))
    .orderBy(asc(orders.serviceDate), asc(orders.number));

  const orderNumber = (n: bigint) => `SJ-${n.toString()}`;
  const adjustment = (order: string, date: string, outlet: string, net: number): Row => ({
    order,
    date,
    outlet,
    gross: 0,
    commission: 0,
    fee: 0,
    tax: 0,
    net,
  });
  const rows: Row[] = sold.map((o) => {
    const fee = o.feePaise ?? 0;
    return {
      order: orderNumber(o.number),
      date: o.serviceDate,
      outlet: o.outlet,
      gross: o.pricePaise,
      commission: o.commissionPaise,
      fee,
      tax: o.taxPaise,
      net: o.pricePaise - o.commissionPaise - fee - o.taxPaise,
    };
  });
  for (const r of deducted) {
    rows.push(adjustment(orderNumber(r.number), r.serviceDate, `${r.outlet} (refund)`, -r.amountPaise));
  }
  const carried = payout.adjustmentPaise + deducted.reduce((sum, r) => sum + r.amountPaise, 0);
  if (carried !== 0) rows.push(adjustment('', '', 'Carried from an earlier payout', carried));

  const sum = (pick: (r: Row) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const totals: Row = {
    order: 'Total',
    date: '',
    outlet: '',
    gross: sum((r) => r.gross),
    commission: sum((r) => r.commission),
    fee: sum((r) => r.fee),
    tax: sum((r) => r.tax),
    net: sum((r) => r.net),
  };
  const header = 'Order number,Service date,Outlet,Gross,Commission,Fee,Tax,Net';
  return `${[header, ...rows.map(csvRow), csvRow(totals)].join('\r\n')}\r\n`;
}
