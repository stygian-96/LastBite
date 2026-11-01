import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { auditLog, drops, memberships, orders, outlets, payments, refunds } from '../../src/db/schema.js';
import { FakeGateway, setGateway, type GatewayPayment } from '../../src/integrations/payments.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { createSession } from '../../src/modules/auth/session.js';
import { expireHolds } from '../../src/modules/orders/expire.js';
import { reserveDrop } from '../../src/modules/orders/reserve.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { handleWebhook } from '../../src/modules/payments/webhook.js';
import { cancelDrop, cancelOrder } from '../../src/modules/refunds/cancel.js';
import { processRefunds } from '../../src/modules/refunds/process.js';
import { app } from '../../src/app.js';
import { makeDrop, makeLiveOutlet, makePayment, makeUser } from '../helpers/factories.js';
import { getDropRow, getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-02. Default drops stop selling at 20:45 IST.
const now = new Date('2026-11-02T10:00:00Z');
const seconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
// Past a 5 minute hold and its 60 seconds of grace.
const later = seconds(now, 5 * 60 + 61);
const LEASE_SECONDS = 5 * 60;

let gateway: FakeGateway;
let seq = 0;

beforeEach(async () => {
  await resetDb();
  gateway = new FakeGateway();
  setGateway(gateway);
});
afterEach(() => vi.restoreAllMocks());

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

const capturedPayment = (razorpayOrderId: string, o: Partial<GatewayPayment> = {}) =>
  gateway.addPayment({
    id: `pay_${++seq}`,
    orderId: razorpayOrderId,
    status: 'captured',
    amountPaise: 10000,
    feePaise: 236,
    method: 'upi',
    ...o,
  });

async function heldOrder(dropOptions: Parameters<typeof makeDrop>[0] = {}) {
  const user = await makeUser();
  const drop = await makeDrop(dropOptions);
  const order = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
  const payment = await makePayment({ orderId: order.id });
  return { user, drop, order, payment, gp: capturedPayment(payment.razorpayOrderId) };
}

/** A paid order from a real reserve and capture. */
async function paidOrder(dropOptions: Parameters<typeof makeDrop>[0] = {}) {
  const held = await heldOrder(dropOptions);
  await applyCapture(held.gp, now);
  return held;
}

/** Adds another customer's order to the drop, held or paid. */
async function anotherOrder(dropId: string, status: 'held' | 'paid') {
  const user = await makeUser();
  const order = await reserveDrop({ dropId, userId: user.id, ip: '1.1.1.1' }, now);
  const payment = await makePayment({ orderId: order.id });
  const gp = capturedPayment(payment.razorpayOrderId);
  if (status === 'paid') await applyCapture(gp, now);
  return { order, payment, gp };
}

/** A user working at this outlet. Owners are brand-wide, as in onboarding. */
async function staffOf(outletId: string, role: 'owner' | 'manager' | 'counter' = 'owner') {
  const [outlet] = await db.select({ brandId: outlets.brandId }).from(outlets).where(eq(outlets.id, outletId));
  const user = await makeUser();
  await db
    .insert(memberships)
    .values({ userId: user.id, brandId: outlet!.brandId, outletId: role === 'owner' ? null : outletId, role });
  return user;
}

/** A pending vendor_cancelled refund for a freshly cancelled order. */
async function cancelledOrder() {
  const paid = await paidOrder();
  const owner = await staffOf(paid.drop.outletId);
  await cancelOrder(owner.id, paid.order.id, 'quality', now);
  const [refund] = await refundsFor(paid.order.id);
  return { ...paid, refund: refund! };
}

const refundRow = async (id: string) => (await db.select().from(refunds).where(eq(refunds.id, id)))[0]!;
const paymentRow = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0]!;
const paymentRowsFor = (orderId: string) => db.select().from(payments).where(eq(payments.orderId, orderId));
const auditRows = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const setTransfer = (paymentId: string, transferStatus: string) =>
  db.update(payments).set({ transferStatus, razorpayTransferId: `trf_${paymentId}` }).where(eq(payments.id, paymentId));

const refundEvent = (type: string, id: string) =>
  JSON.stringify({ event: type, payload: { refund: { entity: { id } } } });
