import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { brands, issues, orders, outlets, payments, refunds, sessions, users } from '../../db/schema.js';
import { getStore } from '../../integrations/storage.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { normalizePhone } from '../auth/otp.js';
import { movePendingTo } from '../notifications/enqueue.js';
import { bagPayment, unrefundedPaise } from '../refunds/cancel.js';
import { createRefund, reopenFailedRefund, type NewRefund } from '../refunds/create.js';

const ORDER_LIMIT = 100;
const STATS_WINDOW_MS = 30 * 86_400_000;

const uuid = z.uuid();
const notFound = (what: string) => new ApiError('not_found', 404, `${what} not found`);
const isId = (id: string) => uuid.safeParse(id).success;

// ---------- Support views ----------

const orderFilters = z.object({
  status: z.enum(['held', 'expired', 'paid', 'collected', 'no_show', 'cancelled']).optional(),
  outletId: z.uuid().optional(),
  date: z.iso.date().optional(),
  phone: z.string().min(1).max(20).optional(),
  number: z
    .string()
    .regex(/^(SJ-)?\d{1,18}$/)
    .optional(),
});
export type OrderFilters = { status?: string; outletId?: string; date?: string; phone?: string; number?: string };

/** Orders for support, the 100 newest that match. refundedPaise leaves out failed refunds. */
export async function listAdminOrders(raw: OrderFilters) {
  const filters = parseInput(orderFilters, raw);
  const phone = filters.phone === undefined ? undefined : normalizePhone(filters.phone);
  if (phone === null) throw new ApiError('invalid_phone', 400, 'Enter a valid mobile number');

  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      pricePaise: orders.pricePaise,
      serviceDate: orders.serviceDate,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
      collectedAt: orders.collectedAt,
      cancelledAt: orders.cancelledAt,
      cancelReason: orders.cancelReason,
      refundedPaise: sql<number>`(
        SELECT coalesce(sum(r.amount_paise), 0)::int FROM refunds r
         WHERE r.order_id = ${orders.id} AND r.status <> 'failed'
      )`,
      outletId: outlets.id,
      branchName: outlets.branchName,
      brandName: brands.name,
      customerName: users.name,
      customerPhone: users.phone,
    })
    .from(orders)
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .leftJoin(users, eq(users.id, orders.userId))
    .where(
      and(
        filters.status ? eq(orders.status, filters.status) : undefined,
        filters.outletId ? eq(orders.outletId, filters.outletId) : undefined,
        filters.date ? eq(orders.serviceDate, filters.date) : undefined,
        phone ? eq(users.phone, phone) : undefined,
        filters.number ? eq(orders.number, BigInt(filters.number.replace('SJ-', ''))) : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(ORDER_LIMIT);
  return rows.map((r) => ({ ...r, number: `SJ-${r.number.toString()}` }));
}

const issueStatus = z.enum(['open', 'resolved']);

/** Issues in a status: allergen problems first, then the oldest. Photos carry short-lived read links. */
export async function listIssues(status: string) {
  const wanted = parseInput(issueStatus, status);
  const rows = await db
    .select({
      id: issues.id,
      orderId: issues.orderId,
      orderNumber: orders.number,
      orderStatus: orders.status,
      outletId: orders.outletId,
      userId: issues.userId,
      reason: issues.reason,
      description: issues.description,
      photoKey: issues.photoKey,
      status: issues.status,
      resolution: issues.resolution,
      resolvedBy: issues.resolvedBy,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .innerJoin(orders, eq(orders.id, issues.orderId))
    .where(eq(issues.status, wanted))
    .orderBy(sql`(${issues.reason} = 'allergen') DESC`, asc(issues.createdAt), asc(issues.id));

  const store = getStore();
  return Promise.all(
    rows.map(async ({ orderNumber, photoKey, ...issue }) => ({
      ...issue,
      orderNumber: `SJ-${orderNumber.toString()}`,
      photoUrl: photoKey ? await store.signedRead(photoKey) : null,
    })),
  );
}

/**
 * An outlet's orders paid for in the last 30 days, and how many of those it cancelled. Holds that
 * were never paid do not count. The rate is a fraction, and zero with no orders.
 */
export async function getOutletStats(
  outletId: string,
  now: Date,
): Promise<{ orders30d: number; cancelled30d: number; cancellationRate: number }> {
  if (!isId(outletId)) throw notFound('Outlet');
  const [outlet] = await db.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, outletId));
  if (!outlet) throw notFound('Outlet');

  const since = new Date(now.getTime() - STATS_WINDOW_MS).toISOString();
  const [stats] = await db
    .select({
      orders30d: sql<number>`count(*)::int`,
      cancelled30d: sql<number>`(count(*) FILTER (WHERE ${orders.status} = 'cancelled'))::int`,
    })
    .from(orders)
    .where(and(eq(orders.outletId, outletId), gte(orders.paidAt, since), lte(orders.paidAt, now.toISOString())));
  const { orders30d, cancelled30d } = stats!;
  return { orders30d, cancelled30d, cancellationRate: orders30d === 0 ? 0 : cancelled30d / orders30d };
}

// ---------- Refunds ----------

const refundInput = z.object({
  amountPaise: z.number().int().positive(),
  chargedTo: z.enum(['vendor', 'platform']),
  issueId: z.uuid().optional(),
});
export type RefundInput = z.input<typeof refundInput>;

/** Locks an open issue on this order, for the refund that resolves it. */
async function lockOpenIssue(tx: Tx, issueId: string, orderId: string): Promise<void> {
  const [issue] = await tx
    .select({ status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orderId, orderId)))
    .for('update');
  if (!issue) throw notFound('Issue');
  if (issue.status !== 'open') throw new ApiError('issue_resolved', 409, 'This issue is already resolved');
}

