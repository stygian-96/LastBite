import { beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { drops, memberships, notifications, orderItems, orders, outlets } from '../../src/db/schema.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { listInventory } from '../../src/modules/admin/vendors.js';
import { getProfile } from '../../src/modules/customer/profile.js';
import { expireHolds } from '../../src/modules/orders/expire.js';
import { changeItemQuantity, releaseHold, reserveDrop } from '../../src/modules/orders/reserve.js';
import { getOrder } from '../../src/modules/orders/views.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { listOutletOrders } from '../../src/modules/pickup/list.js';
import { cancelDrop, cancelOrder } from '../../src/modules/refunds/cancel.js';
import { makeDrop, makeListing, makeLiveOutlet, makePayment, makeUser } from '../helpers/factories.js';
import { getDropRow, getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-02. Default drops stop selling at 20:45 IST.
const now = new Date('2026-11-02T10:00:00Z');
const later = new Date(now.getTime() + 6 * 60_000 + 1000);

beforeEach(async () => {
  await resetDb();
  setGateway(new FakeGateway());
});

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code: string; status: number; details?: Record<string, unknown> },
  );

/** One outlet selling a ₹100 bread bag (19:00–21:00) and a ₹150 cake box (20:00–22:00), 10 of each. */
async function outletWithTwo() {
  const outlet = await makeLiveOutlet({ commissionBps: 2000 });
  const bread = await makeDrop({ outletId: outlet.id, listingId: (await makeListing({ outletId: outlet.id, maxPerOrder: 3 })).id, name: 'Bread bag', quantity: 10, pricePaise: 10000, valuePaise: 30000 });
  const cake = await makeDrop({
    outletId: outlet.id,
    listingId: (await makeListing({ outletId: outlet.id, maxPerOrder: 3 })).id,
    name: 'Cake box',
    quantity: 10,
    pricePaise: 15000,
    valuePaise: 40000,
    pickupStartAt: '2026-11-02T20:00:00+05:30',
    pickupEndAt: '2026-11-02T22:00:00+05:30',
  });
  return { outlet, bread, cake };
}

/** A customer holding 2 bread bags and 1 cake box in one order. */
async function basket() {
  const shop = await outletWithTwo();
  const user = await makeUser();
  const order = await reserveDrop({ dropId: shop.bread.id, userId: user.id, ip: '1.1.1.1', quantity: 2 }, now);
  await reserveDrop({ dropId: shop.cake.id, userId: user.id, ip: '1.1.1.1', quantity: 1 }, now);
  return { ...shop, user, orderId: order.id };
}

async function pay(orderId: string, amountPaise: number, at = now) {
  const payment = await makePayment({ orderId, amountPaise });
  await applyCapture({ id: `pay_${orderId.slice(0, 8)}`, orderId: payment.razorpayOrderId, status: 'captured', amountPaise, feePaise: 0, method: 'upi' }, at);
  return payment;
}

async function ownerAt(outletId: string) {
  const [o] = await db.select().from(outlets).where(eq(outlets.id, outletId));
  const owner = await makeUser();
  await db.insert(memberships).values({ userId: owner.id, brandId: o!.brandId, role: 'owner' });
  return owner;
}

const lines = (orderId: string) => db.select().from(orderItems).where(eq(orderItems.orderId, orderId));

describe('building one order from several bags', () => {
  test('a second bag from the same outlet joins the hold: one order, its total, and its whole pickup window', async () => {
    const { bread, cake, orderId } = await basket();
    const order = await getOrderRow(orderId);
    expect(order).toMatchObject({ quantity: 3, pricePaise: 35000, commissionPaise: 7000 });
    expect(new Date(order.pickupStartAt).toISOString()).toBe('2026-11-02T13:30:00.000Z');
    expect(new Date(order.pickupEndAt).toISOString()).toBe('2026-11-02T16:30:00.000Z');
    expect((await lines(orderId)).map((l) => [l.dropId, l.quantity])).toEqual(expect.arrayContaining([[bread.id, 2], [cake.id, 1]]));
    expect((await getDropRow(bread.id)).reservedCount).toBe(2);
    expect((await getDropRow(cake.id)).reservedCount).toBe(1);
  });

  test('more of a bag already in it grows that line, within the listing limit', async () => {
    const { bread, user, orderId } = await basket();
    await reserveDrop({ dropId: bread.id, userId: user.id, ip: '1.1.1.1', quantity: 1 }, now);
    expect((await lines(orderId)).find((l) => l.dropId === bread.id)!.quantity).toBe(3);
    expect(await failure(reserveDrop({ dropId: bread.id, userId: user.id, ip: '1.1.1.1', quantity: 1 }, now))).toMatchObject({
      code: 'over_limit',
      details: { existingOrderId: orderId },
    });
  });

  test('an order has no bag cap of its own, only each bag’s limit', async () => {
    const outlet = await makeLiveOutlet();
    const user = await makeUser();
    const drop = (n: number) => makeListing({ outletId: outlet.id, maxPerOrder: 10 }).then((l) => makeDrop({ outletId: outlet.id, listingId: l.id, quantity: n }));
    const [a, b] = [await drop(20), await drop(20)];
    const order = await reserveDrop({ dropId: a.id, userId: user.id, ip: '1.1.1.1', quantity: 8 }, now);
    await reserveDrop({ dropId: b.id, userId: user.id, ip: '1.1.1.1', quantity: 10 }, now);
    expect((await getOrderRow(order.id)).quantity).toBe(18);
  });

  test('a bag from another outlet starts its own order', async () => {
    const { user, orderId } = await basket();
    const elsewhere = await makeDrop();
    const other = await reserveDrop({ dropId: elsewhere.id, userId: user.id, ip: '1.1.1.1' }, now);
    expect(other.id).not.toBe(orderId);
  });

  test('after paying, the customer starts a new order there, and the bag limit counts both', async () => {
    const { bread, user, orderId } = await basket();
    await pay(orderId, 35000);
    const next = await reserveDrop({ dropId: bread.id, userId: user.id, ip: '1.1.1.1' }, now);
    expect(next.id).not.toBe(orderId);
    expect(await failure(changeItemQuantity({ userId: user.id }, next.id, bread.id, 2, now))).toMatchObject({
      code: 'over_limit',
      details: { maxPerOrder: 3, alreadyHave: 2 },
    });
    expect((await getDropRow(bread.id)).reservedCount).toBe(3);
  });
});

