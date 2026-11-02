import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { db, withTx } from '../../src/db/client.js';
import { areas, brands, documents, drops, follows, listings, memberships, notifications, outlets, users } from '../../src/db/schema.js';
import { FakeMessenger, setMessenger, type OutboundMessage } from '../../src/integrations/messaging.js';
import { FakeGateway, setGateway, type GatewayPayment } from '../../src/integrations/payments.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { isoWeekday, serviceDate } from '../../src/lib/time.js';
import { decideOutlet } from '../../src/modules/admin/review.js';
import { publishDrop } from '../../src/modules/catalogue/drops.js';
import { cancelPendingFor, enqueue } from '../../src/modules/notifications/enqueue.js';
import { checkLicences, queueDailyPrompts, queuePickupReminders } from '../../src/modules/notifications/scheduled.js';
import { sendPending } from '../../src/modules/notifications/send.js';
import { renderMessage, TEMPLATES, type TemplateName, type Vars } from '../../src/modules/notifications/templates.js';
import { handleWhatsAppWebhook } from '../../src/modules/notifications/webhook.js';
import { reserveDrop } from '../../src/modules/orders/reserve.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { handleWebhook } from '../../src/modules/payments/webhook.js';
import { cancelDrop, cancelOrder } from '../../src/modules/refunds/cancel.js';
import { processRefunds } from '../../src/modules/refunds/process.js';
import { app } from '../../src/app.js';
import { makeDrop, makeListing, makeLiveOutlet, makeOrder, makePaidOrder, makePayment, makeUser } from '../helpers/factories.js';
import { getOrderRow, resetDb } from '../helpers/db.js';

// 15:30 IST on Monday 2026-11-02. Default drops pick up 19:00-21:00 IST.
const now = new Date('2026-11-02T10:00:00Z');
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const TODAY = '2026-11-02';

/** Fails the sends it is told to, and keeps the order they came in. */
class TestMessenger extends FakeMessenger {
  failChannels = new Set<string>();
  attempts: OutboundMessage[] = [];
  delayMs = 0;

  override async send(m: OutboundMessage): Promise<{ providerId: string }> {
    this.attempts.push(m);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failChannels.has(m.channel)) throw new Error(`${m.channel} is down`);
    return super.send(m);
  }
}

let messenger: TestMessenger;
let gateway: FakeGateway;
let seq = 0;

