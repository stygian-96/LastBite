import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool, withTx } from '../../src/db/client.js';
import { auditLog, drops, notifications, orders, outlets, payments, refunds, webhookEvents } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { FakeGateway, setGateway, type GatewayPayment } from '../../src/integrations/payments.js';
import { createSession } from '../../src/modules/auth/session.js';
import { deleteAccount } from '../../src/modules/customer/profile.js';
import { expireHolds } from '../../src/modules/orders/expire.js';
import { reserveDrop } from '../../src/modules/orders/reserve.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { reconcilePayments } from '../../src/modules/payments/reconcile.js';
import { startPayment } from '../../src/modules/payments/start.js';
import { handleWebhook } from '../../src/modules/payments/webhook.js';
import { createRefund } from '../../src/modules/refunds/create.js';
import { app } from '../../src/app.js';
import { makeDrop, makeOrder, makePaidOrder, makePayment, makeUser } from '../helpers/factories.js';
import { getDropRow, getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-02. Default drops stop selling at 20:45 IST.
const now = new Date('2026-11-02T10:00:00Z');
const seconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const HOLD_SECONDS = 5 * 60;
// Past the hold and its 60 seconds of grace.
const later = seconds(now, HOLD_SECONDS + 61);

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

/** A hold from a real reserve, with a Razorpay order and a payment captured on it. */
async function heldOrder(dropOptions: Parameters<typeof makeDrop>[0] = {}) {
  const user = await makeUser();
  const drop = await makeDrop(dropOptions);
  const reserved = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
  const payment = await makePayment({ orderId: reserved.id });
  const gp = capturedPayment(payment.razorpayOrderId);
  return { user, drop, order: reserved, payment, gp };
}

/** A hold the expiry job has already ended. */
async function expiredOrder(dropOptions: Parameters<typeof makeDrop>[0] = {}) {
  const held = await heldOrder(dropOptions);
  await expireHolds(later);
  return held;
}

const heldOrderPastExpiry = () => heldOrder();

const paymentRow = async (id: string) => {
  const [row] = await db.select().from(payments).where(eq(payments.id, id));
  if (!row) throw new Error('payment row not found');
  return row;
};
const paymentRowsFor = (orderId: string) => db.select().from(payments).where(eq(payments.orderId, orderId));
const auditRows = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const storedEvents = () => db.select().from(webhookEvents);

const paymentEvent = (type: string, gp: GatewayPayment) =>
  JSON.stringify({ event: type, payload: { payment: { entity: { id: gp.id, order_id: gp.orderId } } } });
const refundEvent = (type: string, id: string) =>
  JSON.stringify({ event: type, payload: { refund: { entity: { id } } } });
const deliver = (raw: string, eventId = `evt_${++seq}`) => handleWebhook(raw, 'valid', eventId, now);

/** Resolves once some connection is waiting on a lock. */
const someoneWaitsOnLock = () =>
  vi.waitFor(async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

describe('POST /orders/:id/pay', () => {
  const pay = (orderId: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/v1/orders/${orderId}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const signedIn = async (userId: string) => ({
    cookie: `session=${await createSession(userId, new Date())}`,
    origin: env().FRONTEND_ORIGIN,
  });

  test('pay needs a signed-in owner and the allergen acknowledgement', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id, pricePaise: 12345 });
    const headers = await signedIn(user.id);

    expect((await pay(order.id, { allergenAck: true })).status).toBe(401);
    expect((await pay(order.id, { allergenAck: true }, await signedIn((await makeUser()).id))).status).toBe(404);
    expect((await pay(order.id, {}, headers)).status).toBe(400);

    const refused = await pay(order.id, { allergenAck: false }, headers);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'ack_required' } });
    expect((await getOrderRow(order.id)).allergenAckAt).toBeNull();
    expect(gateway.orders).toHaveLength(0);

    const res = await pay(order.id, { allergenAck: true }, headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ amountPaise: 12345, keyId: gateway.keyId, razorpayOrderId: gateway.orders[0]!.id });
    expect(body.timeoutSeconds).toBeGreaterThan(0);
    expect(gateway.orders[0]).toMatchObject({ amountPaise: 12345, receipt: order.id });
    expect((await getOrderRow(order.id)).allergenAckAt).not.toBeNull();
    const [row] = await paymentRowsFor(order.id);
    expect(row).toMatchObject({ status: 'created', amountPaise: 12345, razorpayOrderId: gateway.orders[0]!.id });
  });

  test('a guest hold cannot pay, even with its anon cookie', async () => {
    const order = await makeOrder({ userId: null, anonId: 'a' });
    expect((await pay(order.id, { allergenAck: true })).status).toBe(401);
  });

  test('a bad origin is refused', async () => {
    const user = await makeUser();
    const order = await makeOrder({ userId: user.id });
    const res = await pay(order.id, { allergenAck: true }, { ...(await signedIn(user.id)), origin: 'https://evil.test' });
    expect(res.status).toBe(403);
  });
});