describe('changing lines at checkout', () => {
  test('one line changes on its own; taking one out returns its stock and the total follows', async () => {
    const { bread, cake, user, orderId } = await basket();
    await changeItemQuantity({ userId: user.id }, orderId, cake.id, 3, now);
    expect(await getOrderRow(orderId)).toMatchObject({ quantity: 5, pricePaise: 65000 });
    await changeItemQuantity({ userId: user.id }, orderId, bread.id, 0, now);
    const order = await getOrderRow(orderId);
    expect(order).toMatchObject({ quantity: 3, pricePaise: 45000, commissionPaise: 9000, dropId: cake.id });
    expect(new Date(order.pickupStartAt).toISOString()).toBe('2026-11-02T14:30:00.000Z');
    expect((await getDropRow(bread.id)).reservedCount).toBe(0);
    expect(await failure(changeItemQuantity({ userId: user.id }, orderId, cake.id, 0, now))).toMatchObject({ code: 'last_item' });
  });

  test('locked once payment starts, and only for its owner', async () => {
    const { cake, user, orderId } = await basket();
    const stranger = await makeUser();
    expect(await failure(changeItemQuantity({ userId: stranger.id }, orderId, cake.id, 2, now))).toMatchObject({ status: 404 });
    await makePayment({ orderId });
    expect(await failure(changeItemQuantity({ userId: user.id }, orderId, cake.id, 2, now))).toMatchObject({ code: 'payment_started' });
  });
});

describe('every line’s stock comes back', () => {
  test('when the customer gives the hold back', async () => {
    const { bread, cake, user, orderId } = await basket();
    await releaseHold({ userId: user.id }, orderId, now);
    expect((await getDropRow(bread.id)).reservedCount).toBe(0);
    expect((await getDropRow(cake.id)).reservedCount).toBe(0);
  });

  test('when the hold expires', async () => {
    const { bread, cake } = await basket();
    await expireHolds(later);
    expect((await getDropRow(bread.id)).reservedCount).toBe(0);
    expect((await getDropRow(cake.id)).reservedCount).toBe(0);
  });

  test('when the vendor cancels the whole order, which refunds all of it', async () => {
    const { bread, cake, outlet, orderId } = await basket();
    await pay(orderId, 35000);
    await cancelOrder((await ownerAt(outlet.id)).id, orderId, 'ran_out', now);
    expect((await getDropRow(bread.id)).reservedCount).toBe(0);
    expect((await getDropRow(cake.id)).reservedCount).toBe(0);
    expect(await refundsFor(orderId)).toMatchObject([{ amountPaise: 35000, reason: 'vendor_cancelled' }]);
  });
});