beforeEach(async () => {
  await resetDb();
  messenger = new TestMessenger();
  setMessenger(messenger);
  gateway = new FakeGateway();
  setGateway(gateway);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const queued = () => db.select().from(notifications).orderBy(asc(notifications.createdAt), asc(notifications.dedupeKey));
const queuedFor = async (template: string) => (await queued()).filter((n) => n.template === template);
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

/** A held order and the gateway payment that will capture it. */
async function heldOrder() {
  const user = await makeUser({ name: 'Priya Rao' });
  const drop = await makeDrop();
  const order = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now);
  const payment = await makePayment({ orderId: order.id });
  return { user, drop, order, payment, gp: capturedPayment(payment.razorpayOrderId) };
}

async function paidOrder() {
  const held = await heldOrder();
  await applyCapture(held.gp, now);
  return held;
}

/** A user on the outlet. Owners are brand-wide, as in onboarding. */
async function staffOf(outletId: string, role: 'owner' | 'manager' | 'counter' = 'owner', o: Partial<typeof users.$inferInsert> = {}) {
  const [outlet] = await db.select({ brandId: outlets.brandId }).from(outlets).where(eq(outlets.id, outletId));
  const user = await makeUser(o);
  await db
    .insert(memberships)
    .values({ userId: user.id, brandId: outlet!.brandId, outletId: role === 'owner' ? null : outletId, role });
  return user;
}

const follow = async (outletId: string, o: Partial<typeof users.$inferInsert> = {}) => {
  const user = await makeUser(o);
  await db.insert(follows).values({ userId: user.id, outletId });
  return user;
};

describe('templates', () => {
  const sample: Record<TemplateName, Vars> = {
    order_confirmed: {
      name: 'Priya',
      item: 'Bakery Surprise Bag',
      vendor: 'Butterfold Bakehouse Indiranagar',
      pickupStartAt: '2026-11-02T15:00:00Z',
      pickupEndAt: '2026-11-02T16:00:00Z',
      code: 'K472',
      link: 'https://www.example.in/o/20481',
    },
    pickup_reminder: {
      name: 'Priya',
      vendor: 'Butterfold Bakehouse Indiranagar',
      address: '12th Main, Indiranagar',
      code: 'K472',
      pickupStartAt: '2026-11-02T15:00:00Z',
      pickupEndAt: '2026-11-02T16:00:00Z',
    },
    vendor_cancelled: { name: 'Priya', vendor: 'Kaapi Corner Koramangala', reason: 'they ran out', amountPaise: 12900 },
    refund_issued: { name: 'Priya', amountPaise: 12900, method: 'upi', ref: 'RF-88213AB1' },
    late_payment_refunded: { name: 'Priya', vendor: 'Kaapi Corner Koramangala', amountPaise: 12900 },
    application_approved: {
      owner: 'Ananya',
      business: 'Butterfold Bakehouse Indiranagar',
      area: 'Indiranagar',
      link: 'https://www.example.in/p',
    },
    changes_needed: {
      owner: 'Ananya',
      business: 'Butterfold Bakehouse Indiranagar',
      reason: 'The FSSAI photo is blurred.',
      link: 'https://www.example.in/p',
    },
    daily_prompt: {
      owner: 'Ananya',
      listings: 'Bakery Surprise Bag (usual 6)\nFour Croissants Box (usual 5)',
      link: 'https://www.example.in/p',
    },
    followed_outlet_listed: {
      name: 'Priya',
      vendor: 'Butterfold Bakehouse Indiranagar',
      pickupStartAt: '2026-11-02T15:00:00Z',
      pickupEndAt: '2026-11-02T16:00:00Z',
      fromPaise: 14900,
      link: 'https://www.example.in/butterfold/indiranagar',
    },
    licence_expiring: {
      owner: 'Ananya',
      business: 'Butterfold Bakehouse Indiranagar',
      days: 30,
      expiresOn: '2026-12-02',
      link: 'https://www.example.in/p',
    },
    outlet_closed: { name: 'Priya', vendor: 'Butterfold Bakehouse Indiranagar' },
  };

  test('every template has a sample, and every SMS is plain and under 160 characters', () => {
    expect(Object.keys(sample).sort()).toEqual(Object.keys(TEMPLATES).sort());
    for (const name of Object.keys(TEMPLATES) as TemplateName[]) {
      const sms = renderMessage(name, 'sms', sample[name]);
      expect(sms.length, `${name}: ${sms}`).toBeLessThan(160);
      // One non-ASCII character would make it a 70-character message.
      expect(sms, name).toMatch(/^[\x20-\x7e]+$/);
      expect(renderMessage(name, 'whatsapp', sample[name]).length, name).toBeGreaterThan(0);
    }
  });

  test('worst-case names, addresses and reasons still fit one SMS, and the fixed parts survive', () => {
    const long = 'Wxyz '.repeat(60);
    for (const name of Object.keys(TEMPLATES) as TemplateName[]) {
      const v: Vars = { ...sample[name]! };
      for (const key of ['name', 'owner', 'vendor', 'business', 'address', 'item', 'reason', 'area']) {
        if (key in v) v[key] = long;
      }
      const sms = renderMessage(name, 'sms', v);
      expect(sms.length, `${name}: ${sms}`).toBeLessThan(160);
      expect(sms, name).toMatch(/^[\x20-\x7e]+$/);
      if ('link' in v) expect(sms, name).toContain(String(v.link));
      if ('code' in v) expect(sms, name).toContain('K472');
      if ('amountPaise' in v) expect(sms, name).toContain('129');
      if ('pickupStartAt' in v && name !== 'pickup_reminder') expect(sms, name).toContain('8:30');
      if (name === 'pickup_reminder') expect(sms).toMatch(/opens 8:30pm.*Code K472\. Collect by 9:30pm/);
    }
  });

  test('copy names the brand from the environment, and times and amounts read plainly', () => {
    const confirmed = renderMessage('order_confirmed', 'sms', sample.order_confirmed!);
    expect(confirmed).toBe(
      `${env().BRAND_NAME}: Order confirmed. Butterfold Bakehouse Indiranagar, today 8:30-9:30pm. Pickup code K472. Show it at the counter. https://www.example.in/o/20481`,
    );
    expect(confirmed).not.toContain('Saanjh');
    expect(renderMessage('vendor_cancelled', 'whatsapp', sample.vendor_cancelled!)).toContain('*₹129*');
    expect(renderMessage('order_confirmed', 'whatsapp', sample.order_confirmed!)).toContain('8:30–9:30 pm');
  });
});

describe('enqueue', () => {
  test('a repeated dedupe key adds nothing', async () => {
    const n = { dedupeKey: 'k1', phone: '+919876500001', template: 'outlet_closed' as const, variables: { name: 'A', vendor: 'B' } };
    await withTx((tx) => enqueue(tx, n));
    await withTx((tx) => enqueue(tx, n));
    expect(await queued()).toHaveLength(1);
  });

  test('it commits and rolls back with the caller transaction', async () => {
    const n = { dedupeKey: 'k2', phone: '+919876500002', template: 'outlet_closed' as const, variables: { name: 'A', vendor: 'B' } };
    await failure(
      withTx(async (tx) => {
        await enqueue(tx, n);
        throw new Error('the state change failed');
      }),
    );
    expect(await queued()).toHaveLength(0);
    expect(messenger.attempts).toHaveLength(0);
  });

  test('it never calls the provider', async () => {
    await paidOrder();
    expect(messenger.attempts).toHaveLength(0);
  });

  test('deleted users get no messages', async () => {
    const gone = await makeUser({ deletedAt: now.toISOString() });
    const vars = { name: 'A', vendor: 'B' };
    await withTx(async (tx) => {
      await enqueue(tx, { dedupeKey: 'd1', phone: 'deleted:abc123', template: 'outlet_closed', variables: vars });
      await enqueue(tx, { dedupeKey: 'd2', phone: gone.phone, template: 'outlet_closed', variables: vars });
    });
    expect(await queued()).toHaveLength(0);
  });

  test('marketing templates respect marketing_opt_in', async () => {
    // No template is marketing yet, so a test-only one stands in for the later offers templates.
    const table = TEMPLATES as Record<string, unknown>;
    table.test_offer = { ...TEMPLATES.outlet_closed, marketing: true };
    try {
      const yes = await makeUser({ marketingOptIn: true });
      const no = await makeUser({ marketingOptIn: false });
      const vars = { name: 'A', vendor: 'B' };
      const offer = 'test_offer' as TemplateName;
      await withTx(async (tx) => {
        await enqueue(tx, { dedupeKey: 'm1', phone: yes.phone, template: offer, variables: vars });
        await enqueue(tx, { dedupeKey: 'm2', phone: no.phone, template: offer, variables: vars });
        await enqueue(tx, { dedupeKey: 'm3', phone: '+919876500009', template: offer, variables: vars });
        // Not marketing, so it goes to someone who has not opted in.
        await enqueue(tx, { dedupeKey: 'm4', phone: no.phone, template: 'outlet_closed', variables: vars });
      });
      expect((await queued()).map((n) => n.dedupeKey).sort()).toEqual(['m1', 'm4']);
    } finally {
      delete table.test_offer;
    }
  });

  test("cancelPendingFor fails that phone's pending rows and no others", async () => {
    const gone = await makeUser();
    const other = await makeUser();
    const vars = { name: 'A', vendor: 'B' };
    await withTx(async (tx) => {
      await enqueue(tx, { dedupeKey: 'c1', phone: gone.phone, template: 'outlet_closed', variables: vars });
      await enqueue(tx, { dedupeKey: 'c2', phone: gone.phone, template: 'outlet_closed', variables: vars });
      await enqueue(tx, { dedupeKey: 'c3', phone: other.phone, template: 'outlet_closed', variables: vars });
    });
    await db.update(notifications).set({ status: 'sent' }).where(eq(notifications.dedupeKey, 'c2'));
    await withTx((tx) => cancelPendingFor(tx, gone.phone));
    const status = Object.fromEntries((await queued()).map((n) => [n.dedupeKey, n.status]));
    expect(status).toEqual({ c1: 'failed', c2: 'sent', c3: 'pending' });
    expect(await sendPending(now)).toBe(1);
    expect(messenger.attempts.map((m) => m.phone)).toEqual([other.phone]);
  });
});

describe('order confirmation and refunds', () => {
  test('paid order queues order_confirmed once', async () => {
    const { order, user, gp } = await paidOrder();
    await applyCapture(gp, now);
    const rows = await queuedFor('order_confirmed');
    expect(rows).toHaveLength(1);
    const code = (await getOrderRow(order.id)).pickupCode!;
    expect(rows[0]).toMatchObject({
      dedupeKey: `confirm:${order.id}`,
      phone: user.phone,
      channel: 'whatsapp',
      status: 'pending',
      variables: { name: 'Priya', code },
    });

    expect(await sendPending(now)).toBe(1);
    expect(messenger.sent[0]).toMatchObject({ phone: user.phone, channel: 'whatsapp', template: 'order_confirmed' });
    expect(messenger.sent[0]!.text).toContain(`*${code}*`);
  });

  test('a customer without an account has no phone, so nothing is queued', async () => {
    const drop = await makeDrop();
    const order = await makeOrder({ dropId: drop.id, userId: null, anonId: 'anon-1', status: 'held' });
    const payment = await makePayment({ orderId: order.id });
    await applyCapture(capturedPayment(payment.razorpayOrderId), now);
    expect(await queued()).toHaveLength(0);
  });

  test('a late payment refund tells the customer, once', async () => {
    const user = await makeUser({ name: 'Priya Rao' });
    const order = await makeOrder({ userId: user.id, status: 'cancelled' });
    const payment = await makePayment({ orderId: order.id });
    const gp = capturedPayment(payment.razorpayOrderId);
    await applyCapture(gp, now);
    await applyCapture(gp, now);
    const rows = await queuedFor('late_payment_refunded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: user.phone, variables: { amountPaise: 10000 } });
  });

  test('a duplicate payment refund sends no message', async () => {
    const paid = await paidOrder();
    const second = await makePayment({ orderId: paid.order.id });
    await applyCapture(capturedPayment(second.razorpayOrderId), now);
    expect(await queuedFor('late_payment_refunded')).toHaveLength(0);
  });

  test('cancelOrder tells the customer, once, with the refund', async () => {
    const { order, drop, user } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    await cancelOrder(owner.id, order.id, 'ran_out', now);
    const rows = await queuedFor('vendor_cancelled');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: `cancel:${order.id}`,
      phone: user.phone,
      variables: { amountPaise: 10000, reason: 'they ran out' },
    });
    expect(await failure(cancelOrder(owner.id, order.id, 'ran_out', now))).toBeInstanceOf(ApiError);
    expect(await queuedFor('vendor_cancelled')).toHaveLength(1);
  });

  test('cancelDrop tells each paid customer, and not the held ones', async () => {
    const { drop, order } = await paidOrder();
    const second = await makeUser();
    const secondOrder = await reserveDrop({ dropId: drop.id, userId: second.id, ip: '1.1.1.1' }, now);
    const secondPayment = await makePayment({ orderId: secondOrder.id });
    await applyCapture(capturedPayment(secondPayment.razorpayOrderId), now);
    const holder = await makeUser();
    const held = await reserveDrop({ dropId: drop.id, userId: holder.id, ip: '1.1.1.1' }, now);

    const owner = await staffOf(drop.outletId);
    await cancelDrop(owner.id, drop.id, 'closing_early', now);
    const keys = (await queuedFor('vendor_cancelled')).map((n) => n.dedupeKey).sort();
    expect(keys).toEqual([`cancel:${order.id}`, `cancel:${secondOrder.id}`].sort());
    expect(keys).not.toContain(`cancel:${held.id}`);
  });

  test('refund_issued is queued when a refund reaches processed, by send or webhook, once', async () => {
    const { order, drop, user } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    await cancelOrder(owner.id, order.id, 'quality', now);

    await processRefunds(now);
    expect(await queuedFor('refund_issued')).toHaveLength(0);
    const sent = gateway.refunds[0]!;
    const raw = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: sent.id } } } });
    await handleWebhook(raw, 'valid', 'evt_a', now);
    await handleWebhook(raw, 'valid', 'evt_b', now);
    const rows = await queuedFor('refund_issued');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: user.phone, variables: { amountPaise: 10000, method: 'upi' } });
  });

  test('refund_issued is queued when the gateway answers processed at once', async () => {
    const { order, drop } = await paidOrder();
    const owner = await staffOf(drop.outletId);
    await cancelOrder(owner.id, order.id, 'quality', now);
    gateway.refundStatus = 'processed';
    await processRefunds(now);
    expect(await queuedFor('refund_issued')).toHaveLength(1);
  });
});