const deliver = (raw: string) => handleWebhook(raw, 'valid', `evt_${++seq}`, now);

/** Resolves once this many connections are waiting on a lock. */
const lockWaiters = (count: number) =>
  vi.waitFor(async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(count);
  });

describe('cancelOrder', () => {
  test('cancel moves paid order to cancelled, frees stock, creates a refund', async () => {
    const { order, payment, drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);

    await cancelOrder(owner.id, order.id, 'ran_out', now);

    const row = await getOrderRow(order.id);
    expect(row).toMatchObject({ status: 'cancelled', cancelledBy: owner.id, cancelReason: 'ran_out' });
    expect(new Date(row.cancelledAt!).getTime()).toBe(now.getTime());
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    expect(await refundsFor(order.id)).toMatchObject([
      {
        paymentId: payment.id,
        amountPaise: 10000,
        reason: 'vendor_cancelled',
        chargedTo: 'vendor',
        status: 'pending',
        createdBy: owner.id,
      },
    ]);
    expect(await auditRows('order.cancel')).toMatchObject([
      { actorId: owner.id, entity: 'order', entityId: order.id, detail: { reason: 'ran_out' } },
    ]);
  });

  test('collected order cannot be cancelled', async () => {
    const { order, drop } = await paidOrder();
    await db.update(orders).set({ status: 'collected' }).where(eq(orders.id, order.id));
    const owner = await staffOf(drop.outletId);
    expect(await failure(cancelOrder(owner.id, order.id, 'ran_out', now))).toMatchObject({
      code: 'not_cancellable',
      status: 409,
    });
    expect((await getOrderRow(order.id)).status).toBe('collected');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    expect(await refundsFor(order.id)).toHaveLength(0);
  });

  test('only a paid order can be cancelled', async () => {
    const { order, drop } = await heldOrder();
    const owner = await staffOf(drop.outletId);
    for (const status of ['held', 'expired', 'no_show', 'cancelled']) {
      await db.update(orders).set({ status }).where(eq(orders.id, order.id));
      expect(await failure(cancelOrder(owner.id, order.id, 'ran_out', now))).toMatchObject({ code: 'not_cancellable' });
    }
    expect(await auditRows('order.cancel')).toHaveLength(0);
  });

  test('cancel by staff of another outlet returns 403', async () => {
    const { order } = await paidOrder();
    const elsewhere = await staffOf((await makeLiveOutlet()).id, 'manager');
    expect(await failure(cancelOrder(elsewhere.id, order.id, 'ran_out', now))).toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });

  test('managers and counter staff can cancel', async () => {
    for (const role of ['manager', 'counter'] as const) {
      const { order, drop } = await paidOrder();
      await cancelOrder((await staffOf(drop.outletId, role)).id, order.id, 'closing_early', now);
      expect((await getOrderRow(order.id)).status).toBe('cancelled');
    }
  });

  test('the reason must be a known one', async () => {
    const { order, drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    for (const reason of ['', 'because', undefined]) {
      expect(await failure(cancelOrder(owner.id, order.id, reason as never, now))).toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
    }
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });

  test('an unknown or malformed order ID returns 404', async () => {
    const user = await makeUser();
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      expect(await failure(cancelOrder(user.id, id, 'ran_out', now))).toMatchObject({ code: 'not_found', status: 404 });
    }
  });

  test('refunds the payment that bought the bag, not a duplicate already refunded', async () => {
    const { order, payment, gp, drop } = await paidOrder();
    await applyCapture(capturedPayment(gp.orderId), now);
    expect(await refundsFor(order.id)).toMatchObject([{ reason: 'duplicate_payment' }]);

    await cancelOrder((await staffOf(drop.outletId)).id, order.id, 'ran_out', now);

    const rows = await refundsFor(order.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.reason === 'vendor_cancelled')).toMatchObject({ paymentId: payment.id });
  });

  test('refunds the extra payment when that is the one that bought the bag', async () => {
    const { order, payment, gp, drop } = await heldOrder({ quantity: 1 });
    await expireHolds(later);
    const next = await reserveDrop({ dropId: drop.id, anonId: 'next', ip: '1.1.1.1' }, later);
    await applyCapture(gp, later); // Sold out: refunded as late.
    await db.update(orders).set({ status: 'expired' }).where(eq(orders.id, next.id));
    await db.update(drops).set({ reservedCount: 0 }).where(eq(drops.id, drop.id));
    await applyCapture(capturedPayment(gp.orderId), later); // Stock is back: this one buys the bag.
    expect((await getOrderRow(order.id)).status).toBe('paid');

    await cancelOrder((await staffOf(drop.outletId)).id, order.id, 'ran_out', later);

    const extra = (await paymentRowsFor(order.id)).find((p) => p.id !== payment.id)!;
    expect((await refundsFor(order.id)).find((r) => r.reason === 'vendor_cancelled')).toMatchObject({
      paymentId: extra.id,
    });
  });

  test('a paid order with nothing left to refund is refused, and nothing changes', async () => {
    const { order, payment, drop } = await paidOrder();
    await db.insert(refunds).values({
      orderId: order.id,
      paymentId: payment.id,
      amountPaise: 10000,
      reason: 'issue_resolution',
      chargedTo: 'vendor',
    });
    const owner = await staffOf(drop.outletId);
    expect(await failure(cancelOrder(owner.id, order.id, 'ran_out', now))).toMatchObject({
      code: 'nothing_to_refund',
      status: 409,
    });
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('two cancels at once refund and free stock once', async () => {
    const { order, drop } = await paidOrder();
    await anotherOrder(drop.id, 'paid');
    const owner = await staffOf(drop.outletId);
    const results = await Promise.allSettled([
      cancelOrder(owner.id, order.id, 'ran_out', now),
      cancelOrder(owner.id, order.id, 'ran_out', now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await refundsFor(order.id)).toHaveLength(1);
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    expect(await auditRows('order.cancel')).toHaveLength(1);
  });
});

describe('cancelDrop', () => {
  test('cancelDrop refunds every paid order once', async () => {
    const first = await paidOrder();
    const { drop } = first;
    const second = await anotherOrder(drop.id, 'paid');
    const owner = await staffOf(drop.outletId);

    await cancelDrop(owner.id, drop.id, 'closing_early', now);

    expect(await getDropRow(drop.id)).toMatchObject({ status: 'cancelled', reservedCount: 0 });
    for (const { order, payment } of [first, second]) {
      expect(await getOrderRow(order.id)).toMatchObject({
        status: 'cancelled',
        cancelledBy: owner.id,
        cancelReason: 'closing_early',
      });
      expect(await refundsFor(order.id)).toMatchObject([
        { paymentId: payment.id, reason: 'vendor_cancelled', chargedTo: 'vendor', createdBy: owner.id },
      ]);
    }
    expect(await auditRows('drop.cancel')).toMatchObject([
      { actorId: owner.id, entity: 'drop', entityId: drop.id, detail: { reason: 'closing_early' } },
    ]);
    expect(await auditRows('order.cancel')).toHaveLength(2);
  });

  test('cancelling a drop expires its held orders and blocks new holds', async () => {
    const { order, drop } = await heldOrder();
    await cancelDrop((await staffOf(drop.outletId)).id, drop.id, 'ran_out', now);

    const row = await getOrderRow(order.id);
    expect(row.status).toBe('expired');
    expect(new Date(row.holdExpiresAt).getTime()).toBe(now.getTime());
    expect(await refundsFor(order.id)).toHaveLength(0);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    expect(await failure(reserveDrop({ dropId: drop.id, anonId: 'late', ip: '1.1.1.1' }, now))).toMatchObject({
      code: 'not_on_sale',
    });
  });

  test('capture after a drop cancel ends in a refund', async () => {
    const { order, gp, drop } = await heldOrder();
    await cancelDrop((await staffOf(drop.outletId)).id, drop.id, 'ran_out', now);
    await applyCapture(gp, now);
    expect((await refundsFor(order.id))[0]!.reason).toBe('late_payment');
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('collected orders stay as they are', async () => {
    const { order, drop } = await paidOrder();
    await db.update(orders).set({ status: 'collected' }).where(eq(orders.id, order.id));
    await cancelDrop((await staffOf(drop.outletId)).id, drop.id, 'ran_out', now);
    expect((await getOrderRow(order.id)).status).toBe('collected');
    expect(await refundsFor(order.id)).toHaveLength(0);
    expect(await getDropRow(drop.id)).toMatchObject({ status: 'cancelled', reservedCount: 1 });
  });

  test('a paused drop can be cancelled, and a cancelled one cannot be again', async () => {
    const { order, drop } = await paidOrder();
    await db.update(drops).set({ status: 'paused' }).where(eq(drops.id, drop.id));
    const owner = await staffOf(drop.outletId);
    await cancelDrop(owner.id, drop.id, 'ran_out', now);
    expect(await failure(cancelDrop(owner.id, drop.id, 'ran_out', now))).toMatchObject({
      code: 'drop_cancelled',
      status: 409,
    });
    expect(await refundsFor(order.id)).toHaveLength(1);
    expect(await auditRows('drop.cancel')).toHaveLength(1);
  });

  test('two cancels at once refund once', async () => {
    const { order, drop } = await paidOrder();
    await anotherOrder(drop.id, 'held');
    const owner = await staffOf(drop.outletId);
    const results = await Promise.allSettled([
      cancelDrop(owner.id, drop.id, 'ran_out', now),
      cancelDrop(owner.id, drop.id, 'ran_out', now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await refundsFor(order.id)).toHaveLength(1);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('cancel by staff of another outlet returns 403, and any staff role of this one may', async () => {
    const { drop } = await paidOrder();
    const elsewhere = await staffOf((await makeLiveOutlet()).id, 'manager');
    expect(await failure(cancelDrop(elsewhere.id, drop.id, 'ran_out', now))).toMatchObject({ status: 403 });
    expect((await getDropRow(drop.id)).status).toBe('live');

    await cancelDrop((await staffOf(drop.outletId, 'counter')).id, drop.id, 'ran_out', now);
    expect((await getDropRow(drop.id)).status).toBe('cancelled');
  });

  test('a bad reason or drop ID is refused', async () => {
    const { drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    expect(await failure(cancelDrop(owner.id, drop.id, 'because' as never, now))).toMatchObject({ status: 400 });
    expect(await failure(cancelDrop(owner.id, 'not-a-uuid', 'ran_out', now))).toMatchObject({ status: 404 });
    expect(
      await failure(cancelDrop(owner.id, '00000000-0000-4000-8000-000000000000', 'ran_out', now)),
    ).toMatchObject({ status: 404 });
  });
});

describe('cancel against the other writers', () => {
  test('a cancelDrop meeting the expiry job on one hold does not deadlock', async () => {
    const { order, drop } = await heldOrder();
    const other = await anotherOrder(drop.id, 'paid');
    const owner = await staffOf(drop.outletId);
    const client = await pool.connect();
    try {
      // Stands in for expireHolds: it has the order row, and has yet to touch the drop.
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE SKIP LOCKED', [order.id]);
      const cancel = cancelDrop(owner.id, drop.id, 'ran_out', now);
      await lockWaiters(1);

      // A cancel that had taken the drop first would hold it here, and the two would deadlock.
      await client.query('UPDATE drops SET reserved_count = reserved_count - 1 WHERE id = $1', [drop.id]);
      await client.query(`UPDATE orders SET status = 'expired' WHERE id = $1`, [order.id]);
      await client.query('COMMIT');
      await cancel;
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getOrderRow(other.order.id)).status).toBe('cancelled');
    expect(await getDropRow(drop.id)).toMatchObject({ status: 'cancelled', reservedCount: 0 });
  });

  test('a cancelDrop meeting a capture that has the order does not deadlock, and refunds it', async () => {
    const { order, payment, drop } = await heldOrder();
    const owner = await staffOf(drop.outletId);
    const client = await pool.connect();
    try {
      // Stands in for a capture on a hold: it has the order row, and marks it paid.
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
      const cancel = cancelDrop(owner.id, drop.id, 'ran_out', now);
      await lockWaiters(1);
      await client.query(`UPDATE payments SET status = 'captured', razorpay_payment_id = 'pay_race' WHERE id = $1`, [
        payment.id,
      ]);
      await client.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
      await client.query('COMMIT');
      await cancel;
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('cancelled');
    expect(await refundsFor(order.id)).toMatchObject([{ paymentId: payment.id, reason: 'vendor_cancelled' }]);
    expect(await getDropRow(drop.id)).toMatchObject({ status: 'cancelled', reservedCount: 0 });
  });

  test('a real capture waiting on an order cancelDrop has locked ends in a refund', async () => {
    const { order, gp, drop } = await heldOrder();
    const owner = await staffOf(drop.outletId);
    const client = await pool.connect();
    try {
      // Pauses cancelDrop after it has the orders, while it waits for the drop.
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM drops WHERE id = $1 FOR UPDATE', [drop.id]);
      const cancel = cancelDrop(owner.id, drop.id, 'ran_out', now);
      await lockWaiters(1);
      const capture = applyCapture(gp, now);
      await lockWaiters(2);
      await client.query('COMMIT');
      await Promise.all([cancel, capture]);
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect(await refundsFor(order.id)).toMatchObject([{ reason: 'late_payment' }]);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('a real expiry job skips an order cancelDrop has locked, and neither blocks the other', async () => {
    const { order, drop } = await heldOrder();
    const owner = await staffOf(drop.outletId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM drops WHERE id = $1 FOR UPDATE', [drop.id]);
      const cancel = cancelDrop(owner.id, drop.id, 'ran_out', later);
      await lockWaiters(1);
      expect(await expireHolds(later)).toBe(0);
      await client.query('COMMIT');
      await cancel;
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('a hold that lands while cancelDrop waits for the drop is expired too', async () => {
    const { drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    const newcomer = await makeUser();
    const client = await pool.connect();
    try {
      // Stands in for a reserve: it has the drop's row, and has yet to insert its order.
      await client.query('BEGIN');
      await client.query('UPDATE drops SET reserved_count = reserved_count + 1 WHERE id = $1', [drop.id]);
      const cancel = cancelDrop(owner.id, drop.id, 'ran_out', now);
      await lockWaiters(1);
      await client.query(
        `INSERT INTO orders (user_id, drop_id, outlet_id, service_date, price_paise, commission_bps,
                             commission_paise, hold_expires_at)
         VALUES ($1, $2, $3, $4, 1, 1, 1, $5)`,
        [newcomer.id, drop.id, drop.outletId, drop.serviceDate, later.toISOString()],
      );
      await client.query('COMMIT');
      await cancel;
    } finally {
      client.release();
    }
    const left = await db
      .select()
      .from(orders)
      .where(and(eq(orders.dropId, drop.id), inArray(orders.status, ['held', 'paid'])));
    expect(left).toHaveLength(0);
    expect(await getDropRow(drop.id)).toMatchObject({ status: 'cancelled', reservedCount: 0 });
  });

  test('a late capture that wins the drop first is refunded by the cancel', async () => {
    const { order, payment, gp, drop } = await heldOrder();
    await expireHolds(later);
    const owner = await staffOf(drop.outletId);
    const client = await pool.connect();
    try {
      // Stands in for a late capture: it took stock, and has yet to mark the order paid.
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
      await client.query('UPDATE drops SET reserved_count = reserved_count + 1 WHERE id = $1', [drop.id]);
      const cancel = cancelDrop(owner.id, drop.id, 'ran_out', later);
      await lockWaiters(1);
      await client.query(`UPDATE payments SET status = 'captured', razorpay_payment_id = $1 WHERE id = $2`, [
        gp.id,
        payment.id,
      ]);
      await client.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
      await client.query('COMMIT');
      await cancel;
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('cancelled');
    expect(await refundsFor(order.id)).toMatchObject([{ reason: 'vendor_cancelled' }]);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('a cancelOrder leaves a re-reserve free to finish', async () => {
    const { order, user, drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    const client = await pool.connect();
    try {
      // Stands in for a reserve by the same customer: it has the drop's row, and has yet to insert.
      await client.query('BEGIN');
      await client.query('UPDATE drops SET reserved_count = reserved_count + 1 WHERE id = $1', [drop.id]);
      const cancel = cancelOrder(owner.id, order.id, 'ran_out', now);
      await lockWaiters(1);

      // A cancel that had changed the order first would block this insert while waiting on the drop.
      await expect(
        client.query(
          `INSERT INTO orders (user_id, drop_id, outlet_id, service_date, price_paise, commission_bps,
                               commission_paise, hold_expires_at)
           VALUES ($1, $2, $3, $4, 1, 1, 1, $5)`,
          [user.id, drop.id, drop.outletId, drop.serviceDate, later.toISOString()],
        ),
      ).rejects.toThrow(/one_order_per_outlet_night/);
      await client.query('ROLLBACK');
      await cancel;
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('cancelled');
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('cancelDrop racing the real writers leaves nothing live and no stock out', async () => {
    for (let i = 0; i < 10; i++) {
      const { drop, gp } = await heldOrder();
      const paid = await anotherOrder(drop.id, 'paid');
      const owner = await staffOf(drop.outletId);
      await Promise.allSettled([
        cancelDrop(owner.id, drop.id, 'ran_out', later),
        applyCapture(gp, later),
        expireHolds(later),
        cancelOrder(owner.id, paid.order.id, 'ran_out', later),
        reserveDrop({ dropId: drop.id, userId: (await makeUser()).id, ip: '1.1.1.1' }, later),
      ]);
      const left = await db
        .select()
        .from(orders)
        .where(and(eq(orders.dropId, drop.id), inArray(orders.status, ['held', 'paid'])));
      expect(left).toHaveLength(0);
      expect(await getDropRow(drop.id)).toMatchObject({ status: 'cancelled', reservedCount: 0 });
    }
  });
});

describe('processRefunds', () => {
  test('processRefunds calls the gateway once, with an idempotency key', async () => {
    const { refund, gp } = await cancelledOrder();
    expect(await processRefunds(now)).toBe(1);
    expect(gateway.refunds).toMatchObject([
      { paymentId: gp.id, amountPaise: 10000, reverseTransfer: false, idempotencyKey: `${refund.id}-0` },
    ]);
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'pending',
      razorpayRefundId: gateway.refunds[0]!.id,
      sendingAt: null,
      attempts: 0,
    });

    expect(await processRefunds(seconds(now, 60))).toBe(0);
    expect(gateway.refunds).toHaveLength(1);
  });

  test('marks the refund processed at once if the gateway says so', async () => {
    const { refund } = await cancelledOrder();
    const send = gateway.refund.bind(gateway);
    gateway.refund = async (a) => ({ ...(await send(a)), status: 'processed' });
    await processRefunds(now);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'processed', razorpayRefundId: gateway.refunds[0]!.id });
  });

  test('refund.processed webhook marks it processed', async () => {
    const { refund } = await cancelledOrder();
    await processRefunds(now);
    await deliver(refundEvent('refund.processed', gateway.refunds[0]!.id));
    expect((await refundRow(refund.id)).status).toBe('processed');
  });

  test('refund reverses the transfer only if one exists', async () => {
    const none = await cancelledOrder();
    const released = await cancelledOrder();
    await setTransfer(released.payment.id, 'released');
    const onHold = await cancelledOrder();
    await setTransfer(onHold.payment.id, 'on_hold');

    await processRefunds(now);

    const sent = (paymentId: string) => gateway.refunds.find((r) => r.paymentId === paymentId)!;
    expect(sent(none.gp.id).reverseTransfer).toBe(false);
    expect(sent(released.gp.id).reverseTransfer).toBe(false);
    expect(sent(onHold.gp.id).reverseTransfer).toBe(true);
    expect((await paymentRow(none.payment.id)).transferStatus).toBe('none');
    expect((await paymentRow(released.payment.id)).transferStatus).toBe('released');
    expect((await paymentRow(onHold.payment.id)).transferStatus).toBe('reversed');
  });

  test('a transfer stays on hold until the refund is sent', async () => {
    const { payment } = await cancelledOrder();
    await setTransfer(payment.id, 'on_hold');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    gateway.refund = () => Promise.reject(new Error('gateway down'));
    await processRefunds(now);
    expect((await paymentRow(payment.id)).transferStatus).toBe('on_hold');
  });

  test('third failure audits refund.failed for admin', async () => {
    const { refund } = await cancelledOrder();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const keys: string[] = [];
    gateway.refund = (a) => {
      keys.push(a.idempotencyKey);
      return Promise.reject(new Error('gateway down'));
    };

    expect(await processRefunds(now)).toBe(0);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'pending', attempts: 1, sendingAt: null });
    await processRefunds(now);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'pending', attempts: 2 });
    expect(await auditRows('refund.failed')).toHaveLength(0);

    await processRefunds(now);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', attempts: 3, razorpayRefundId: null });
    expect(await auditRows('refund.failed')).toMatchObject([
      { entity: 'refund', entityId: refund.id, detail: { razorpayRefundId: null, attempts: 3 } },
    ]);
    expect(keys).toEqual([`${refund.id}-0`, `${refund.id}-1`, `${refund.id}-2`]);
    expect(logged).toHaveBeenCalled();

    await processRefunds(now);
    expect(keys).toHaveLength(3);
  });

  test('a refund.failed sends again as a new attempt, and reverses the transfer again', async () => {
    const { refund, payment } = await cancelledOrder();
    await setTransfer(payment.id, 'on_hold');
    await processRefunds(now);
    expect((await paymentRow(payment.id)).transferStatus).toBe('reversed');

    await deliver(refundEvent('refund.failed', gateway.refunds[0]!.id));
    expect(await refundRow(refund.id)).toMatchObject({ status: 'pending', attempts: 1, razorpayRefundId: null });
    expect((await paymentRow(payment.id)).transferStatus).toBe('on_hold');

    await processRefunds(now);
    expect(gateway.refunds).toHaveLength(2);
    expect(gateway.refunds[1]).toMatchObject({ idempotencyKey: `${refund.id}-1`, reverseTransfer: true });
    expect(await refundRow(refund.id)).toMatchObject({ razorpayRefundId: gateway.refunds[1]!.id });
    expect((await paymentRow(payment.id)).transferStatus).toBe('reversed');
  });

  test('one failing refund does not stop the rest', async () => {
    const bad = await cancelledOrder();
    const good = await cancelledOrder();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = gateway.refund.bind(gateway);
    gateway.refund = (a) => (a.paymentId === bad.gp.id ? Promise.reject(new Error('gateway down')) : send(a));
    expect(await processRefunds(now)).toBe(1);
    expect((await refundRow(good.refund.id)).razorpayRefundId).not.toBeNull();
    expect((await refundRow(bad.refund.id)).attempts).toBe(1);
  });

  test('rows already sent, processed or failed are left alone', async () => {
    const sent = await cancelledOrder();
    await db.update(refunds).set({ razorpayRefundId: 'rfnd_x' }).where(eq(refunds.id, sent.refund.id));
    const processed = await cancelledOrder();
    await db.update(refunds).set({ status: 'processed' }).where(eq(refunds.id, processed.refund.id));
    const failed = await cancelledOrder();
    await db.update(refunds).set({ status: 'failed' }).where(eq(refunds.id, failed.refund.id));
    expect(await processRefunds(now)).toBe(0);
    expect(gateway.refunds).toHaveLength(0);
  });

  test('two runs at once send each refund once', async () => {
    const all = [await cancelledOrder(), await cancelledOrder(), await cancelledOrder()];
    const calls: string[] = [];
    const send = gateway.refund.bind(gateway);
    gateway.refund = async (a) => {
      calls.push(a.idempotencyKey);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return send(a);
    };
    const counts = await Promise.all([processRefunds(now), processRefunds(now)]);
    expect(counts[0]! + counts[1]!).toBe(3);
    expect(calls.sort()).toEqual(all.map((a) => `${a.refund.id}-0`).sort());
  });

  test('a crash after sending does not double-refund', async () => {
    const { refund, payment } = await cancelledOrder();
    await setTransfer(payment.id, 'on_hold');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // The claim commits and the gateway takes the refund, but the ID is never saved.
    const transaction = db.transaction.bind(db);
    let calls = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((fn: never) =>
      ++calls === 1 ? transaction(fn) : Promise.reject(new Error('process died'))) as never);
    expect(await processRefunds(now)).toBe(0);
    spy.mockRestore();
    expect(logged).toHaveBeenCalled();
    expect(gateway.refunds).toHaveLength(1);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'pending', attempts: 0, razorpayRefundId: null });

    // Still within the claim, so nothing is sent.
    const calledWith: string[] = [];
    const send = gateway.refund.bind(gateway);
    gateway.refund = (a) => {
      calledWith.push(a.idempotencyKey);
      return send(a);
    };
    expect(await processRefunds(seconds(now, LEASE_SECONDS - 1))).toBe(0);
    expect(calledWith).toHaveLength(0);

    // Past it, the same attempt goes again with the same key, and the gateway answers with the same refund.
    expect(await processRefunds(seconds(now, LEASE_SECONDS + 1))).toBe(1);
    expect(calledWith).toEqual([`${refund.id}-0`]);
    expect(gateway.refunds).toHaveLength(1);
    expect(await refundRow(refund.id)).toMatchObject({ razorpayRefundId: gateway.refunds[0]!.id, attempts: 0 });
    expect((await paymentRow(payment.id)).transferStatus).toBe('reversed');
  });

  test('sends at most 100 in a run', async () => {
    const drop = await makeDrop({ quantity: 110, reservedCount: 110 });
    const rows = await db
      .insert(orders)
      .values(
        Array.from({ length: 101 }, (_, i) => ({
          anonId: `a${i}`,
          status: 'cancelled',
          dropId: drop.id,
          outletId: drop.outletId,
          serviceDate: drop.serviceDate,
          pricePaise: 10000,
          commissionBps: 2000,
          commissionPaise: 2000,
          holdExpiresAt: now.toISOString(),
        })),
      )
      .returning({ id: orders.id });
    const paid = await db
      .insert(payments)
      .values(
        rows.map((r, i) => ({
          orderId: r.id,
          razorpayOrderId: `order_b_${i}`,
          razorpayPaymentId: `pay_b_${i}`,
          status: 'captured',
          amountPaise: 10000,
        })),
      )
      .returning({ id: payments.id, orderId: payments.orderId });
    await db.insert(refunds).values(
      paid.map((p) => ({
        orderId: p.orderId,
        paymentId: p.id,
        amountPaise: 10000,
        reason: 'vendor_cancelled',
        chargedTo: 'vendor',
      })),
    );

    expect(await processRefunds(now)).toBe(100);
    expect(gateway.refunds).toHaveLength(100);
    expect(await processRefunds(now)).toBe(1);
  });

  test('late and duplicate payment refunds are sent too', async () => {
    const { order, gp } = await paidOrder();
    const second = capturedPayment(gp.orderId);
    await applyCapture(second, now);
    const [refund] = await refundsFor(order.id);
    await processRefunds(now);
    expect(gateway.refunds).toMatchObject([{ paymentId: second.id, idempotencyKey: `${refund!.id}-0` }]);
  });
});

describe('vendor routes', () => {
  const post = async (path: string, body: unknown, userId?: string) =>
    app.request(`/api/v1/vendor${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(userId
          ? { cookie: `session=${await createSession(userId, new Date())}`, origin: env().FRONTEND_ORIGIN }
          : {}),
      },
      body: JSON.stringify(body),
    });

  test('POST /orders/:id/cancel cancels and refuses', async () => {
    const { order, drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    const stranger = await makeUser();

    expect((await post(`/orders/${order.id}/cancel`, { reason: 'ran_out' })).status).toBe(401);
    expect((await post(`/orders/${order.id}/cancel`, {}, owner.id)).status).toBe(400);
    expect((await post(`/orders/${order.id}/cancel`, { reason: 'nope' }, owner.id)).status).toBe(400);
    expect((await post(`/orders/${order.id}/cancel`, { reason: 'ran_out' }, stranger.id)).status).toBe(403);

    const res = await post(`/orders/${order.id}/cancel`, { reason: 'ran_out' }, owner.id);
    expect(res.status).toBe(200);
    expect((await getOrderRow(order.id)).status).toBe('cancelled');

    const again = await post(`/orders/${order.id}/cancel`, { reason: 'ran_out' }, owner.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'not_cancellable' } });
  });

  test('POST /drops/:id/cancel cancels the drop', async () => {
    const { order, drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    expect((await post(`/drops/${drop.id}/cancel`, {}, owner.id)).status).toBe(400);
    const res = await post(`/drops/${drop.id}/cancel`, { reason: 'quality' }, owner.id);
    expect(res.status).toBe(200);
    expect((await getDropRow(drop.id)).status).toBe('cancelled');
    expect((await getOrderRow(order.id)).cancelReason).toBe('quality');
  });
});