describe('startPayment', () => {
  test('pay after the hold ended returns 409 hold_expired', async () => {
    const { user, order } = await heldOrder();
    const expiry = seconds(now, HOLD_SECONDS);
    expect(await failure(startPayment(user.id, order.id, { allergenAck: true }, expiry))).toMatchObject({
      code: 'hold_expired',
      status: 409,
    });

    await expireHolds(later);
    expect(await failure(startPayment(user.id, order.id, { allergenAck: true }, now))).toMatchObject({
      code: 'hold_expired',
      status: 409,
    });
    expect(gateway.orders).toHaveLength(0);
  });

  test('an order already paid cannot be paid again', async () => {
    const user = await makeUser();
    const order = await makePaidOrder({ userId: user.id });
    expect(await failure(startPayment(user.id, order.id, { allergenAck: true }, new Date()))).toMatchObject({
      code: 'hold_expired',
    });
  });

  test('retry reuses the Razorpay order', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    const order = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
    const first = await startPayment(user.id, order.id, { allergenAck: true }, now);
    await db.update(payments).set({ status: 'failed' }).where(eq(payments.orderId, order.id));
    const second = await startPayment(user.id, order.id, { allergenAck: true }, seconds(now, 30));
    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
    expect(gateway.orders).toHaveLength(1);
    expect(await paymentRowsFor(order.id)).toHaveLength(1);
  });

  test('a double tap leaves one payment row, and both get its Razorpay order', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    const order = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
    const [a, b] = await Promise.all([
      startPayment(user.id, order.id, { allergenAck: true }, now),
      startPayment(user.id, order.id, { allergenAck: true }, now),
    ]);
    expect(a.razorpayOrderId).toBe(b.razorpayOrderId);
    expect(await paymentRowsFor(order.id)).toHaveLength(1);
  });

  test('timeoutSeconds equals seconds left on the hold', async () => {
    const user = await makeUser();
    const drop = await makeDrop();
    const order = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
    const paying = await startPayment(user.id, order.id, { allergenAck: true }, seconds(now, 100));
    expect(paying.timeoutSeconds).toBe(HOLD_SECONDS - 100);
  });
});