describe('sendPending', () => {
  const pending = async (n: number, o: Partial<typeof notifications.$inferInsert> = {}) => {
    const rows = Array.from({ length: n }, (_, i) => ({
      dedupeKey: `bulk:${++seq}`,
      phone: `+9199000${String(i).padStart(5, '0')}`,
      template: 'outlet_closed',
      variables: { name: 'A', vendor: 'B' },
      channel: 'whatsapp',
      ...o,
    }));
    await db.insert(notifications).values(rows);
    return rows;
  };

  test('WhatsApp failure falls back to SMS', async () => {
    const user = await makeUser();
    await pending(1, { phone: user.phone });
    messenger.failChannels.add('whatsapp');

    expect(await sendPending(now)).toBe(0);
    expect((await queued())[0]).toMatchObject({ channel: 'sms', status: 'pending', attempts: 1, sendingAt: null });

    expect(await sendPending(now)).toBe(1);
    expect(messenger.attempts.map((m) => m.channel)).toEqual(['whatsapp', 'sms']);
    expect(messenger.sent[0]!.text).toMatch(/^[\x20-\x7e]+$/);
    expect((await queued())[0]).toMatchObject({ channel: 'sms', status: 'sent', attempts: 2, providerId: 'fake_1' });
  });

  test('opted-out customer gets SMS, not WhatsApp', async () => {
    const user = await makeUser({ whatsappOptIn: false });
    await pending(1, { phone: user.phone });
    expect(await sendPending(now)).toBe(1);
    expect(messenger.attempts.map((m) => m.channel)).toEqual(['sms']);
    expect((await queued())[0]).toMatchObject({ channel: 'sms', status: 'sent' });
  });

  test('vendors have no WhatsApp opt-out', async () => {
    const vendor = await makeUser({ whatsappOptIn: false });
    await pending(1, {
      phone: vendor.phone,
      template: 'daily_prompt',
      variables: { owner: 'A', listings: 'Bag (usual 5)', link: 'x' },
    });
    await sendPending(now);
    expect(messenger.attempts.map((m) => m.channel)).toEqual(['whatsapp']);
  });

  test('three failures mark failed and stop', async () => {
    const user = await makeUser();
    await pending(1, { phone: user.phone });
    messenger.failChannels.add('whatsapp').add('sms');
    for (let i = 0; i < 5; i++) await sendPending(now);
    expect(messenger.attempts.map((m) => m.channel)).toEqual(['whatsapp', 'sms', 'sms']);
    expect((await queued())[0]).toMatchObject({ status: 'failed', attempts: 3, sendingAt: null });
  });

  test('a run takes at most 100 messages', async () => {
    await pending(130);
    expect(await sendPending(now)).toBe(100);
    expect(await sendPending(now)).toBe(30);
    expect(await sendPending(now)).toBe(0);
  });

  test('two runs at once never send the same message', async () => {
    await pending(150);
    messenger.delayMs = 5;
    const [a, b] = await Promise.all([sendPending(now), sendPending(now)]);
    expect(a + b).toBe(150);
    expect(messenger.attempts).toHaveLength(150);
    expect(new Set(messenger.attempts.map((m) => m.phone)).size).toBe(150);
    expect((await queued()).every((n) => n.status === 'sent')).toBe(true);
  });

  test('a row another run claimed a moment ago is left alone, and one claimed long ago goes again', async () => {
    await pending(2);
    const [fresh, stale] = await queued();
    await db.update(notifications).set({ sendingAt: minutes(now, -1).toISOString() }).where(eq(notifications.id, fresh!.id));
    await db.update(notifications).set({ sendingAt: minutes(now, -6).toISOString() }).where(eq(notifications.id, stale!.id));
    expect(await sendPending(now)).toBe(1);
    expect(messenger.attempts.map((m) => m.phone)).toEqual([stale!.phone]);
  });
});