describe('a payment that lands after the hold expired', () => {
  test('takes every line again if all are there', async () => {
    const { bread, cake, orderId } = await basket();
    const payment = await makePayment({ orderId, amountPaise: 35000 });
    await expireHolds(later);
    await applyCapture({ id: 'pay_late', orderId: payment.razorpayOrderId, status: 'captured', amountPaise: 35000, feePaise: 0, method: 'upi' }, later);
    expect((await getOrderRow(orderId)).status).toBe('paid');
    expect((await getDropRow(bread.id)).reservedCount).toBe(2);
    expect((await getDropRow(cake.id)).reservedCount).toBe(1);
  });

  test('takes none and is refunded if one line is gone', async () => {
    const { bread, cake, orderId } = await basket();
    const payment = await makePayment({ orderId, amountPaise: 35000 });
    await expireHolds(later);
    // Someone else bought every cake box meanwhile.
    await db.update(drops).set({ reservedCount: 10 }).where(eq(drops.id, cake.id));
    await applyCapture({ id: 'pay_late2', orderId: payment.razorpayOrderId, status: 'captured', amountPaise: 35000, feePaise: 0, method: 'upi' }, later);
    expect((await getOrderRow(orderId)).status).toBe('expired');
    expect((await getDropRow(bread.id)).reservedCount).toBe(0);
    expect((await getDropRow(cake.id)).reservedCount).toBe(10);
    expect(await refundsFor(orderId)).toMatchObject([{ amountPaise: 35000, reason: 'late_payment' }]);
  });
});

describe('the vendor cancelling one kind of bag', () => {
  test('a paid order keeps the rest: that line is refunded alone and the customer told', async () => {
    const { bread, cake, outlet, orderId } = await basket();
    await pay(orderId, 35000);
    const owner = await ownerAt(outlet.id);
    await cancelDrop(owner.id, cake.id, 'ran_out', now);

    const order = await getOrderRow(orderId);
    expect(order).toMatchObject({ status: 'paid', quantity: 2, pricePaise: 35000 });
    expect((await lines(orderId)).find((l) => l.dropId === cake.id)).toMatchObject({ status: 'cancelled' });
    expect((await getDropRow(cake.id)).reservedCount).toBe(0);
    expect((await getDropRow(bread.id)).reservedCount).toBe(2);
    expect(await refundsFor(orderId)).toMatchObject([{ amountPaise: 15000, reason: 'item_cancelled', chargedTo: 'vendor' }]);
    const [msg] = await db.select().from(notifications).where(eq(notifications.template, 'item_cancelled'));
    expect(msg!.variables).toMatchObject({ item: 'Cake box', amountPaise: 15000 });

    // Cancelling the last line left cancels the order, refunding what is still unrefunded.
    await cancelDrop(owner.id, bread.id, 'closing_early', now);
    expect((await getOrderRow(orderId)).status).toBe('cancelled');
    const refunds = await refundsFor(orderId);
    expect(refunds.map((r) => [r.reason, r.amountPaise]).sort()).toEqual([
      ['item_cancelled', 15000],
      ['vendor_cancelled', 20000],
    ]);
  });

  test('a hold just loses that line and its price', async () => {
    const { bread, cake, outlet, orderId } = await basket();
    await cancelDrop((await ownerAt(outlet.id)).id, bread.id, 'ran_out', now);
    expect(await getOrderRow(orderId)).toMatchObject({ status: 'held', quantity: 1, pricePaise: 15000, dropId: cake.id });
    expect(await lines(orderId)).toHaveLength(1);
    expect((await getDropRow(bread.id)).reservedCount).toBe(0);
  });
});

describe('what everyone sees', () => {
  test('the customer’s order lists every bag, its whole value and every allergen', async () => {
    const { user, orderId } = await basket();
    const view = await getOrder({ userId: user.id }, orderId);
    expect(view.items.map((l) => [l.name, l.quantity, l.status])).toEqual([
      ['Bread bag', 2, 'active'],
      ['Cake box', 1, 'active'],
    ]);
    expect(view).toMatchObject({ quantity: 3, pricePaise: 35000, totalValuePaise: 100000 });
    expect(view.items.find((l) => l.name === 'Cake box')).toMatchObject({ maxQuantity: 3 });
  });

  test('staff see every bag to hand over, the confirmation names them, admin counts each drop, and the profile adds up every bag', async () => {
    const { bread, cake, user, outlet, orderId } = await basket();
    await pay(orderId, 35000);
    const owner = await ownerAt(outlet.id);
    const [row] = await listOutletOrders(owner.id, outlet.id, {}, now);
    expect(row!.items).toEqual([
      { name: 'Bread bag', quantity: 2, status: 'active' },
      { name: 'Cake box', quantity: 1, status: 'active' },
    ]);
    const [confirm] = await db.select().from(notifications).where(eq(notifications.template, 'order_confirmed'));
    expect(confirm!.variables).toMatchObject({ item: '2 × Bread bag, Cake box' });
    const inv = await listInventory({ outletId: outlet.id }, now);
    expect(inv.drops.find((d) => d.drop.id === bread.id)!.orders).toMatchObject({ paid: 2, soldPaise: 20000 });
    expect(inv.drops.find((d) => d.drop.id === cake.id)!.orders).toMatchObject({ paid: 1, soldPaise: 15000 });

    await db.update(orders).set({ status: 'collected' }).where(and(eq(orders.id, orderId)));
    // 2 × (300 − 100) + 1 × (400 − 150) = 650 saved, over 3 bags.
    expect((await getProfile(user.id)).impact).toEqual({ bagsCollected: 3, moneySavedPaise: 65000 });
  });
});