describe('POST /webhooks/razorpay', () => {
  const post = (raw: string, headers: Record<string, string> = {}) =>
    app.request('/api/v1/webhooks/razorpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    });
  const signed = (eventId: string) => ({ 'x-razorpay-signature': 'valid', 'x-razorpay-event-id': eventId });

  test('bad signature returns 401 and stores nothing', async () => {
    const { order, gp } = await heldOrder();
    const raw = paymentEvent('payment.captured', gp);
    expect((await post(raw, { 'x-razorpay-signature': 'nope', 'x-razorpay-event-id': 'e1' })).status).toBe(401);
    expect((await post(raw, { 'x-razorpay-event-id': 'e1' })).status).toBe(401);
    expect(await storedEvents()).toHaveLength(0);
    expect((await getOrderRow(order.id)).status).toBe('held');
    expect(gateway.fetches).toHaveLength(0);
  });

  test('a valid delivery confirms the order, and the event is stored', async () => {
    const { order, gp } = await heldOrder();
    const res = await post(paymentEvent('payment.captured', gp), signed('e1'));
    expect(res.status).toBe(200);
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect(await storedEvents()).toMatchObject([{ eventId: 'e1', eventType: 'payment.captured' }]);
  });

  test('stray cookies and a foreign Origin do not block a webhook', async () => {
    const { order, gp } = await heldOrder();
    const res = await post(paymentEvent('payment.captured', gp), {
      ...signed('e1'),
      cookie: 'session=whatever',
      origin: 'https://api.razorpay.com',
    });
    expect(res.status).toBe(200);
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });

  test('no event ID or an unreadable body returns 400 and stores nothing', async () => {
    const { gp } = await heldOrder();
    expect((await post(paymentEvent('payment.captured', gp), { 'x-razorpay-signature': 'valid' })).status).toBe(400);
    expect((await post('not json', signed('e1'))).status).toBe(400);
    expect((await post(JSON.stringify({ event: 'payment.captured' }), signed('e2'))).status).toBe(400);
    expect(await storedEvents()).toHaveLength(0);
  });

  test('a failure returns 500 and stores nothing, so the retry does the work', async () => {
    const { order, gp } = await heldOrder();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    gateway.fetchPayment = () => Promise.reject(new Error('gateway down'));
    expect((await post(paymentEvent('payment.captured', gp), signed('e1'))).status).toBe(500);
    expect(logged).toHaveBeenCalled();
    expect(await storedEvents()).toHaveLength(0);

    gateway = new FakeGateway();
    gateway.addPayment(gp);
    setGateway(gateway);
    expect((await post(paymentEvent('payment.captured', gp), signed('e1'))).status).toBe(200);
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });
});

describe('handleWebhook', () => {
  test('same event twice has one effect', async () => {
    const { order, gp } = await heldOrder();
    await deliver(paymentEvent('payment.captured', gp), 'e1');
    const { pickupCode } = await getOrderRow(order.id);
    await deliver(paymentEvent('payment.captured', gp), 'e1');
    expect((await getOrderRow(order.id)).pickupCode).toBe(pickupCode);
    expect(await storedEvents()).toHaveLength(1);
    expect(gateway.fetches).toHaveLength(1);
  });

  test('the same event delivered at once has one effect', async () => {
    const { order, gp } = await heldOrder();
    const raw = paymentEvent('payment.captured', gp);
    await Promise.all([deliver(raw, 'e1'), deliver(raw, 'e1')]);
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect(await storedEvents()).toHaveLength(1);
    expect(await refundsFor(order.id)).toHaveLength(0);
  });

  test('a throw while applying the effect stores no event and changes nothing', async () => {
    const { order, drop, gp } = await heldOrder();
    await makeOrder({
      dropId: drop.id,
      outletId: drop.outletId,
      serviceDate: drop.serviceDate,
      status: 'paid',
      pickupCode: 'A000',
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await expect(deliver(paymentEvent('payment.captured', gp), 'e1')).rejects.toThrow();
    expect(await storedEvents()).toHaveLength(0);
    expect(await getOrderRow(order.id)).toMatchObject({ status: 'held', pickupCode: null });
    expect((await paymentRowsFor(order.id))[0]).toMatchObject({ status: 'created', razorpayPaymentId: null });
  });

  test('a capture the gateway has not confirmed is retried, not dropped', async () => {
    const { order, gp } = await heldOrder();
    gateway.addPayment({ ...gp, status: 'authorized' });
    await expect(deliver(paymentEvent('payment.captured', gp), 'e1')).rejects.toThrow();
    expect(await storedEvents()).toHaveLength(0);
    expect((await getOrderRow(order.id)).status).toBe('held');
  });

  test('a capture event for a payment since refunded does nothing', async () => {
    const { order, gp } = await heldOrder();
    gateway.addPayment({ ...gp, status: 'refunded' });
    await deliver(paymentEvent('payment.captured', gp), 'e1');
    expect((await getOrderRow(order.id)).status).toBe('held');
    expect(await storedEvents()).toHaveLength(1);
  });

  test('the gateway decides, not the event: a failure event for a captured payment confirms', async () => {
    const { order, gp } = await heldOrder();
    await deliver(paymentEvent('payment.failed', gp));
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });

  test('other event types are logged and ignored', async () => {
    await deliver(JSON.stringify({ event: 'order.paid', payload: {} }), 'e1');
    expect(await storedEvents()).toMatchObject([{ eventId: 'e1', eventType: 'order.paid' }]);
    expect(gateway.fetches).toHaveLength(0);
  });

  test('failed payment keeps the order held', async () => {
    const { order, payment, gp } = await heldOrder();
    const failed = capturedPayment(gp.orderId, { status: 'failed' });
    await deliver(paymentEvent('payment.failed', failed));
    expect((await getOrderRow(order.id)).status).toBe('held');
    expect((await getDropRow(order.dropId)).reservedCount).toBe(1);
    expect((await paymentRow(payment.id)).status).toBe('failed');
  });

  test('a retry on the same Razorpay order moves a failed payment to captured', async () => {
    const { order, payment, gp } = await heldOrder();
    await deliver(paymentEvent('payment.failed', capturedPayment(gp.orderId, { status: 'failed' })));
    await deliver(paymentEvent('payment.captured', gp));
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'captured', razorpayPaymentId: gp.id });
    expect(await paymentRowsFor(order.id)).toHaveLength(1);
  });

  test('a failure arriving after the capture changes nothing', async () => {
    const { order, payment, gp } = await heldOrder();
    await deliver(paymentEvent('payment.captured', gp));
    await deliver(paymentEvent('payment.failed', capturedPayment(gp.orderId, { status: 'failed' })));
    expect((await paymentRow(payment.id)).status).toBe('captured');
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });

  describe('refund events', () => {
    const refundWithId = async (razorpayRefundId: string) => {
      const order = await makePaidOrder();
      const [payment] = await paymentRowsFor(order.id);
      const [row] = await db
        .insert(refunds)
        .values({
          orderId: order.id,
          paymentId: payment!.id,
          amountPaise: 10000,
          reason: 'vendor_cancelled',
          chargedTo: 'vendor',
          razorpayRefundId,
        })
        .returning();
      return row!;
    };
    const refundRow = async (id: string) => (await db.select().from(refunds).where(eq(refunds.id, id)))[0]!;

    test('refund.processed marks the row, without calling the gateway', async () => {
      const a = await refundWithId('rfnd_a');
      await deliver(refundEvent('refund.processed', 'rfnd_a'));
      expect((await refundRow(a.id)).status).toBe('processed');
      expect(gateway.fetches).toHaveLength(0);
    });

    test('a failed refund stays pending for a resend, and the third failure ends it', async () => {
      const a = await refundWithId('rfnd_1');
      const resentAs = (razorpayRefundId: string) =>
        db.update(refunds).set({ razorpayRefundId }).where(eq(refunds.id, a.id));

      await deliver(refundEvent('refund.failed', 'rfnd_1'));
      expect(await refundRow(a.id)).toMatchObject({ status: 'pending', attempts: 1, razorpayRefundId: null });

      await resentAs('rfnd_2');
      await deliver(refundEvent('refund.failed', 'rfnd_2'));
      expect(await refundRow(a.id)).toMatchObject({ status: 'pending', attempts: 2, razorpayRefundId: null });
      expect(await auditRows('refund.failed')).toHaveLength(0);

      await resentAs('rfnd_3');
      await deliver(refundEvent('refund.failed', 'rfnd_3'));
      expect(await refundRow(a.id)).toMatchObject({ status: 'failed', attempts: 3, razorpayRefundId: 'rfnd_3' });
      expect(await auditRows('refund.failed')).toMatchObject([
        { entity: 'refund', entityId: a.id, detail: { razorpayRefundId: 'rfnd_3', attempts: 3 } },
      ]);
    });

    test('a failure reported twice counts once', async () => {
      const a = await refundWithId('rfnd_1');
      await deliver(refundEvent('refund.failed', 'rfnd_1'));
      await deliver(refundEvent('refund.failed', 'rfnd_1'));
      expect((await refundRow(a.id)).attempts).toBe(1);

      await db.update(refunds).set({ attempts: 2, razorpayRefundId: 'rfnd_3' }).where(eq(refunds.id, a.id));
      await deliver(refundEvent('refund.failed', 'rfnd_3'));
      await deliver(refundEvent('refund.failed', 'rfnd_3'));
      expect((await refundRow(a.id)).attempts).toBe(3);
      expect(await auditRows('refund.failed')).toHaveLength(1);
    });

    test('a late refund.failed does not undo a processed refund', async () => {
      const a = await refundWithId('rfnd_a');
      await deliver(refundEvent('refund.processed', 'rfnd_a'));
      await deliver(refundEvent('refund.failed', 'rfnd_a'));
      expect((await refundRow(a.id)).status).toBe('processed');
    });

    test('an unknown refund ID with no payment to go on is stored, not redelivered', async () => {
      await deliver(refundEvent('refund.processed', 'rfnd_unknown'), 'e1');
      expect(await storedEvents()).toMatchObject([{ eventId: 'e1', eventType: 'refund.processed' }]);
      expect(await auditRows('refund.unknown')).toMatchObject([{ detail: { razorpayRefundId: 'rfnd_unknown' } }]);
    });
  });
});

describe('applyCapture', () => {
  test('capture on held marks paid and sets a code', async () => {
    const { order, payment, gp } = await heldOrder();
    await applyCapture(gp, now);
    const row = await getOrderRow(order.id);
    expect(row.status).toBe('paid');
    expect(row.pickupCode).toMatch(/^[A-HJ-NP-Z]\d{3}$/);
    expect(new Date(row.paidAt!).getTime()).toBe(now.getTime());
    expect(await paymentRow(payment.id)).toMatchObject({
      status: 'captured',
      razorpayPaymentId: gp.id,
      feePaise: 236,
      method: 'upi',
    });
    expect((await getDropRow(order.dropId)).reservedCount).toBe(1);
    expect(await refundsFor(order.id)).toHaveLength(0);
  });

  test('a capture after the hold ended but before the job ran still confirms', async () => {
    const { order, gp } = await heldOrderPastExpiry();
    await applyCapture(gp, later);
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect((await getDropRow(order.dropId)).reservedCount).toBe(1);
  });

  test('a clash on the pickup code retries with another', async () => {
    const { order, drop, gp } = await heldOrder();
    await makeOrder({
      dropId: drop.id,
      outletId: drop.outletId,
      serviceDate: drop.serviceDate,
      status: 'paid',
      pickupCode: 'A000',
    });
    const random = vi.spyOn(Math, 'random');
    for (const r of [0, 0, 0, 0, 0.1, 0.5]) random.mockReturnValueOnce(r);
    await applyCapture(gp, now);
    expect((await getOrderRow(order.id)).pickupCode).toBe('C500');
  });

  test('capture with a mismatched amount does not confirm and is audited', async () => {
    const { order, payment, gp } = await heldOrder();
    await applyCapture({ ...gp, amountPaise: 9999 }, now);
    expect((await getOrderRow(order.id)).status).toBe('held');
    expect((await paymentRow(payment.id)).status).toBe('created');
    expect(await refundsFor(order.id)).toHaveLength(0);
    const [entry] = await auditRows('payment.amount_mismatch');
    expect(entry).toMatchObject({
      entity: 'order',
      entityId: order.id,
      detail: { razorpayPaymentId: gp.id, amountPaise: 9999, expectedPaise: 10000 },
    });
  });

  test('a mismatched amount on an expired order retakes no stock', async () => {
    const { order, gp } = await expiredOrder();
    await applyCapture({ ...gp, amountPaise: 9999 }, later);
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getDropRow(order.dropId)).reservedCount).toBe(0);
    expect(await refundsFor(order.id)).toHaveLength(0);
    expect(await auditRows('payment.amount_mismatch')).toHaveLength(1);
  });

  test('a capture with no payment row is audited and not refunded', async () => {
    const gp = capturedPayment('order_nobody');
    await applyCapture(gp, now);
    const [entry] = await auditRows('payment.unmatched');
    expect(entry).toMatchObject({
      entity: 'payment',
      detail: { razorpayOrderId: 'order_nobody', razorpayPaymentId: gp.id },
    });
    expect(await db.select().from(refunds)).toHaveLength(0);
  });

  test('the same payment applied twice does nothing the second time', async () => {
    const { order, gp } = await heldOrder();
    await applyCapture(gp, now);
    const { pickupCode } = await getOrderRow(order.id);
    await applyCapture(gp, seconds(now, 5));
    expect((await getOrderRow(order.id)).pickupCode).toBe(pickupCode);
    expect(await refundsFor(order.id)).toHaveLength(0);
    expect(await paymentRowsFor(order.id)).toHaveLength(1);
  });

  test('duplicate capture from a second payment refunds it', async () => {
    const { order, payment, gp } = await heldOrder();
    await applyCapture(gp, now);
    const { pickupCode } = await getOrderRow(order.id);

    const second = capturedPayment(gp.orderId, { feePaise: 300, method: 'card' });
    await applyCapture(second, now);
    await applyCapture(second, now);

    expect(await getOrderRow(order.id)).toMatchObject({ status: 'paid', pickupCode });
    const rows = await paymentRowsFor(order.id);
    expect(rows).toHaveLength(2);
    const extra = rows.find((r) => r.id !== payment.id)!;
    expect(extra).toMatchObject({ status: 'captured', razorpayPaymentId: second.id, feePaise: 300, method: 'card' });
    expect(await refundsFor(order.id)).toMatchObject([
      {
        paymentId: extra.id,
        amountPaise: 10000,
        reason: 'duplicate_payment',
        chargedTo: 'platform',
        status: 'pending',
      },
    ]);
  });

  test('a second payment after pickup or a no-show is refunded too', async () => {
    for (const status of ['collected', 'no_show']) {
      const { order, gp } = await heldOrder();
      await applyCapture(gp, now);
      await db.update(orders).set({ status }).where(eq(orders.id, order.id));
      await applyCapture(capturedPayment(gp.orderId), now);
      expect(await getOrderRow(order.id)).toMatchObject({ status });
      expect(await refundsFor(order.id)).toMatchObject([{ reason: 'duplicate_payment' }]);
    }
  });

  test('two payments captured at once give one bag and one refund', async () => {
    const { order, gp } = await heldOrder();
    const second = capturedPayment(gp.orderId);
    await Promise.all([applyCapture(gp, now), applyCapture(second, now)]);
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect(await refundsFor(order.id)).toMatchObject([{ reason: 'duplicate_payment' }]);
    expect((await getDropRow(order.dropId)).reservedCount).toBe(1);
  });

  test('late capture with stock left marks paid and retakes stock', async () => {
    const { order, payment, gp } = await expiredOrder();
    expect((await getDropRow(order.dropId)).reservedCount).toBe(0);
    await applyCapture(gp, later);
    const row = await getOrderRow(order.id);
    expect(row.status).toBe('paid');
    expect(row.pickupCode).not.toBeNull();
    expect((await paymentRow(payment.id)).status).toBe('captured');
    expect((await getDropRow(order.dropId)).reservedCount).toBe(1);
    expect(await refundsFor(order.id)).toHaveLength(0);
  });

  const expectLateRefund = async (orderId: string, paymentId: string, reservedCount: number) => {
    expect(await getOrderRow(orderId)).toMatchObject({ status: 'expired', pickupCode: null, paidAt: null });
    expect((await getDropRow((await getOrderRow(orderId)).dropId)).reservedCount).toBe(reservedCount);
    expect((await paymentRow(paymentId)).status).toBe('captured');
    expect(await refundsFor(orderId)).toMatchObject([
      { paymentId, amountPaise: 10000, reason: 'late_payment', chargedTo: 'platform', status: 'pending' },
    ]);
  };

  test('late capture when sold out refunds as late_payment', async () => {
    const { order, payment, drop, gp } = await expiredOrder({ quantity: 1 });
    await reserveDrop({ dropId: drop.id, anonId: 'next', ip: '1.1.1.1' }, later);
    await applyCapture(gp, later);
    await expectLateRefund(order.id, payment.id, 1);
  });

  test('late capture for a deleted user refunds as late_payment and takes no stock', async () => {
    const { user, order, payment, gp } = await expiredOrder();
    await deleteAccount(user.id, later);
    await applyCapture(gp, later);
    await expectLateRefund(order.id, payment.id, 0);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  test('late capture after sales ended refunds as late_payment', async () => {
    const { order, payment, gp } = await expiredOrder({ salesEndAt: later.toISOString() });
    await applyCapture(gp, later);
    await expectLateRefund(order.id, payment.id, 0);
  });

  test('late capture on a stopped drop or outlet refunds as late_payment', async () => {
    const stops = [
      (dropId: string) => db.update(drops).set({ status: 'cancelled' }).where(eq(drops.id, dropId)),
      (dropId: string) => db.update(drops).set({ status: 'paused' }).where(eq(drops.id, dropId)),
    ];
    for (const stop of stops) {
      const { order, payment, drop, gp } = await heldOrder();
      await expireHolds(later);
      await stop(drop.id);
      await applyCapture(gp, later);
      await expectLateRefund(order.id, payment.id, 0);
    }

    const { order, payment, drop, gp } = await heldOrder();
    await expireHolds(later);
    await db.update(outlets).set({ status: 'suspended' }).where(eq(outlets.id, drop.outletId));
    await applyCapture(gp, later);
    await expectLateRefund(order.id, payment.id, 0);
  });

  test('late capture after a newer order at that outlet refunds', async () => {
    const { user, order, payment, drop, gp } = await expiredOrder();
    await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, later);
    await applyCapture(gp, later);
    await expectLateRefund(order.id, payment.id, 1);
  });

  test('a late payment refunded once stays refunded when stock comes back', async () => {
    const { order, payment, drop, gp } = await expiredOrder({ quantity: 1 });
    const next = await reserveDrop({ dropId: drop.id, anonId: 'next', ip: '1.1.1.1' }, later);
    await applyCapture(gp, later);
    await db.update(orders).set({ status: 'expired' }).where(eq(orders.id, next.id));
    await db.update(drops).set({ reservedCount: 0 }).where(eq(drops.id, drop.id));

    await applyCapture(gp, later);
    await expectLateRefund(order.id, payment.id, 0);
  });

  test('two late payments on one Razorpay order are each refunded', async () => {
    const { order, payment, drop, gp } = await expiredOrder({ quantity: 1 });
    await reserveDrop({ dropId: drop.id, anonId: 'next', ip: '1.1.1.1' }, later);
    const second = capturedPayment(gp.orderId);
    await applyCapture(gp, later);
    await applyCapture(second, later);
    const rows = await refundsFor(order.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.paymentId)).size).toBe(2);
    expect(rows.map((r) => r.reason)).toEqual(['late_payment', 'late_payment']);
    expect(rows.some((r) => r.paymentId === payment.id)).toBe(true);
  });

  test('capture on cancelled order refunds', async () => {
    const { order, payment, gp } = await heldOrder();
    await db
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: now.toISOString() })
      .where(eq(orders.id, order.id));
    await applyCapture(gp, now);
    expect((await getOrderRow(order.id)).status).toBe('cancelled');
    expect(await refundsFor(order.id)).toMatchObject([
      { paymentId: payment.id, amountPaise: 10000, reason: 'late_payment', chargedTo: 'platform' },
    ]);
  });

  test('a replayed capture on an order cancelled after paying refunds nothing more', async () => {
    const { order, payment, gp } = await heldOrder();
    await applyCapture(gp, now);
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, order.id));
    await withTx((tx) =>
      createRefund(tx, {
        orderId: order.id,
        paymentId: payment.id,
        amountPaise: 10000,
        reason: 'vendor_cancelled',
        chargedTo: 'vendor',
      }),
    );
    await applyCapture(gp, now);
    expect(await refundsFor(order.id)).toMatchObject([{ reason: 'vendor_cancelled' }]);
  });

  test('applyCapture reports whether it acted', async () => {
    const confirmed = await heldOrder();
    expect(await applyCapture(confirmed.gp, now)).toBe(true);
    expect(await applyCapture(confirmed.gp, now)).toBe(false);
    expect(await applyCapture(capturedPayment(confirmed.gp.orderId), now)).toBe(true);

    const mismatched = await heldOrder();
    expect(await applyCapture({ ...mismatched.gp, amountPaise: 9999 }, now)).toBe(false);
    expect(await applyCapture(capturedPayment('order_nobody'), now)).toBe(false);

    const late = await expiredOrder({ quantity: 1 });
    await reserveDrop({ dropId: late.drop.id, anonId: 'next', ip: '1.1.1.1' }, later);
    expect(await applyCapture(late.gp, later)).toBe(true);
  });

  test('a mismatched payment is audited once, and another payment on the order separately', async () => {
    const { gp } = await heldOrder();
    const wrong = { ...gp, amountPaise: 9999 };
    await applyCapture(wrong, now);
    await applyCapture(wrong, now);
    expect(await auditRows('payment.amount_mismatch')).toHaveLength(1);

    await applyCapture(capturedPayment(gp.orderId, { amountPaise: 1 }), now);
    expect(await auditRows('payment.amount_mismatch')).toHaveLength(2);
  });
});