describe('queuePickupReminders', () => {
  // The default drop opens at 19:00 IST, which is 13:30 UTC.
  const opens = new Date('2026-11-02T13:30:00Z');

  test('reminder fires 30 minutes before pickup, once', async () => {
    const order = await makePaidOrder();
    expect(await queuePickupReminders(minutes(opens, -31))).toBe(0);
    expect(await queuePickupReminders(minutes(opens, -30))).toBe(1);
    expect(await queuePickupReminders(minutes(opens, -29))).toBe(0);
    const rows = await queuedFor('pickup_reminder');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupeKey: `reminder:${order.id}`, variables: { code: order.pickupCode } });
  });

  test('nothing for a pickup that has started, or an order that is not paid', async () => {
    const drop = await makeDrop();
    await makePaidOrder({ dropId: drop.id });
    await makeOrder({ dropId: drop.id, status: 'cancelled' });
    await makeOrder({ dropId: drop.id, status: 'held' });
    expect(await queuePickupReminders(minutes(opens, 1))).toBe(0);
    expect(await queuePickupReminders(minutes(opens, -10))).toBe(1);
  });
});

describe('followers', () => {
  async function outletWithListings() {
    const outlet = await makeLiveOutlet();
    const a = await makeListing({ outletId: outlet.id });
    const b = await makeListing({ outletId: outlet.id });
    return { outlet, a, b };
  }

  test('first drop alerts followers once a night per outlet', async () => {
    const { outlet, a } = await outletWithListings();
    // The default customer has marketing_opt_in false, and still gets the alert they asked for.
    const fan = await follow(outlet.id);
    const other = await follow(outlet.id, { marketingOptIn: true });

    await publishDrop(null, a.id, 5, now);
    const rows = await queuedFor('followed_outlet_listed');
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [`follow:${fan.id}:${outlet.id}:${TODAY}`, `follow:${other.id}:${outlet.id}:${TODAY}`].sort(),
    );
    expect(rows[0]).toMatchObject({ variables: { fromPaise: 10000 } });
    const [place] = await db
      .select({ city: areas.city, brand: brands.slug, outlet: outlets.slug })
      .from(outlets)
      .innerJoin(areas, eq(areas.id, outlets.areaId))
      .innerJoin(brands, eq(brands.id, outlets.brandId))
      .where(eq(outlets.id, outlet.id));
    const link = `${env().FRONTEND_ORIGIN.replace(/\/$/, '')}/${place!.city}/${place!.brand}/${place!.outlet}`;
    expect(rows[0]).toMatchObject({ variables: { link } });

    // The same listing again changes only its quantity.
    await publishDrop(null, a.id, 8, now);
    expect(await queuedFor('followed_outlet_listed')).toHaveLength(2);

    // Tomorrow is a new night.
    await publishDrop(null, a.id, 5, minutes(now, 24 * 60));
    expect(await queuedFor('followed_outlet_listed')).toHaveLength(4);
  });

  test('a second drop that night sends no alert', async () => {
    const { outlet, a, b } = await outletWithListings();
    await follow(outlet.id);
    await publishDrop(null, a.id, 5, now);
    await publishDrop(null, b.id, 5, now);
    expect(await queuedFor('followed_outlet_listed')).toHaveLength(1);
  });

  test('two first drops at once still alert each follower once', async () => {
    const { outlet, a, b } = await outletWithListings();
    await follow(outlet.id);
    await Promise.all([publishDrop(null, a.id, 5, now), publishDrop(null, b.id, 5, now)]);
    expect(await queuedFor('followed_outlet_listed')).toHaveLength(1);
  });

  test('a drop that does not commit alerts no one', async () => {
    const outlet = await makeLiveOutlet({ status: 'suspended' });
    const listing = await makeListing({ outletId: outlet.id });
    await follow(outlet.id);
    expect(await failure(publishDrop(null, listing.id, 5, now))).toBeInstanceOf(ApiError);
    expect(await queued()).toHaveLength(0);
  });

  test('closing an outlet tells followers once', async () => {
    const outlet = await makeLiveOutlet();
    const fan = await follow(outlet.id);
    const admin = await makeUser({ isAdmin: true });
    await decideOutlet(admin.id, outlet.id, { decision: 'close' }, now);
    const rows = await queuedFor('outlet_closed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupeKey: `closed:${fan.id}:${outlet.id}`, phone: fan.phone });
    expect(await failure(decideOutlet(admin.id, outlet.id, { decision: 'close' }, now))).toBeInstanceOf(ApiError);
    expect(await queuedFor('outlet_closed')).toHaveLength(1);
  });
});

