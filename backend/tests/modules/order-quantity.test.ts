import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { listings, notifications } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { createSession } from '../../src/modules/auth/session.js';
import { listInventory } from '../../src/modules/admin/vendors.js';
import { createListing, updateListing } from '../../src/modules/catalogue/listings.js';
import { getDrop } from '../../src/modules/catalogue/feed.js';
import { expireHolds } from '../../src/modules/orders/expire.js';
import { changeHoldQuantity, releaseHold, reserveDrop } from '../../src/modules/orders/reserve.js';
import { getOrder } from '../../src/modules/orders/views.js';
import { getProfile } from '../../src/modules/customer/profile.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { listOutletOrders } from '../../src/modules/pickup/list.js';
import { cancelDrop, cancelOrder } from '../../src/modules/refunds/cancel.js';
import { app } from '../../src/app.js';
import { makeDrop, makeListing, makeLiveOutlet, makePayment, makeUser } from '../helpers/factories.js';
import { getDropRow, getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

// 15:30 IST on 2026-11-02. Default drops stop selling at 20:45 IST.
const now = new Date('2026-11-02T10:00:00Z');
const later = new Date(now.getTime() + 6 * 60_000 + 1000);

let gateway: FakeGateway;
beforeEach(async () => {
  await resetDb();
  gateway = new FakeGateway();
  setGateway(gateway);
});

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

/** A drop of `quantity` bags at ₹100, whose listing lets a customer take `maxPerOrder`. */
async function dropWith(quantity: number, maxPerOrder = 3, reservedCount = 0) {
  const outlet = await makeLiveOutlet({ commissionBps: 2000 });
  const listing = await makeListing({ outletId: outlet.id, maxPerOrder });
  return makeDrop({ outletId: outlet.id, listingId: listing.id, quantity, reservedCount, pricePaise: 10000 });
}

async function hold(quantity: number, dropOpts: [number, number?, number?] = [10]) {
  const drop = await dropWith(...dropOpts);
  const user = await makeUser();
  const order = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1', quantity }, now);
  return { drop, user, order };
}

/** A staff member who may cancel at the drop's outlet. */
async function ownerAt(outletId: string) {
  const { memberships, outlets } = await import('../../src/db/schema.js');
  const [o] = await db.select().from(outlets).where(eq(outlets.id, outletId));
  const owner = await makeUser();
  await db.insert(memberships).values({ userId: owner.id, brandId: o!.brandId, role: 'owner' });
  return owner;
}

describe('reserving several bags', () => {
  test('takes that many from stock and charges and commissions the total', async () => {
    const { drop, order } = await hold(3);
    expect(order).toMatchObject({ quantity: 3, pricePaise: 30000, commissionPaise: 6000 });
    expect((await getDropRow(drop.id)).reservedCount).toBe(3);
  });

  test('refuses more than the listing allows, and takes nothing', async () => {
    const drop = await dropWith(10, 2);
    const user = await makeUser();
    const e = await failure(reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1', quantity: 3 }, now));
    expect(e).toMatchObject({ code: 'over_limit', status: 409, details: { maxPerOrder: 2 } });
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('refuses more than is left, saying how many are', async () => {
    const drop = await dropWith(5, 3, 4);
    const user = await makeUser();
    const e = await failure(reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1', quantity: 2 }, now));
    expect(e).toMatchObject({ code: 'not_enough_left', details: { remaining: 1 } });
    expect((await getDropRow(drop.id)).reservedCount).toBe(4);
  });

  test('a bad quantity is a 400, and none means one bag', async () => {
    const drop = await dropWith(10);
    for (const quantity of [0, 11, 2.5, '2']) {
      const user = await makeUser();
      expect(await failure(reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1', quantity }, now))).toMatchObject({ status: 400 });
    }
    const user = await makeUser();
    expect(await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1' }, now)).toMatchObject({ quantity: 1, pricePaise: 10000 });
  });

  test('reserving again while holding adds to the same order', async () => {
    const { drop, user, order } = await hold(2);
    const again = await reserveDrop({ dropId: drop.id, userId: user.id, ip: '1.1.1.1', quantity: 1 }, now);
    expect(again).toMatchObject({ id: order.id, quantity: 3, pricePaise: 30000 });
    expect((await getDropRow(drop.id)).reservedCount).toBe(3);
  });

  test('parallel reserves of 3 on 10 bags never oversell', async () => {
    const drop = await dropWith(10);
    const users = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const results = await Promise.allSettled(users.map((u) => reserveDrop({ dropId: drop.id, userId: u.id, ip: '1.1.1.1', quantity: 3 }, now)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await getDropRow(drop.id)).reservedCount).toBe(9);
  });
});

describe('every bag goes back', () => {
  test('when the customer releases the hold', async () => {
    const { drop, user, order } = await hold(3);
    await releaseHold({ userId: user.id }, order.id, now);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('when the hold expires', async () => {
    const { drop } = await hold(3);
    await hold(2, [10]);
    await expireHolds(later);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
  });

  test('when the vendor cancels the order, which refunds the whole total', async () => {
    const { drop, order } = await hold(3);
    const payment = await makePayment({ orderId: order.id, amountPaise: 30000 });
    await applyCapture({ id: 'pay_q1', orderId: payment.razorpayOrderId, status: 'captured', amountPaise: 30000, feePaise: 0, method: 'upi' }, now);
    expect((await getOrderRow(order.id)).status).toBe('paid');
    const owner = await ownerAt(drop.outletId);
    await cancelOrder(owner.id, order.id, 'ran_out', now);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    expect(await refundsFor(order.id)).toMatchObject([{ amountPaise: 30000 }]);
  });

  test('when the vendor cancels the whole drop', async () => {
    const { drop, order } = await hold(3);
    await makeDrop({ outletId: drop.outletId }); // another drop at the outlet is untouched
    const owner = await ownerAt(drop.outletId);
    await cancelDrop(owner.id, drop.id, 'ran_out', now);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    expect((await getOrderRow(order.id)).status).toBe('expired');
  });
});

describe('a payment that lands after the hold expired', () => {
  test('takes all its bags again if they are still there', async () => {
    const { drop, order } = await hold(2);
    const payment = await makePayment({ orderId: order.id, amountPaise: 20000 });
    await expireHolds(later);
    expect((await getDropRow(drop.id)).reservedCount).toBe(0);
    await applyCapture({ id: 'pay_late', orderId: payment.razorpayOrderId, status: 'captured', amountPaise: 20000, feePaise: 0, method: 'upi' }, later);
    expect((await getOrderRow(order.id)).status).toBe('paid');
    expect((await getDropRow(drop.id)).reservedCount).toBe(2);
  });

  test('is refunded if only some of its bags are left', async () => {
    const { drop, order } = await hold(2, [3]);
    const payment = await makePayment({ orderId: order.id, amountPaise: 20000 });
    await expireHolds(later);
    const other = await makeUser();
    await reserveDrop({ dropId: drop.id, userId: other.id, ip: '1.1.1.2', quantity: 2 }, later);
    await applyCapture({ id: 'pay_late2', orderId: payment.razorpayOrderId, status: 'captured', amountPaise: 20000, feePaise: 0, method: 'upi' }, later);
    expect((await getOrderRow(order.id)).status).toBe('expired');
    expect((await getDropRow(drop.id)).reservedCount).toBe(2);
    expect(await refundsFor(order.id)).toMatchObject([{ amountPaise: 20000, reason: 'late_payment' }]);
  });
});

describe('changing the quantity at checkout', () => {
  test('up takes more stock, down gives it back, and the total follows', async () => {
    const { drop, user, order } = await hold(1);
    await changeHoldQuantity({ userId: user.id }, order.id, 3, now);
    expect(await getOrderRow(order.id)).toMatchObject({ quantity: 3, pricePaise: 30000, commissionPaise: 6000 });
    expect((await getDropRow(drop.id)).reservedCount).toBe(3);
    await changeHoldQuantity({ userId: user.id }, order.id, 2, now);
    expect(await getOrderRow(order.id)).toMatchObject({ quantity: 2, pricePaise: 20000, commissionPaise: 4000 });
    expect((await getDropRow(drop.id)).reservedCount).toBe(2);
  });

  test('over the limit or past what is left is refused and changes nothing', async () => {
    const { drop, user, order } = await hold(1, [3, 3, 1]);
    // 3 bags, 1 taken before, 1 by this hold: 1 left, so 2 is the most this order can be.
    expect(await failure(changeHoldQuantity({ userId: user.id }, order.id, 3, now))).toMatchObject({ code: 'not_enough_left', details: { remaining: 2 } });
    expect(await failure(changeHoldQuantity({ userId: user.id }, order.id, 4, now))).toMatchObject({ code: 'over_limit' });
    expect(await getOrderRow(order.id)).toMatchObject({ quantity: 1, pricePaise: 10000 });
    expect((await getDropRow(drop.id)).reservedCount).toBe(2);
    await changeHoldQuantity({ userId: user.id }, order.id, 2, now);
    expect((await getDropRow(drop.id)).reservedCount).toBe(3);
  });

  test('is refused once payment has started, after the hold, and for anyone else', async () => {
    const { user, order } = await hold(1);
    const stranger = await makeUser();
    expect(await failure(changeHoldQuantity({ userId: stranger.id }, order.id, 2, now))).toMatchObject({ status: 404 });
    expect(await failure(changeHoldQuantity({ userId: user.id }, order.id, 2, later))).toMatchObject({ code: 'hold_not_active' });
    await makePayment({ orderId: order.id });
    expect(await failure(changeHoldQuantity({ userId: user.id }, order.id, 2, now))).toMatchObject({ code: 'payment_started' });
  });

  test('the order view says how far it can go', async () => {
    const { user, order } = await hold(2, [4, 3]);
    expect(await getOrder({ userId: user.id }, order.id)).toMatchObject({ quantity: 2, pricePaise: 20000, unitPricePaise: 10000, maxQuantity: 3 });
  });
});

describe('what customers and vendors see', () => {
  test('a drop offers the smaller of the limit and what is left', async () => {
    const roomy = await dropWith(10, 3);
    const tight = await dropWith(5, 3, 4);
    expect(await getDrop(roomy.id, now)).toMatchObject({ maxQuantity: 3, remaining: 10 });
    expect(await getDrop(tight.id, now)).toMatchObject({ maxQuantity: 1, remaining: 1 });
  });

  test("the vendor's order list and the admin counts show bags", async () => {
    const { drop, order } = await hold(3);
    const payment = await makePayment({ orderId: order.id, amountPaise: 30000 });
    await applyCapture({ id: 'pay_v', orderId: payment.razorpayOrderId, status: 'captured', amountPaise: 30000, feePaise: 0, method: 'upi' }, now);
    const owner = await ownerAt(drop.outletId);
    expect(await listOutletOrders(owner.id, drop.outletId, {}, now)).toMatchObject([{ quantity: 3, pricePaise: 30000 }]);
    const [row] = (await listInventory({ outletId: drop.outletId }, now)).drops;
    expect(row!.orders).toMatchObject({ paid: 3, soldPaise: 30000 });
    const [message] = await db.select().from(notifications).where(eq(notifications.template, 'order_confirmed'));
    expect(message!.variables).toMatchObject({ item: expect.stringMatching(/^3 × /) });
  });

  test('a listing starts at 3 a customer, and the vendor sets 1 to 10', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await ownerAt(outlet.id);
    const listing = await createListing(owner.id, outlet.id, {
      type: 'surprise_bag',
      name: 'Bag',
      description: 'Bread',
      foodCategory: 'bakery',
      diet: 'veg',
      valuePaise: 30000,
      pricePaise: 10000,
      defaultQuantity: 5,
      pickupStart: '19:00',
      pickupEnd: '21:00',
    });
    expect(listing.maxPerOrder).toBe(3);
    expect((await updateListing(owner.id, listing.id, { maxPerOrder: 1 })).maxPerOrder).toBe(1);
    expect(await failure(updateListing(owner.id, listing.id, { maxPerOrder: 11 }))).toMatchObject({ status: 400 });
    expect((await db.select().from(listings).where(eq(listings.id, listing.id)))[0]!.maxPerOrder).toBe(1);
  });
});

describe('the customer profile', () => {
  test('counts bags and savings across a multi-bag order', async () => {
    const { user, order } = await hold(3);
    const { orders } = await import('../../src/db/schema.js');
    await db.update(orders).set({ status: 'collected' }).where(eq(orders.id, order.id));
    // Three ₹300 bags for ₹300 in all saves ₹600.
    expect((await getProfile(user.id)).impact).toEqual({ bagsCollected: 3, moneySavedPaise: 60000 });
  });
});

describe('over HTTP', () => {
  test('reserve with a quantity, then change it', async () => {
    // The routes run on the real clock, so this drop is on sale from now on.
    const future = Date.now() + 2 * 3_600_000;
    const outlet = await makeLiveOutlet();
    const listing = await makeListing({ outletId: outlet.id });
    const drop = await makeDrop({
      outletId: outlet.id,
      listingId: listing.id,
      quantity: 10,
      pricePaise: 10000,
      pickupStartAt: new Date(future).toISOString(),
      pickupEndAt: new Date(future + 3_600_000).toISOString(),
      salesEndAt: new Date(future + 2_700_000).toISOString(),
    });
    const user = await makeUser();
    const token = await createSession(user.id, new Date());
    const headers = { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN, 'content-type': 'application/json' };
    const made = await app.request('/api/v1/orders', { method: 'POST', headers, body: JSON.stringify({ dropId: drop.id, quantity: 2 }) });
    expect(made.status).toBe(200);
    const { order } = (await made.json()) as { order: { id: string; quantity: number; pricePaise: number } };
    expect(order).toMatchObject({ quantity: 2, pricePaise: 20000 });
    const changed = await app.request(`/api/v1/orders/${order.id}/quantity`, { method: 'PATCH', headers, body: JSON.stringify({ quantity: 3 }) });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { order: { quantity: number } }).order.quantity).toBe(3);
  });
});
