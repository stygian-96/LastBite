import { and, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { orders, payments, payouts, refunds } from '../../db/schema.js';

/** Payouts held because their net is negative, waiting to be carried. */
export const negativePayouts = (accountId?: string): SQL =>
  and(accountId ? eq(payouts.payoutAccountId, accountId) : undefined, eq(payouts.status, 'held'), lt(payouts.netPaise, 0))!;

/** Moves negative payouts on, as their balance now belongs to a later payout. They were never paid. */
export async function absorbNegativePayouts(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length > 0) await tx.update(payouts).set({ status: 'released', paidAt: null }).where(inArray(payouts.id, ids));
}

/**
 * What the next payout must add to its orders for an account, negative if the vendor has had too
 * much, worked out from the money and never from earlier nets, which go stale.
 *
 * Payouts are settled once released, paid, or held negative. For those it is the nets of orders still
 * standing, less the refunds they deducted, less what has actually moved. Open payouts, a draft or
 * one held with money due, are left out with the money their own approvals have moved so far, and
 * what they have already been given of this balance comes off, so it is carried once. With
 * `exceptPayoutId` it is the answer for that open payout, whose own orders and refunds are its own.
 */
export async function carriedBalance(q: Pick<Tx, 'select'>, accountId: string, exceptPayoutId?: string): Promise<number> {
  const rows = await q
    .select({ id: payouts.id, status: payouts.status, netPaise: payouts.netPaise, adjustmentPaise: payouts.adjustmentPaise })
    .from(payouts)
    .where(eq(payouts.payoutAccountId, accountId));
  const isSettled = (p: (typeof rows)[number]) =>
    p.id !== exceptPayoutId && (p.status === 'released' || p.status === 'paid' || (p.status === 'held' && p.netPaise < 0));
  const settled = rows.filter(isSettled);
  const open = rows.filter((p) => !isSettled(p));
  const others = rows.filter((p) => p.id !== exceptPayoutId);
  if (others.length === 0) return 0;

  const deducted = await q
    .select({ payoutId: refunds.adjustedPayoutId, paise: sql<number>`sum(${refunds.amountPaise})::int` })
    .from(refunds)
    .where(
      inArray(
        refunds.adjustedPayoutId,
        others.map((p) => p.id),
      ),
    )
    .groupBy(refunds.adjustedPayoutId);
  const deductedBy = new Map(deducted.map((d) => [d.payoutId, d.paise]));
  const allottedPaise = open
    .filter((p) => p.id !== exceptPayoutId)
    .reduce((sum, p) => sum + p.adjustmentPaise + (deductedBy.get(p.id) ?? 0), 0);
  const refundedPaise = settled.reduce((sum, p) => sum + (deductedBy.get(p.id) ?? 0), 0);
  if (settled.length === 0) return -allottedPaise;

  const unfinished = open.map((p) => p.id);
  const movedByOpen = unfinished.length > 0 ? inArray(payments.releasedPayoutId, unfinished) : sql`false`;
  const [money] = await q
    .select({
      owedPaise: sql<number>`coalesce(sum(${payments.transferPaise}), 0)::int`,
      movedPaise: sql<number>`coalesce(sum(${payments.transferPaise} - ${payments.reversedPaise}) FILTER (
        WHERE ${payments.transferStatus} = 'released' AND (${payments.releasedPayoutId} IS NULL OR NOT ${movedByOpen})
      ), 0)::int`,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      and(
        inArray(
          orders.payoutId,
          settled.map((p) => p.id),
        ),
        inArray(payments.transferStatus, ['on_hold', 'released']),
      ),
    );
  return money!.owedPaise - refundedPaise - money!.movedPaise - allottedPaise;
}