describe('admin review', () => {
  test('approving tells the owners the outlet is live', async () => {
    const outlet = await makeLiveOutlet({ status: 'in_review' });
    const owner = await staffOf(outlet.id, 'owner', { name: 'Ananya Rao' });
    await staffOf(outlet.id, 'manager');
    await db.insert(documents).values([
      { outletId: outlet.id, kind: 'fssai', fileKey: 'f', status: 'approved' },
      { payoutAccountId: outlet.payoutAccountId, kind: 'pan', fileKey: 'p', status: 'approved' },
      { payoutAccountId: outlet.payoutAccountId, kind: 'bank_proof', fileKey: 'b', status: 'approved' },
    ]);
    const admin = await makeUser({ isAdmin: true });
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, now);
    const rows = await queuedFor('application_approved');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: owner.phone, channel: 'whatsapp', variables: { owner: 'Ananya' } });
  });

  test('sending an application back tells the owners why', async () => {
    const outlet = await makeLiveOutlet({ status: 'in_review' });
    const owner = await staffOf(outlet.id);
    const admin = await makeUser({ isAdmin: true });
    await decideOutlet(admin.id, outlet.id, { decision: 'request_changes', reason: 'Photo is blurred' }, now);
    const rows = await queuedFor('changes_needed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: owner.phone, variables: { reason: 'Photo is blurred' } });
  });
});

