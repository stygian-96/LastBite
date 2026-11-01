import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { areas, brands, drops, listings, orders, outlets, payments, payoutAccounts, users } from '../../src/db/schema.js';

type Overrides<T extends { $inferInsert: unknown }> = Partial<T['$inferInsert']>;

let seq = 0;
const next = () => ++seq;

async function insertOne<T>(query: Promise<T[]>): Promise<T> {
  const [row] = await query;
  if (!row) throw new Error('insert returned no row');
  return row;
}

export function makeUser(o: Overrides<typeof users> = {}) {
  const n = next();
  return insertOne(
    db
      .insert(users)
      .values({ phone: `+9190000${String(n).padStart(5, '0')}`, name: `User ${n}`, ...o })
      .returning(),
  );
}

export async function makeBrand(o: Overrides<typeof brands> = {}) {
  const n = next();
  const createdBy = o.createdBy ?? (await makeUser()).id;
  return insertOne(db.insert(brands).values({ name: `Brand ${n}`, slug: `brand-${n}`, createdBy, ...o }).returning());
}

export async function makePayoutAccount(o: Overrides<typeof payoutAccounts> = {}) {
  const brandId = o.brandId ?? (await makeBrand()).id;
  return insertOne(
    db
      .insert(payoutAccounts)
      .values({
        brandId,
        legalName: 'Test Legal Name',
        panEncrypted: Buffer.from('pan'),
        panLast4: '1234',
        holderName: 'Test Holder',
        accountEncrypted: Buffer.from('account'),
        accountLast4: '6789',
        ifsc: 'HDFC0000001',
        status: 'verified',
        ...o,
      })
      .returning(),
  );
}

export async function makeLiveOutlet(o: Overrides<typeof outlets> = {}) {
  const n = next();
  const brandId = o.brandId ?? (await makeBrand()).id;
  const payoutAccountId = o.payoutAccountId ?? (await makePayoutAccount({ brandId })).id;
  const areaId = o.areaId ?? (await db.select({ id: areas.id }).from(areas).limit(1))[0]?.id;
  return insertOne(
    db
      .insert(outlets)
      .values({
        brandId,
        payoutAccountId,
        areaId,
        branchName: `Branch ${n}`,
        slug: `branch-${n}`,
        category: 'bakery',
        status: 'live',
        onboardingStep: 5,
        ...o,
      })
      .returning(),
  );
}

export async function makeListing(o: Overrides<typeof listings> = {}) {
  const n = next();
  const outletId = o.outletId ?? (await makeLiveOutlet()).id;
  return insertOne(
    db
      .insert(listings)
      .values({
        outletId,
        type: 'surprise_bag',
        name: `Bag ${n}`,
        description: 'A bag of leftovers',
        foodCategory: 'bakery',
        diet: 'veg',
        valuePaise: 30000,
        pricePaise: 10000,
        defaultQuantity: 5,
        pickupStart: '19:00',
        pickupEnd: '21:00',
        ...o,
      })
      .returning(),
  );
}

/** Defaults to a 19:00-21:00 IST pickup on 2026-11-02. */
export async function makeDrop(o: Overrides<typeof drops> = {}) {
  const listing = o.listingId ? undefined : await makeListing(o.outletId ? { outletId: o.outletId } : {});
  const listingId = o.listingId ?? listing!.id;
  const outletId = o.outletId ?? listing!.outletId;
  return insertOne(
    db
      .insert(drops)
      .values({
        listingId,
        outletId,
        serviceDate: '2026-11-02',
        quantity: 5,
        name: listing?.name ?? 'Bag',
        description: listing?.description ?? 'A bag of leftovers',
        type: 'surprise_bag',
        foodCategory: 'bakery',
        diet: 'veg',
        allergens: [],
        valuePaise: 30000,
        pricePaise: 10000,
        pickupStartAt: '2026-11-02T19:00:00+05:30',
        pickupEndAt: '2026-11-02T21:00:00+05:30',
        salesEndAt: '2026-11-02T20:45:00+05:30',
        ...o,
      })
      .returning(),
  );
}

export async function makeOrder(o: Overrides<typeof orders> = {}) {
  // A drop given by ID lends its outlet and service date, so a test need not repeat them.
  const drop = o.dropId
    ? o.outletId && o.serviceDate
      ? undefined
      : (await db.select().from(drops).where(eq(drops.id, o.dropId)))[0]
    : await makeDrop();
  const dropId = o.dropId ?? drop!.id;
  const outletId = o.outletId ?? drop!.outletId;
  const serviceDate = o.serviceDate ?? drop?.serviceDate ?? '2026-11-02';
  const userId = o.userId === undefined ? (await makeUser()).id : o.userId;
  const pricePaise = o.pricePaise ?? drop?.pricePaise ?? 10000;
  const commissionBps = o.commissionBps ?? 2000;
  return insertOne(
    db
      .insert(orders)
      .values({
        dropId,
        outletId,
        serviceDate,
        userId,
        pricePaise,
        commissionBps,
        commissionPaise: Math.round((pricePaise * commissionBps) / 10000),
        holdExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        ...o,
      })
      .returning(),
  );
}

export async function makePayment(o: Overrides<typeof payments> = {}) {
  const n = next();
  const order = o.orderId ? undefined : await makeOrder();
  return insertOne(
    db
      .insert(payments)
      .values({
        orderId: o.orderId ?? order!.id,
        razorpayOrderId: `order_test_${n}`,
        amountPaise: order?.pricePaise ?? 10000,
        ...o,
      })
      .returning(),
  );
}

/** A paid order with a pickup code and a captured payment. */
export async function makePaidOrder(o: Overrides<typeof orders> = {}) {
  const n = next();
  const order = await makeOrder({
    status: 'paid',
    paidAt: new Date().toISOString(),
    pickupCode: String(1000 + (n % 9000)),
    ...o,
  });
  await makePayment({
    orderId: order.id,
    razorpayPaymentId: `pay_test_${n}`,
    status: 'captured',
    amountPaise: order.pricePaise,
  });
  return order;
}