/**
 * Records a refund of up to what is left of the payment that bought the bag, for the refund job to
 * send. Only a vendor-charged refund of all that is left reverses the transfer, and only while it
 * is on hold. UNIQUE (payment_id, reason) allows one per payment, so a refund that failed is reused.
 * Holding the order keeps this from racing a vendor cancel, which refunds under the same lock.
 */
export async function adminRefund(adminId: string, orderId: string, raw: RefundInput, now: Date): Promise<void> {
  const { amountPaise, chargedTo, issueId } = parseInput(refundInput, raw);
  if (!isId(orderId)) throw notFound('Order');

  await withTx(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw notFound('Order');
    if (issueId) await lockOpenIssue(tx, issueId, orderId);
    const payment = await bagPayment(tx, orderId);
    if (!payment) throw new ApiError('not_refundable', 409, 'This order has no payment to refund');

    const remainder = await unrefundedPaise(tx, payment);
    const terms = {
      paymentId: payment.id,
      reason: 'issue_resolution',
      amountPaise,
      chargedTo,
      createdBy: adminId,
      reverseTransfer: chargedTo === 'vendor' && amountPaise === remainder && payment.transferStatus === 'on_hold',
    } as const;
    const created = await createRefund(tx, { ...terms, orderId, createdAt: now.toISOString() });
    const refundId = created ?? (await reopenFailedRefund(tx, terms));
    // Checked in this order so that a repeat always reads as one. Throwing undoes the write.
    if (!refundId) throw new ApiError('already_refunded', 409, 'This payment already has an admin refund');
    if (amountPaise > remainder) throw new ApiError('refund_too_large', 400, 'That is more than is left of the payment');

    if (issueId) {
      const resolution = `Refunded Rs ${(amountPaise / 100).toFixed(2)}, charged to ${chargedTo}`;
      await tx.update(issues).set({ status: 'resolved', resolution, resolvedBy: adminId }).where(eq(issues.id, issueId));
    }
    await audit(tx, {
      actorId: adminId,
      action: created ? 'refund.create' : 'refund.reopen',
      entity: 'refund',
      entityId: refundId,
      detail: { orderId, paymentId: payment.id, amountPaise, chargedTo, issueId: issueId ?? null },
    });
  });
}

/**
 * Sends a failed refund again on the terms it had, whatever its reason, so late and duplicate payments
 * can be recovered too. It keeps its attempts, so the send carries a new key. A transfer no longer on
 * hold cannot be reversed, so that part of the terms stops. Holding the order keeps out a cancel or
 * an admin refund that could use up what this needs.
 */
export async function retryRefund(adminId: string, refundId: string): Promise<void> {
  if (!isId(refundId)) throw notFound('Refund');
  const [known] = await db.select({ orderId: refunds.orderId }).from(refunds).where(eq(refunds.id, refundId));
  if (!known) throw notFound('Refund');

  await withTx(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, known.orderId)).for('update');
    const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for('update');
    if (refund!.status !== 'failed') throw new ApiError('invalid_state', 409, 'Only a failed refund can be retried');
    const { paymentId, amountPaise, attempts } = refund!;
    const [payment] = await tx
      .select({ id: payments.id, amountPaise: payments.amountPaise, transferStatus: payments.transferStatus })
      .from(payments)
      .where(eq(payments.id, paymentId));
    if (amountPaise > (await unrefundedPaise(tx, payment!))) {
      throw new ApiError('refund_too_large', 409, 'That is more than is left of the payment');
    }

    const reverseTransfer = refund!.reverseTransfer && payment!.transferStatus === 'on_hold';
    await reopenFailedRefund(tx, {
      paymentId,
      reason: refund!.reason as NewRefund['reason'],
      amountPaise,
      chargedTo: refund!.chargedTo as NewRefund['chargedTo'],
      reverseTransfer,
    });
    await audit(tx, {
      actorId: adminId,
      action: 'refund.retry',
      entity: 'refund',
      entityId: refundId,
      detail: { orderId: known.orderId, paymentId, amountPaise, attempts, reverseTransfer },
    });
  });
}

// ---------- Accounts ----------

/**
 * Moves a user and their queued messages to a new number, and ends their sessions, so the old phone
 * is signed out. The audit row keeps only the last 4 digits, as it outlives an account deletion.
 */
export async function changeUserPhone(adminId: string, userId: string, phone: string): Promise<void> {
  const e164 = normalizePhone(phone);
  if (!e164) throw new ApiError('invalid_phone', 400, 'Enter a valid mobile number');
  if (!isId(userId)) throw notFound('User');

  try {
    await withTx(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!user || user.deletedAt) throw notFound('User');
      await tx.update(users).set({ phone: e164 }).where(eq(users.id, userId));
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await movePendingTo(tx, user.phone, e164);
      await audit(tx, {
        actorId: adminId,
        action: 'user.phone_change',
        entity: 'user',
        entityId: userId,
        detail: { fromLast4: user.phone.slice(-4), toLast4: e164.slice(-4) },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e, 'users_phone_key')) throw new ApiError('phone_in_use', 409, 'Another account uses that number');
    throw e;
  }
}