describe('queueDailyPrompts', () => {
  // 17:00 IST is 11:30 UTC.
  const five = new Date('2026-11-02T11:30:00Z');
  const todayDay = isoWeekday(serviceDate(five));

  async function repeatingOutlet(o: Partial<typeof outlets.$inferInsert> = {}) {
    const outlet = await makeLiveOutlet(o);
    const listing = await makeListing({ outletId: outlet.id, repeatDays: [todayDay], defaultQuantity: 6 });
    return { outlet, listing };
  }

  test('daily prompt goes out at 5:00 pm IST to outlets repeating today', async () => {
    const { outlet } = await repeatingOutlet();
    const owner = await staffOf(outlet.id, 'owner');
    const manager = await staffOf(outlet.id, 'manager');
    await staffOf(outlet.id, 'counter');

    expect(await queueDailyPrompts(minutes(five, -1))).toBe(0);
    expect(await queueDailyPrompts(five)).toBe(2);
    expect(await queueDailyPrompts(minutes(five, 14))).toBe(0);
    expect(await queueDailyPrompts(minutes(five, 15))).toBe(0);

    const rows = await queuedFor('daily_prompt');
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [`prompt:${outlet.id}:${owner.phone}:${TODAY}`, `prompt:${outlet.id}:${manager.phone}:${TODAY}`].sort(),
    );
    expect(rows[0]!.variables).toMatchObject({ samePayload: `same_as_usual:${outlet.id}:${TODAY}` });
  });

  test('not for paused outlets, other repeat days, archived listings or outlets that are not live', async () => {
    const paused = await repeatingOutlet({ pausedUntil: minutes(five, 60).toISOString() });
    await staffOf(paused.outlet.id);
    const other = await makeLiveOutlet();
    await makeListing({ outletId: other.id, repeatDays: [todayDay % 7 + 1] });
    await staffOf(other.id);
    const archived = await repeatingOutlet();
    await db.update(listings).set({ archivedAt: now.toISOString() }).where(eq(listings.id, archived.listing.id));
    await staffOf(archived.outlet.id);
    const suspended = await repeatingOutlet({ status: 'suspended' });
    await staffOf(suspended.outlet.id);

    expect(await queueDailyPrompts(five)).toBe(0);
  });

  test('a pause that has ended does not count', async () => {
    const { outlet } = await repeatingOutlet({ pausedUntil: minutes(five, -60).toISOString() });
    await staffOf(outlet.id);
    expect(await queueDailyPrompts(five)).toBe(1);
  });
});