describe('createRefund', () => {
  test('is a no-op on the same payment and reason', async () => {
    const order = await makePaidOrder();
    const [payment] = await paymentRowsFor(order.id);
    const refund = {
      orderId: order.id,
      paymentId: payment!.id,
      amountPaise: 10000,
      reason: 'issue_resolution',
      chargedTo: 'vendor',
    } as const;
    const admin = await makeUser();
    await withTx((tx) => createRefund(tx, { ...refund, createdBy: admin.id }));
    await withTx((tx) => createRefund(tx, { ...refund, amountPaise: 5 }));
    expect(await refundsFor(order.id)).toMatchObject([{ amountPaise: 10000, createdBy: admin.id, status: 'pending' }]);
  });
});

describe('reconcilePayments', () => {
  test('reconcile confirms a captured payment with no webhook', async () => {
    const { order, gp } = await heldOrder();
    const nearExpiry = seconds(now, HOLD_SECONDS - 120);
    expect(await reconcilePayments(nearExpiry)).toBe(1);
    expect(await getOrderRow(order.id)).toMatchObject({ status: 'paid' });
    expect((await paymentRowsFor(order.id))[0]).toMatchObject({ status: 'captured', razorpayPaymentId: gp.id });
    expect(await reconcilePayments(nearExpiry)).toBe(0);
  });

  test('a hold already past its end is still checked', async () => {
    const { order } = await heldOrder();
    expect(await reconcilePayments(seconds(now, HOLD_SECONDS + 30))).toBe(1);
    expect((await getOrderRow(order.id)).status).toBe('paid');
  });

  test('holds with time left, and uncaptured or missing payments, are left alone', async () => {
    const { order } = await heldOrder();
    expect(await reconcilePayments(seconds(now, HOLD_SECONDS - 121))).toBe(0);
    expect(gateway.listed).toHaveLength(0);
    expect((await getOrderRow(order.id)).status).toBe('held');

    const noPaymentRow = await makeOrder({ holdExpiresAt: now.toISOString() });
    const uncaptured = await makeOrder({ holdExpiresAt: now.toISOString() });
    const row = await makePayment({ orderId: uncaptured.id });
    capturedPayment(row.razorpayOrderId, { status: 'failed' });
    gateway.payments.clear();
    capturedPayment(row.razorpayOrderId, { status: 'failed' });
    expect(await reconcilePayments(now)).toBe(0);
    expect(gateway.listed).toEqual([row.razorpayOrderId]);
    expect((await getOrderRow(uncaptured.id)).status).toBe('held');
    expect((await getOrderRow(noPaymentRow.id)).status).toBe('held');
  });

  test('checks at most 100 orders in a run', async () => {
    const drop = await makeDrop({ quantity: 110, reservedCount: 110 });
    const rows = await db
      .insert(orders)
      .values(
        Array.from({ length: 101 }, (_, i) => ({
          anonId: `a${i}`,
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
    await db.insert(payments).values(
      rows.map((r, i) => ({ orderId: r.id, razorpayOrderId: `order_batch_${i}`, amountPaise: 10000 })),
    );
    await reconcilePayments(now);
    expect(gateway.listed).toHaveLength(100);
  });

  test('one failing order does not stop the rest', async () => {
    const first = await heldOrder();
    const second = await heldOrder();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const list = gateway.listOrderPayments.bind(gateway);
    gateway.listOrderPayments = (id) =>
      id === first.gp.orderId ? Promise.reject(new Error('gateway down')) : list(id);
    expect(await reconcilePayments(seconds(now, HOLD_SECONDS))).toBe(1);
    expect((await getOrderRow(first.order.id)).status).toBe('held');
    expect((await getOrderRow(second.order.id)).status).toBe('paid');
    expect(logged).toHaveBeenCalled();
  });

  test('counts only real changes, so a mismatched payment counts for nothing', async () => {
    const { gp } = await heldOrder();
    gateway.addPayment({ ...gp, amountPaise: 9999 });
    const end = seconds(now, HOLD_SECONDS);
    expect(await reconcilePayments(end)).toBe(0);
    expect(await reconcilePayments(end)).toBe(0);
    expect(await auditRows('payment.amount_mismatch')).toHaveLength(1);
  });

  describe('orders past their hold', () => {
    /** Payment rows take their created_at from the real clock unless a test sets it. */
    const madeAt = (paymentId: string, createdAt: Date) =>
      db.update(payments).set({ createdAt: createdAt.toISOString() }).where(eq(payments.id, paymentId));

    const expiredRows = async (count: number, prefix: string) => {
      const drop = await makeDrop({ quantity: 10 });
      const rows = await db
        .insert(orders)
        .values(
          Array.from({ length: count }, (_, i) => ({
            anonId: `${prefix}${i}`,
            status: 'expired',
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
      await db.insert(payments).values(
        rows.map((r, i) => ({
          orderId: r.id,
          razorpayOrderId: `order_${prefix}_${i}`,
          amountPaise: 10000,
          createdAt: now.toISOString(),
        })),
      );
      return rows.map((_, i) => `order_${prefix}_${i}`);
    };

    test('a captured payment on an expired order with no stock is refunded with no webhook', async () => {
      const { order, payment, drop, gp } = await expiredOrder({ quantity: 1 });
      await madeAt(payment.id, now);
      await reserveDrop({ dropId: drop.id, anonId: 'next', ip: '1.1.1.1' }, later);

      expect(await reconcilePayments(later)).toBe(1);
      expect((await getOrderRow(order.id)).status).toBe('expired');
      expect(await paymentRow(payment.id)).toMatchObject({ status: 'captured', razorpayPaymentId: gp.id });
      expect(await refundsFor(order.id)).toMatchObject([
        { paymentId: payment.id, amountPaise: 10000, reason: 'late_payment', chargedTo: 'platform' },
      ]);
      expect(await reconcilePayments(later)).toBe(0);
      expect(await refundsFor(order.id)).toHaveLength(1);
    });

    test('a captured payment on an expired order with stock left confirms it', async () => {
      const { order, payment, drop } = await expiredOrder();
      await madeAt(payment.id, now);
      expect(await reconcilePayments(later)).toBe(1);
      expect((await getOrderRow(order.id)).status).toBe('paid');
      expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    });

    test('a captured payment on a cancelled order is refunded with no webhook', async () => {
      const { order, payment } = await heldOrder();
      await madeAt(payment.id, now);
      await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, order.id));

      expect(await reconcilePayments(later)).toBe(1);
      expect((await getOrderRow(order.id)).status).toBe('cancelled');
      expect(await refundsFor(order.id)).toMatchObject([{ paymentId: payment.id, reason: 'late_payment' }]);
    });

    test('rows older than 3 days, captured rows and extra-payment rows are not checked', async () => {
      const threeDays = 3 * 24 * 3600;
      const inWindow = await expiredOrder();
      await madeAt(inWindow.payment.id, seconds(later, -threeDays));
      expect(await reconcilePayments(later)).toBe(1);
      gateway.listed.length = 0;

      const tooOld = await expiredOrder();
      await madeAt(tooOld.payment.id, seconds(later, -threeDays - 1));

      const settled = await expiredOrder();
      await db
        .update(payments)
        .set({ status: 'captured', razorpayPaymentId: settled.gp.id, createdAt: now.toISOString() })
        .where(eq(payments.id, settled.payment.id));

      const extra = await makeOrder({ status: 'expired' });
      await makePayment({
        orderId: extra.id,
        razorpayOrderId: 'order_extra:pay_extra',
        status: 'failed',
        createdAt: now.toISOString(),
      });

      expect(await reconcilePayments(later)).toBe(0);
      expect(gateway.listed).toEqual([]);
    });

    test('old rows cannot starve new ones, even when the gateway fails on all of them', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      gateway.listOrderPayments = (id) => {
        gateway.listed.push(id);
        return Promise.reject(new Error('gateway down'));
      };
      const old = await expiredRows(120, 'old');

      await reconcilePayments(later);
      expect(gateway.listed).toHaveLength(100);
      const missed = old.filter((id) => !gateway.listed.includes(id));
      expect(missed).toHaveLength(20);

      gateway.listed.length = 0;
      const [fresh] = await expiredRows(1, 'fresh');
      await reconcilePayments(seconds(later, 60));
      expect(gateway.listed).toHaveLength(100);
      expect(gateway.listed.slice(0, 21).sort()).toEqual([fresh!, ...missed].sort());

      const checked = await db.select().from(payments).where(eq(payments.razorpayOrderId, fresh!));
      expect(new Date(checked[0]!.lastCheckedAt!).getTime()).toBe(seconds(later, 60).getTime());
    });

    test('holds near their end go first, and one run makes at most 100 checks', async () => {
      const swept = await expiredRows(5, 'swept');
      const drop = await makeDrop({ quantity: 110, reservedCount: 110 });
      const held = await db
        .insert(orders)
        .values(
          Array.from({ length: 98 }, (_, i) => ({
            anonId: `h${i}`,
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
      await db
        .insert(payments)
        .values(held.map((r, i) => ({ orderId: r.id, razorpayOrderId: `order_h_${i}`, amountPaise: 10000 })));

      await reconcilePayments(later);
      expect(gateway.listed).toHaveLength(100);
      expect(gateway.listed.filter((id) => id.startsWith('order_h_'))).toHaveLength(98);
      expect(gateway.listed.filter((id) => swept.includes(id))).toHaveLength(2);
    });
  });
});

describe('capture against the other writers', () => {
  test('capture racing expireHolds leaves one state and correct stock', async () => {
    for (let i = 0; i < 25; i++) {
      const { order, gp, drop } = await heldOrderPastExpiry();
      await Promise.all([applyCapture(gp, later), expireHolds(later)]);
      const o = await getOrderRow(order.id);
      expect(o.status).toBe('paid');
      expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    }
  });

  test('a capture meeting the expiry job on one hold does not deadlock', async () => {
    const { order, drop, gp } = await heldOrderPastExpiry();
    const client = await pool.connect();
    try {
      // Stands in for expireHolds: it has the order row, and has yet to touch the drop.
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE SKIP LOCKED', [order.id]);
      const capture = applyCapture(gp, later);
      await someoneWaitsOnLock();

      // A capture that had taken the drop first would hold it here, and the two would deadlock.
      await client.query('UPDATE drops SET reserved_count = reserved_count - 1 WHERE id = $1', [drop.id]);
      await client.query(`UPDATE orders SET status = 'expired' WHERE id = $1`, [order.id]);
      await client.query('COMMIT');
      await capture;
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
  });

  test('a capture waiting for stock leaves a re-reserve free to finish, then refunds', async () => {
    const { user, order, payment, drop, gp } = await expiredOrder();
    const client = await pool.connect();
    try {
      // Stands in for a reserve by the same customer: it has the drop's row, and has yet to insert.
      await client.query('BEGIN');
      await client.query('UPDATE drops SET reserved_count = reserved_count + 1 WHERE id = $1', [drop.id]);
      const capture = applyCapture(gp, later);
      await someoneWaitsOnLock();

      // A capture that had changed the order first would block this insert while waiting on the drop.
      await client.query(
        `INSERT INTO orders (user_id, drop_id, outlet_id, service_date, price_paise, commission_bps,
                             commission_paise, hold_expires_at)
         VALUES ($1, $2, $3, $4, 1, 1, 1, $5)`,
        [user.id, drop.id, drop.outletId, drop.serviceDate, later.toISOString()],
      );
      await client.query('COMMIT');
      await capture;
    } finally {
      client.release();
    }
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getDropRow(drop.id)).reservedCount).toBe(1);
    expect(await refundsFor(order.id)).toMatchObject([{ paymentId: payment.id, reason: 'late_payment' }]);
    const held = await db
      .select()
      .from(orders)
      .where(and(eq(orders.dropId, drop.id), eq(orders.status, 'held')));
    expect(held).toHaveLength(1);
  });

  test('racing late captures on one last bag sell it once and refund the other', async () => {
    for (let i = 0; i < 5; i++) {
      const first = await expiredOrder({ quantity: 1 });
      const { drop } = first;
      const other = await makeOrder({
        dropId: drop.id,
        outletId: drop.outletId,
        serviceDate: drop.serviceDate,
        status: 'expired',
      });
      const row = await makePayment({ orderId: other.id });
      const second = capturedPayment(row.razorpayOrderId);

      await Promise.all([applyCapture(first.gp, later), applyCapture(second, later)]);
      const statuses = [(await getOrderRow(first.order.id)).status, (await getOrderRow(other.id)).status];
      expect(statuses.sort()).toEqual(['expired', 'paid']);
      expect((await getDropRow(drop.id)).reservedCount).toBe(1);
      const refunded = [...(await refundsFor(first.order.id)), ...(await refundsFor(other.id))];
      expect(refunded).toMatchObject([{ reason: 'late_payment' }]);
    }
  });
});

describe('errors', () => {
  test('ApiError carries the code for the envelope', async () => {
    const user = await makeUser();
    const err = await failure(startPayment(user.id, 'not-a-uuid', { allergenAck: true }, now));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
  });

  test('startPayment refuses without the acknowledgement', async () => {
    const { user, order } = await heldOrder();
    expect(await failure(startPayment(user.id, order.id, { allergenAck: false }, now))).toMatchObject({
      code: 'ack_required',
      status: 400,
    });
  });
});

describe('transfer failure events', () => {
  const transferEvent = (type: string, id: string) =>
    JSON.stringify({ event: type, payload: { transfer: { entity: { id } } } });

  async function transferred() {
    const { order, payment, gp } = await heldOrder();
    await applyCapture(gp, now);
    await db.update(payments).set({ razorpayTransferId: 'trf_1', transferStatus: 'on_hold' }).where(eq(payments.id, payment.id));
    return { order, payment };
  }

  test('a known transfer is audited against its payment, once', async () => {
    const { order, payment } = await transferred();
    await deliver(transferEvent('transfer.failed', 'trf_1'));
    await deliver(transferEvent('transfer.failed', 'trf_1'));
    expect(await auditRows('transfer.failed')).toMatchObject([
      {
        actorId: null,
        entity: 'payment',
        entityId: payment.id,
        detail: { razorpayTransferId: 'trf_1', orderId: order.id, transferStatus: 'on_hold' },
      },
    ]);
    expect((await paymentRow(payment.id)).transferStatus).toBe('on_hold');
  });

  test('an unknown transfer is flagged too, not refused', async () => {
    await deliver(transferEvent('transfer.failed', 'trf_unknown'));
    expect(await auditRows('transfer.failed')).toMatchObject([
      { entity: 'payment', detail: { razorpayTransferId: 'trf_unknown', orderId: null } },
    ]);
  });

  test('an event with no transfer in it is unreadable', async () => {
    const res = await failure(deliver(JSON.stringify({ event: 'transfer.failed', payload: {} })));
    expect(res).toMatchObject({ code: 'invalid_event', status: 400 });
  });

  test('other transfer events are recorded and otherwise ignored', async () => {
    await deliver(transferEvent('transfer.processed', 'trf_1'));
    expect(await auditRows('transfer.failed')).toHaveLength(0);
  });
});