describe('handleWhatsAppWebhook', () => {
  const todayDay = isoWeekday(TODAY);
  const reply = (phone: string, payload: string) => JSON.stringify({ type: 'reply', phone, payload });
  const handle = (raw: string, signature = 'valid') => handleWhatsAppWebhook(raw, signature, now);

  async function setup() {
    const outlet = await makeLiveOutlet();
    const usual = await makeListing({ outletId: outlet.id, repeatDays: [todayDay], defaultQuantity: 7 });
    const notToday = await makeListing({ outletId: outlet.id, repeatDays: [todayDay % 7 + 1], defaultQuantity: 3 });
    const owner = await staffOf(outlet.id, 'owner');
    return { outlet, usual, notToday, owner, payload: `same_as_usual:${outlet.id}:${TODAY}` };
  }
  const dropsFor = (outletId: string) => db.select().from(drops).where(eq(drops.outletId, outletId));

  test('Same as usual reply publishes drops at default_quantity', async () => {
    const { outlet, usual, owner, payload } = await setup();
    await handle(reply(owner.phone, payload));
    const rows = await dropsFor(outlet.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ listingId: usual.id, quantity: 7, serviceDate: TODAY, status: 'live' });
  });

  test('a manager can reply, a phone without the 91 prefix is read, and a second tap changes nothing', async () => {
    const { outlet, usual, payload } = await setup();
    const manager = await staffOf(outlet.id, 'manager');
    await handle(reply(manager.phone.replace('+', ''), payload));
    await db.update(drops).set({ quantity: 2 }).where(eq(drops.listingId, usual.id));
    await handle(reply(manager.phone, payload));
    expect((await dropsFor(outlet.id)).map((d) => d.quantity)).toEqual([2]);
  });

  test('no reply publishes nothing', async () => {
    const { outlet } = await setup();
    await queueDailyPrompts(new Date('2026-11-02T11:30:00Z'));
    await sendPending(now);
    expect(await dropsFor(outlet.id)).toHaveLength(0);
  });

  test('replies from people who may not publish, or for another day, publish nothing', async () => {
    const { outlet, owner, payload } = await setup();
    const counter = await staffOf(outlet.id, 'counter');
    const stranger = await makeUser();
    const removed = await staffOf(outlet.id, 'manager');
    await db.update(memberships).set({ removedAt: now.toISOString() }).where(eq(memberships.userId, removed.id));
    const elsewhere = await staffOf((await makeLiveOutlet()).id, 'owner');

    for (const who of [counter, stranger, removed, elsewhere]) await handle(reply(who.phone, payload));
    await handle(reply('+919000099999', payload));
    await handle(reply(owner.phone, `same_as_usual:${outlet.id}:2026-11-01`));
    await handle(reply(owner.phone, `same_as_usual:${outlet.id}:2026-11-03`));
    await handle(reply(owner.phone, 'same_as_usual:not-an-id:2026-11-02'));
    await handle(reply(owner.phone, 'something_else'));
    expect(await dropsFor(outlet.id)).toHaveLength(0);
  });

  test('an outlet that cannot sell publishes nothing, and the reply does not fail', async () => {
    const { outlet, owner, payload } = await setup();
    await db.update(outlets).set({ fssaiExpiresOn: '2026-11-01' }).where(eq(outlets.id, outlet.id));
    await handle(reply(owner.phone, payload));
    expect(await dropsFor(outlet.id)).toHaveLength(0);
  });

  test('a failed WhatsApp delivery goes out again as SMS', async () => {
    const user = await makeUser();
    await db.insert(notifications).values({
      dedupeKey: 'st1',
      phone: user.phone,
      template: 'outlet_closed',
      variables: { name: 'A', vendor: 'B' },
      channel: 'whatsapp',
    });
    await sendPending(now);
    const providerId = (await queued())[0]!.providerId!;
    await handle(JSON.stringify({ type: 'status', providerId, status: 'delivered' }));
    expect((await queued())[0]).toMatchObject({ status: 'sent', channel: 'whatsapp' });
    await handle(JSON.stringify({ type: 'status', providerId, status: 'failed' }));
    expect((await queued())[0]).toMatchObject({ status: 'pending', channel: 'sms', providerId: null });
    await sendPending(now);
    expect(messenger.attempts.map((m) => m.channel)).toEqual(['whatsapp', 'sms']);
  });

  test('a failed delivery on a deleted account is not sent again', async () => {
    const message = { template: 'otp', variables: {}, channel: 'whatsapp', status: 'sent', providerId: 'p1' };
    await db.insert(notifications).values({ dedupeKey: 'gone', phone: 'deleted:someone', ...message });
    await handle(JSON.stringify({ type: 'status', providerId: 'p1', status: 'failed' }));
    expect((await db.select().from(notifications))[0]).toMatchObject({ status: 'sent', channel: 'whatsapp' });
  });

  test('a bad signature is refused, and unreadable or unknown events are handled', async () => {
    const { owner, payload } = await setup();
    expect((await failure(handle(reply(owner.phone, payload), 'forged')))?.status).toBe(401);
    expect((await failure(handle('not json')))?.status).toBe(400);
    expect((await failure(handle(JSON.stringify({ type: 'reply', phone: '' }))))?.status).toBe(400);
    await handle(JSON.stringify({ type: 'read_receipt' }));
  });

  test('POST /webhooks/whatsapp checks the signature header and answers 200', async () => {
    const { outlet, owner } = await setup();
    // The route reads the real clock, so a reply for a day long past publishes nothing.
    const payload = `same_as_usual:${outlet.id}:2000-01-01`;
    const post = (signature: string) =>
      app.request('/api/v1/webhooks/whatsapp', {
        method: 'POST',
        headers: { 'x-webhook-signature': signature },
        body: reply(owner.phone, payload),
      });
    expect((await post('forged')).status).toBe(401);
    expect(await dropsFor(outlet.id)).toHaveLength(0);
    expect((await post('valid')).status).toBe(200);
  });
});

describe('checkLicences', () => {
  test('licence warnings fire at 30 and 7 days, once each', async () => {
    const outlet = await makeLiveOutlet({ fssaiExpiresOn: '2026-12-02' });
    const owner = await staffOf(outlet.id, 'owner');
    await staffOf(outlet.id, 'manager');

    expect(await checkLicences(now)).toBe(1);
    expect(await checkLicences(now)).toBe(0);
    expect(await checkLicences(minutes(now, 24 * 60))).toBe(0);
    // 7 days before 2026-12-02 is 2026-11-25.
    const week = new Date('2026-11-25T10:00:00Z');
    expect(await checkLicences(minutes(week, -24 * 60))).toBe(0);
    expect(await checkLicences(week)).toBe(1);
    expect(await checkLicences(week)).toBe(0);

    const rows = await queuedFor('licence_expiring');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.phone)).toEqual([owner.phone, owner.phone]);
    expect(rows.map((r) => (r.variables as { days: number }).days).sort()).toEqual([30, 7]);
  });

  test('the day is the IST day, and outlets that are not live or have no licence date are left out', async () => {
    const late = await makeLiveOutlet({ fssaiExpiresOn: '2026-12-03' });
    await staffOf(late.id);
    const closed = await makeLiveOutlet({ fssaiExpiresOn: '2026-12-03', status: 'closed' });
    await staffOf(closed.id);
    const none = await makeLiveOutlet();
    await staffOf(none.id);
    // 23:30 UTC on 1 Nov is already 2 Nov in IST, so 3 Dec is 31 days out.
    expect(await checkLicences(new Date('2026-11-01T23:30:00Z'))).toBe(0);
    // 18:30 UTC on 2 Nov is 3 Nov in IST, so 3 Dec is 30 days out.
    expect(await checkLicences(new Date('2026-11-02T18:30:00Z'))).toBe(1);
  });

  test('a renewed licence is warned about again at its next 30 days', async () => {
    const outlet = await makeLiveOutlet({ fssaiExpiresOn: '2026-12-02' });
    await staffOf(outlet.id);
    await checkLicences(now);
    await db.update(outlets).set({ fssaiExpiresOn: '2027-12-02' }).where(eq(outlets.id, outlet.id));
    expect(await checkLicences(new Date('2027-11-02T10:00:00Z'))).toBe(1);
  });
});
