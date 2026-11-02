import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { auditLog, memberships, orders, outlets, payments, payoutAccounts, payouts, refunds } from '../../src/db/schema.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { decrypt, encrypt } from '../../src/lib/crypto.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { adminRefund } from '../../src/modules/admin/support.js';
import { createSession } from '../../src/modules/auth/session.js';
import { expireHolds } from '../../src/modules/orders/expire.js';
import { reserveDrop } from '../../src/modules/orders/reserve.js';
import { applyCapture } from '../../src/modules/payments/capture.js';
import { updatePayoutAccount } from '../../src/modules/onboarding/payout-accounts.js';
import { approvePayout, holdPayout, markPayoutPaid, unholdPayout, verifyPayoutAccount } from '../../src/modules/payouts/approve.js';
import { carriedBalance } from '../../src/modules/payouts/balance.js';
import { buildPayouts } from '../../src/modules/payouts/build.js';
import { getEarnings, statementCsv } from '../../src/modules/payouts/statements.js';
import { createTransfers, syncLinkedAccounts } from '../../src/modules/payouts/transfers.js';
import { cancelOrder } from '../../src/modules/refunds/cancel.js';
import { processRefunds } from '../../src/modules/refunds/process.js';
import { app } from '../../src/app.js';
import { makeDrop, makeLiveOutlet, makePaidOrder, makePayment, makePayoutAccount, makeUser } from '../helpers/factories.js';
import { getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

// Monday morning IST, after the week of 2 to 8 November 2026.
const now = new Date('2026-11-09T02:00:00Z');
const WEEK = '2026-11-02';
const NEXT_WEEK = '2026-11-09';
const WEEK_AFTER = '2026-11-16';
const MINUTES = 60_000;

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

const linkedAccount = (o: Parameters<typeof makePayoutAccount>[0] = {}) =>
  makePayoutAccount({ razorpayAccountId: `acc_${++seq}`, ...o });

async function linkedOutlet() {
  const account = await linkedAccount();
  const outlet = await makeLiveOutlet({ brandId: account.brandId, payoutAccountId: account.id });
  return { account, outlet };
}

type Sale = { serviceDate?: string; pricePaise?: number; feePaise?: number; status?: string; taxPaise?: number };

/** A captured order at the outlet, collected by default, with no transfer yet. */
async function sale(outletId: string, o: Sale = {}) {
  const { serviceDate = '2026-11-03', pricePaise = 14900, feePaise = 300, status = 'collected', taxPaise = 0 } = o;
  const drop = await makeDrop({ outletId, serviceDate, pricePaise });
  const order = await makePaidOrder({ dropId: drop.id, status, taxPaise });
  await db.update(payments).set({ feePaise }).where(eq(payments.orderId, order.id));
  return { order, payment: await paymentFor(order.id) };
}

async function paymentFor(orderId: string) {
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId));
  return payment!;
}

const payoutRow = async (id: string) => (await db.select().from(payouts).where(eq(payouts.id, id)))[0]!;
const accountRow = async (id: string) => (await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, id)))[0]!;
const auditsFor = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

const addRefund = async (
  order: { id: string },
  payment: { id: string },
  amountPaise: number,
  o: Partial<typeof refunds.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(refunds)
    .values({
      orderId: order.id,
      paymentId: payment.id,
      amountPaise,
      reason: 'issue_resolution',
      chargedTo: 'vendor',
      status: 'processed',
      ...o,
    })
    .returning();
  return row!;
};

const admin = () => makeUser({ isAdmin: true });

/** A brand-wide owner of the account's brand. */
async function ownerOf(brandId: string) {
  const user = await makeUser();
  await db.insert(memberships).values({ userId: user.id, brandId, role: 'owner' });
  return user;
}

/** A franchisee: a manager whose membership names the payout account. */
async function franchiseeOf(brandId: string, outletId: string, payoutAccountId: string) {
  const user = await makeUser();
  await db.insert(memberships).values({ userId: user.id, brandId, outletId, payoutAccountId, role: 'manager' });
  return user;
}

const bankChange = {
  legalName: 'New Legal Name',
  pan: 'ABCDE1234F',
  holderName: 'New Holder',
  accountNumber: '998877665544',
  ifsc: 'ICIC0000002',
};

const request = (path: string, token: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      cookie: `session=${token}`,
      'content-type': 'application/json',
      origin: env().FRONTEND_ORIGIN,
      ...init.headers,
    },
  });

/** Runs the transfer job and the build for the test week, and returns the one payout. */
async function built(periodStart = WEEK) {
  await createTransfers(now);
  const [payout] = await buildPayouts(periodStart, now);
  return payout!;
}

describe('createTransfers', () => {
  test('transfer equals price minus commission, fee and tax, and starts on hold', async () => {
    const { account, outlet } = await linkedOutlet();
    const { order, payment } = await sale(outlet.id, { pricePaise: 14900, feePaise: 300, taxPaise: 50 });

    expect(await createTransfers(now)).toBe(1);

    const saved = await paymentFor(order.id);
    expect(saved.transferStatus).toBe('on_hold');
    expect(saved.transferPaise).toBe(14900 - 2980 - 300 - 50);
    expect(saved.razorpayTransferId).toBe(gateway.transfers[0]!.id);
    expect(gateway.transfers).toHaveLength(1);
    expect(gateway.transfers[0]).toMatchObject({
      paymentId: payment.razorpayPaymentId,
      accountId: account.razorpayAccountId,
      amountPaise: 11570,
      released: false,
    });
  });

  test('createTransfers runs once per payment', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);

    expect(await createTransfers(now)).toBe(1);
    expect(await createTransfers(now)).toBe(0);
    expect(gateway.transfers).toHaveLength(1);
  });

  test('two runs at once make one gateway transfer between them', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);

    const counts = await Promise.all([createTransfers(now), createTransfers(now)]);

    expect(counts[0]! + counts[1]!).toBe(1);
    expect(gateway.transfers).toHaveLength(1);
  });

  test('a run that lost its answer goes again on the same key and gets the same transfer', async () => {
    const { outlet } = await linkedOutlet();
    const { order } = await sale(outlet.id);
    const real = gateway.createTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(gateway, 'createTransfer').mockImplementationOnce(async (a) => {
      await real(a);
      throw new Error('Gateway timed out');
    });

    expect(await createTransfers(now)).toBe(0);
    expect((await paymentFor(order.id)).transferStatus).toBe('none');
    // Still claimed, so an immediate run leaves it alone.
    expect(await createTransfers(new Date(now.getTime() + MINUTES))).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);

    expect(await createTransfers(new Date(now.getTime() + 6 * MINUTES))).toBe(1);
    expect(gateway.transfers).toHaveLength(1);
    expect((await paymentFor(order.id)).razorpayTransferId).toBe(gateway.transfers[0]!.id);
  });

  test('a paid order gets a transfer, and so does a no-show', async () => {
    const { outlet } = await linkedOutlet();
    const paid = await sale(outlet.id, { status: 'paid' });
    const noShow = await sale(outlet.id, { status: 'no_show' });

    expect(await createTransfers(now)).toBe(2);
    expect((await paymentFor(paid.order.id)).transferStatus).toBe('on_hold');
    expect((await paymentFor(noShow.order.id)).transferStatus).toBe('on_hold');
  });

  test('skips a cancelled order, an unlinked account, and an order a vendor refund covers', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id, { status: 'cancelled' });
    const unlinked = await makeLiveOutlet();
    await sale(unlinked.id);
    const refunded = await sale(outlet.id);
    await addRefund(refunded.order, refunded.payment, refunded.payment.amountPaise, { status: 'pending' });

    expect(await createTransfers(now)).toBe(0);
    expect(gateway.transfers).toEqual([]);
  });

  test('a platform refund, a failed vendor refund or a part refund leaves the transfer to go ahead', async () => {
    const { outlet } = await linkedOutlet();
    const platform = await sale(outlet.id);
    await addRefund(platform.order, platform.payment, platform.payment.amountPaise, { chargedTo: 'platform' });
    const failed = await sale(outlet.id);
    await addRefund(failed.order, failed.payment, failed.payment.amountPaise, { status: 'failed' });
    const part = await sale(outlet.id);
    await addRefund(part.order, part.payment, 1000);

    expect(await createTransfers(now)).toBe(3);
  });

  test('skips an extra payment that was refunded as a duplicate', async () => {
    const { outlet } = await linkedOutlet();
    const { order } = await sale(outlet.id);
    const extra = await makePayment({
      orderId: order.id,
      razorpayPaymentId: `pay_extra_${++seq}`,
      status: 'captured',
      amountPaise: order.pricePaise,
      feePaise: 300,
    });
    await addRefund(order, extra, extra.amountPaise, { reason: 'duplicate_payment', chargedTo: 'platform' });

    expect(await createTransfers(now)).toBe(1);
    expect(gateway.transfers).toHaveLength(1);
    const [extraRow] = await db.select().from(payments).where(eq(payments.id, extra.id));
    expect(extraRow!.transferStatus).toBe('none');
  });

  test('one run takes at most 100, and the next run takes the rest', async () => {
    const { outlet } = await linkedOutlet();
    const drop = await makeDrop({ outletId: outlet.id, quantity: 200, pricePaise: 14900 });
    for (let i = 0; i < 101; i++) {
      const order = await makePaidOrder({ dropId: drop.id, status: 'collected', pickupCode: null });
      await db.update(payments).set({ feePaise: 300 }).where(eq(payments.orderId, order.id));
    }

    expect(await createTransfers(now)).toBe(100);
    expect(await createTransfers(now)).toBe(1);
  });

  test('asks the gateway for a fee it was not told about, and saves it', async () => {
    const { outlet } = await linkedOutlet();
    const { order, payment } = await sale(outlet.id);
    await db.update(payments).set({ feePaise: null }).where(eq(payments.id, payment.id));
    gateway.addPayment({
      id: payment.razorpayPaymentId!,
      orderId: payment.razorpayOrderId,
      status: 'captured',
      amountPaise: 14900,
      feePaise: 354,
      method: 'upi',
    });

    expect(await createTransfers(now)).toBe(1);
    expect(await paymentFor(order.id)).toMatchObject({ feePaise: 354, transferPaise: 14900 - 2980 - 354 });
  });

  test('a sale that leaves the vendor nothing makes no transfer, and is flagged once', async () => {
    const { outlet } = await linkedOutlet();
    const { order, payment } = await sale(outlet.id, { pricePaise: 100, feePaise: 90 });

    expect(await createTransfers(now)).toBe(0);
    expect(await createTransfers(new Date(now.getTime() + 6 * MINUTES))).toBe(0);

    expect(gateway.transfers).toEqual([]);
    expect((await paymentFor(order.id)).transferStatus).toBe('none');
    const flags = await auditsFor('transfer.no_net');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.entityId).toBe(payment.id);
  });

  describe('when a cancel wins the race', () => {
    async function raced(afterCancel: () => Promise<unknown> = async () => undefined) {
      const { account, outlet } = await linkedOutlet();
      const owner = await ownerOf(account.brandId);
      const { order } = await sale(outlet.id, { status: 'paid' });
      const real = gateway.createTransfer.bind(gateway);
      vi.spyOn(gateway, 'createTransfer').mockImplementation(async (a) => {
        const transfer = await real(a);
        await cancelOrder(owner.id, order.id, 'ran_out', now);
        await afterCancel();
        return transfer;
      });
      return order;
    }

    test('an unsent refund is told to reverse the transfer', async () => {
      const order = await raced();

      await createTransfers(now);

      expect((await paymentFor(order.id)).transferStatus).toBe('on_hold');
      const [refund] = await refundsFor(order.id);
      expect(refund).toMatchObject({ reason: 'vendor_cancelled', reverseTransfer: true });
      expect(await auditsFor('transfer.orphaned')).toEqual([]);

      await processRefunds(now);
      expect((await paymentFor(order.id)).transferStatus).toBe('reversed');
      expect(gateway.refunds[0]).toMatchObject({ reverseTransfer: true });
    });

    test('a refund already sent leaves the transfer for an admin', async () => {
      const order = await raced(() => processRefunds(now));

      await createTransfers(now);

      const flags = await auditsFor('transfer.orphaned');
      expect(flags).toHaveLength(1);
      expect(flags[0]!.detail).toMatchObject({ orderId: order.id, razorpayTransferId: gateway.transfers[0]!.id });
      const [refund] = await refundsFor(order.id);
      expect(refund!.reverseTransfer).toBe(false);
      expect((await paymentFor(order.id)).transferStatus).toBe('on_hold');
    });

    test('a refund being sent is left as it is, as its payload has gone', async () => {
      const order = await raced(async () => {
        await db.update(refunds).set({ sendingAt: now.toISOString() });
      });

      await createTransfers(now);

      expect((await refundsFor(order.id))[0]!.reverseTransfer).toBe(false);
      expect(await auditsFor('transfer.orphaned')).toHaveLength(1);
    });

    test('a refund with an unclear send keeps its payload', async () => {
      const order = await raced(async () => {
        await db.update(refunds).set({ sendErrors: 1 });
      });

      await createTransfers(now);

      expect((await refundsFor(order.id))[0]!.reverseTransfer).toBe(false);
      expect(await auditsFor('transfer.orphaned')).toHaveLength(1);
    });
  });

  test('a full vendor refund made during the call also reverses the transfer', async () => {
    const { outlet } = await linkedOutlet();
    const { order } = await sale(outlet.id);
    const adminUser = await admin();
    const real = gateway.createTransfer.bind(gateway);
    vi.spyOn(gateway, 'createTransfer').mockImplementation(async (a) => {
      const transfer = await real(a);
      await adminRefund(adminUser.id, order.id, { amountPaise: 14900, chargedTo: 'vendor' }, now);
      return transfer;
    });

    await createTransfers(now);

    expect((await refundsFor(order.id))[0]!.reverseTransfer).toBe(true);
  });
});

describe('syncLinkedAccounts', () => {
  const encrypted = () => ({ panEncrypted: encrypt('ABCDE1234F'), accountEncrypted: encrypt('123456789012') });

  test('creates a linked account for a verified account, from the decrypted details, and saves the ID', async () => {
    const brandOwner = await makeUser({ email: 'owner@example.com' });
    const account = await makePayoutAccount(encrypted());
    await db.insert(memberships).values({ userId: brandOwner.id, brandId: account.brandId, role: 'owner' });
    await makeLiveOutlet({
      brandId: account.brandId,
      payoutAccountId: account.id,
      address: '1 MG Road',
      pincode: '560001',
    });

    expect(await syncLinkedAccounts(now)).toBe(1);

    expect(gateway.linkedAccounts).toHaveLength(1);
    expect(gateway.linkedAccounts[0]).toMatchObject({
      legalName: 'Test Legal Name',
      holderName: 'Test Holder',
      pan: 'ABCDE1234F',
      accountNumber: '123456789012',
      ifsc: 'HDFC0000001',
      phone: brandOwner.phone,
      email: 'owner@example.com',
      contactName: brandOwner.name,
      address: { street: '1 MG Road', postalCode: '560001' },
    });
    expect((await accountRow(account.id)).razorpayAccountId).toBe(gateway.linkedAccounts[0]!.id);

    expect(await syncLinkedAccounts(now)).toBe(0);
    expect(gateway.linkedAccounts).toHaveLength(1);
  });

  test('a franchisee named on the account is its contact', async () => {
    const account = await makePayoutAccount(encrypted());
    const outlet = await makeLiveOutlet({ brandId: account.brandId, payoutAccountId: account.id });
    await ownerOf(account.brandId);
    const franchisee = await franchiseeOf(account.brandId, outlet.id, account.id);

    await syncLinkedAccounts(now);

    expect(gateway.linkedAccounts[0]!.phone).toBe(franchisee.phone);
  });

  test('skips an account not verified, or linked already', async () => {
    const pending = await makePayoutAccount({ ...encrypted(), status: 'pending' });
    const hold = await makePayoutAccount({ ...encrypted(), status: 'on_hold' });
    await makePayoutAccount({ ...encrypted(), razorpayAccountId: 'acc_done' });
    await ownerOf(pending.brandId);
    await ownerOf(hold.brandId);

    expect(await syncLinkedAccounts(now)).toBe(0);
    expect(gateway.linkedAccounts).toEqual([]);
  });

  test('two runs at once create one linked account', async () => {
    const account = await makePayoutAccount(encrypted());
    await ownerOf(account.brandId);

    await Promise.all([syncLinkedAccounts(now), syncLinkedAccounts(now)]);

    expect(gateway.linkedAccounts).toHaveLength(1);
  });

  test('a bank change during the call does not save the old account ID', async () => {
    const account = await makePayoutAccount(encrypted());
    const owner = await ownerOf(account.brandId);
    const real = gateway.createLinkedAccount.bind(gateway);
    vi.spyOn(gateway, 'createLinkedAccount').mockImplementation(async (a) => {
      const created = await real(a);
      await updatePayoutAccount(owner.id, account.id, bankChange, now);
      return created;
    });

    expect(await syncLinkedAccounts(now)).toBe(0);
    expect((await accountRow(account.id)).razorpayAccountId).toBeNull();
  });

  test('a failure leaves the account for a later run, and does not stop the others', async () => {
    const first = await makePayoutAccount(encrypted());
    const second = await makePayoutAccount(encrypted());
    await ownerOf(first.brandId);
    await ownerOf(second.brandId);
    const real = gateway.createLinkedAccount.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(gateway, 'createLinkedAccount').mockRejectedValueOnce(new Error('Gateway down'));

    expect(await syncLinkedAccounts(now)).toBe(1);

    vi.mocked(gateway.createLinkedAccount).mockImplementation(real);
    expect(await syncLinkedAccounts(new Date(now.getTime() + 6 * MINUTES))).toBe(1);
  });
});

describe('buildPayouts', () => {
  test('payout groups collected and no-show orders by payout account, Monday to Sunday service_date', async () => {
    const { account, outlet } = await linkedOutlet();
    const monday = await sale(outlet.id, { serviceDate: '2026-11-02' });
    const sunday = await sale(outlet.id, { serviceDate: '2026-11-08', status: 'no_show' });
    const nextMonday = await sale(outlet.id, { serviceDate: '2026-11-09' });
    const other = await linkedOutlet();
    await sale(other.outlet.id);

    await createTransfers(now);
    const built = await buildPayouts(WEEK, now);

    expect(built).toHaveLength(2);
    const payout = built.find((p) => p.payoutAccountId === account.id)!;
    expect(payout).toMatchObject({ periodStart: WEEK, periodEnd: '2026-11-08', status: 'draft' });
    expect((await getOrderRow(monday.order.id)).payoutId).toBe(payout.id);
    expect((await getOrderRow(sunday.order.id)).payoutId).toBe(payout.id);
    expect((await getOrderRow(nextMonday.order.id)).payoutId).toBeNull();
  });

  test('cancelled orders are excluded', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    const cancelled = await sale(outlet.id);
    await createTransfers(now);
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, cancelled.order.id));

    const [payout] = await buildPayouts(WEEK, now);

    expect(payout).toMatchObject({ grossPaise: 14900 });
    expect((await getOrderRow(cancelled.order.id)).payoutId).toBeNull();
  });

  test('payout maths reconciles to the paisa', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    await sale(outlet.id);

    const payout = await built();

    expect(payout).toMatchObject({ grossPaise: 29800, commissionPaise: 5960, feesPaise: 600, taxPaise: 0, netPaise: 23240 });
    const total = gateway.transfers.reduce((sum, t) => sum + t.amountPaise, 0);
    expect(total).toBe(payout.netPaise);
  });

  test('tax is kept apart and comes off the net', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id, { taxPaise: 100 });

    expect(await built()).toMatchObject({ taxPaise: 100, netPaise: 11620 - 100 });
  });

  test('build twice for a week creates one payout', async () => {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    const first = await built();

    await sale(outlet.id);
    await createTransfers(now);
    const [again] = await buildPayouts(WEEK, now);

    expect(again!.id).toBe(first.id);
    expect(again!.grossPaise).toBe(14900);
    expect(await db.select().from(payouts).where(eq(payouts.payoutAccountId, account.id))).toHaveLength(1);
  });

  test('two builds at once make one payout and count each order once', async () => {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    await createTransfers(now);

    await Promise.all([buildPayouts(WEEK, now), buildPayouts(WEEK, now)]);

    const rows = await db.select().from(payouts).where(eq(payouts.payoutAccountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grossPaise).toBe(14900);
  });

  test('two outlets on one account share a payout, franchisee is separate', async () => {
    const { account, outlet } = await linkedOutlet();
    const second = await makeLiveOutlet({ brandId: account.brandId, payoutAccountId: account.id });
    const franchiseAccount = await linkedAccount({ brandId: account.brandId });
    const franchise = await makeLiveOutlet({ brandId: account.brandId, payoutAccountId: franchiseAccount.id });
    await sale(outlet.id);
    await sale(second.id);
    await sale(franchise.id);

    await createTransfers(now);
    const built = await buildPayouts(WEEK, now);

    expect(built).toHaveLength(2);
    expect(built.find((p) => p.payoutAccountId === account.id)!.grossPaise).toBe(29800);
    expect(built.find((p) => p.payoutAccountId === franchiseAccount.id)!.grossPaise).toBe(14900);
  });

  test('an order with no transfer yet rolls to the next week', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    await createTransfers(now);
    const late = await sale(outlet.id);
    const first = (await buildPayouts(WEEK, now))[0]!;
    expect(first.grossPaise).toBe(14900);

    await createTransfers(now);
    const [next] = await buildPayouts(NEXT_WEEK, now);

    expect(next!.grossPaise).toBe(14900);
    expect((await getOrderRow(late.order.id)).payoutId).toBe(next!.id);
  });

  test('a reversed transfer, or one a sent or unsent refund will reverse, stays out', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    const reversed = await sale(outlet.id);
    const reversing = await sale(outlet.id);
    await createTransfers(now);
    await db.update(payments).set({ transferStatus: 'reversed' }).where(eq(payments.id, reversed.payment.id));
    await addRefund(reversing.order, reversing.payment, 14900, { status: 'pending', reverseTransfer: true });

    const [payout] = await buildPayouts(WEEK, now);

    expect(payout!.grossPaise).toBe(14900);
    expect((await getOrderRow(reversed.order.id)).payoutId).toBeNull();
    expect((await getOrderRow(reversing.order.id)).payoutId).toBeNull();
  });

  test('a payout on an account on hold is built held', async () => {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    await createTransfers(now);
    await db.update(payoutAccounts).set({ status: 'on_hold' }).where(eq(payoutAccounts.id, account.id));

    const [payout] = await buildPayouts(WEEK, now);

    expect(payout!.status).toBe('held');
  });

  test('a period start that is not a Monday is refused', async () => {
    expect((await failure(buildPayouts('2026-11-03', now)))?.code).toBe('invalid_request');
    expect((await failure(buildPayouts('nonsense', now)))?.code).toBe('invalid_request');
  });
});

describe('adjustments', () => {
  test('refund after payout is deducted next week, once', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    await approvePayout(adminUser.id, payout.id, now);

    // A real refund through the admin route and the job: the transfer is released, so it is no reversal.
    gateway.refundStatus = 'processed';
    await adminRefund(adminUser.id, first.order.id, { amountPaise: 14900, chargedTo: 'vendor' }, now);
    await processRefunds(now);
    const [refund] = await refundsFor(first.order.id);
    expect(refund).toMatchObject({ reverseTransfer: false, status: 'processed' });

    await sale(outlet.id, { serviceDate: '2026-11-10' });
    const next = await built(NEXT_WEEK);

    expect(next).toMatchObject({ grossPaise: 14900, adjustmentPaise: -14900, netPaise: 11620 - 14900 });
    expect((await refundsFor(first.order.id))[0]!.adjustedPayoutId).toBe(next.id);

    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const after = await built(WEEK_AFTER);
    expect(after.adjustmentPaise).toBe(next.netPaise);
  });

  test('only a processed refund counts', async () => {
    const { outlet } = await linkedOutlet();
    const pending = await sale(outlet.id);
    const failed = await sale(outlet.id);
    await addRefund(pending.order, pending.payment, 1000, { status: 'pending' });
    await addRefund(failed.order, failed.payment, 1000, { status: 'failed' });

    const payout = await built();

    expect(payout.adjustmentPaise).toBe(0);
    expect((await refundsFor(pending.order.id))[0]!.adjustedPayoutId).toBeNull();
  });

  test('vendor-charged issue refund reduces the payout, platform-charged does not', async () => {
    const { outlet } = await linkedOutlet();
    const vendor = await sale(outlet.id);
    const platform = await sale(outlet.id);
    await addRefund(vendor.order, vendor.payment, 2000);
    await addRefund(platform.order, platform.payment, 3000, { chargedTo: 'platform' });

    const payout = await built();

    expect(payout).toMatchObject({ grossPaise: 29800, adjustmentPaise: -2000, netPaise: 23240 - 2000 });
    expect((await refundsFor(vendor.order.id))[0]!.adjustedPayoutId).toBe(payout.id);
    expect((await refundsFor(platform.order.id))[0]!.adjustedPayoutId).toBeNull();
  });

  test('a refund that reversed the transfer is no adjustment, and nor is one on a reversed order', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    const cancelled = await sale(outlet.id, { status: 'paid' });
    await createTransfers(now);
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, cancelled.order.id));
    await db.update(payments).set({ transferStatus: 'reversed' }).where(eq(payments.id, cancelled.payment.id));
    await addRefund(cancelled.order, cancelled.payment, 1000);
    await addRefund(cancelled.order, cancelled.payment, 13900, { reason: 'vendor_cancelled', reverseTransfer: true });

    const [payout] = await buildPayouts(WEEK, now);

    expect(payout!.adjustmentPaise).toBe(0);
  });

  test('a full refund with no transfer ever made takes nothing from the vendor', async () => {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    const refunded = await sale(outlet.id);
    await addRefund(refunded.order, refunded.payment, 14900);

    const payout = await built();

    expect(payout.payoutAccountId).toBe(account.id);
    expect(payout).toMatchObject({ grossPaise: 14900, adjustmentPaise: 0 });
  });

  test('a part refund waits for its order to have a transfer', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    await createTransfers(now);
    const late = await sale(outlet.id);
    await addRefund(late.order, late.payment, 1000);

    const [first] = await buildPayouts(WEEK, now);
    expect(first!.adjustmentPaise).toBe(0);

    await createTransfers(now);
    const [next] = await buildPayouts(NEXT_WEEK, now);
    expect(next).toMatchObject({ grossPaise: 14900, adjustmentPaise: -1000 });
  });

  test('an adjustment with no orders still gets a payout, held if negative', async () => {
    const { account, outlet } = await linkedOutlet();
    const { order, payment } = await sale(outlet.id);
    const payout = await built();
    await approvePayout((await admin()).id, payout.id, now);
    await addRefund(order, payment, 5000);

    const [next] = await buildPayouts(NEXT_WEEK, now);

    expect(next).toMatchObject({
      payoutAccountId: account.id,
      grossPaise: 0,
      adjustmentPaise: -5000,
      netPaise: -5000,
      status: 'held',
    });
  });

  test('negative net is held and carried into the next week', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    const adminUser = await admin();
    await approvePayout(adminUser.id, (await built()).id, now);
    await addRefund(first.order, first.payment, 14900);
    await sale(outlet.id, { serviceDate: '2026-11-10' });

    const negative = await built(NEXT_WEEK);
    expect(negative).toMatchObject({ netPaise: -3280, status: 'held' });

    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const next = await built(WEEK_AFTER);

    expect(next).toMatchObject({ grossPaise: 14900, adjustmentPaise: -3280, netPaise: 11620 - 3280, status: 'draft' });
    expect(await payoutRow(negative.id)).toMatchObject({ status: 'released', paidAt: null });

    // Carried once only.
    await sale(outlet.id, { serviceDate: '2026-11-24' });
    const later = await built('2026-11-23');
    expect(later.adjustmentPaise).toBe(0);
  });

  test('a held payout on an account on hold is not carried, as its net is not negative', async () => {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    await sale(outlet.id, { serviceDate: '2026-11-10' });
    await createTransfers(now);
    await db.update(payoutAccounts).set({ status: 'on_hold' }).where(eq(payoutAccounts.id, account.id));
    const [held] = await buildPayouts(WEEK, now);

    const [next] = await buildPayouts(NEXT_WEEK, now);

    expect(next!.adjustmentPaise).toBe(0);
    expect((await payoutRow(held!.id)).status).toBe('held');
  });
});

describe('approvePayout', () => {
  test('approve releases each transfer', async () => {
    const { outlet } = await linkedOutlet();
    const one = await sale(outlet.id);
    const two = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();

    await approvePayout(adminUser.id, payout.id, now);

    expect(gateway.transfers.every((t) => t.released)).toBe(true);
    expect((await paymentFor(one.order.id)).transferStatus).toBe('released');
    expect((await paymentFor(two.order.id)).transferStatus).toBe('released');
    expect((await payoutRow(payout.id)).status).toBe('released');
    const [logged] = await auditsFor('payout.approve');
    expect(logged).toMatchObject({ actorId: adminUser.id, entityId: payout.id });
  });

  test('approve blocked while account is on_hold', async () => {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    const payout = await built();
    await db.update(payoutAccounts).set({ status: 'on_hold' }).where(eq(payoutAccounts.id, account.id));

    const error = await failure(approvePayout((await admin()).id, payout.id, now));

    expect(error).toMatchObject({ code: 'account_on_hold', status: 409 });
    expect(gateway.transfers[0]!.released).toBe(false);
    expect((await payoutRow(payout.id)).status).toBe('draft');
  });

  test('only a draft can be approved', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    const payout = await built();
    const adminUser = await admin();
    await approvePayout(adminUser.id, payout.id, now);

    expect(await failure(approvePayout(adminUser.id, payout.id, now))).toMatchObject({ code: 'invalid_state', status: 409 });

    await db.update(payouts).set({ status: 'held' }).where(eq(payouts.id, payout.id));
    expect((await failure(approvePayout(adminUser.id, payout.id, now)))?.code).toBe('invalid_state');
  });

  test('an unknown payout is a 404', async () => {
    const adminUser = await admin();
    expect((await failure(approvePayout(adminUser.id, 'nonsense', now)))?.status).toBe(404);
    expect((await failure(approvePayout(adminUser.id, '00000000-0000-4000-8000-000000000000', now)))?.status).toBe(404);
  });

  test('a release that fails leaves a draft, and a retry skips the ones done', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(gateway, 'releaseTransfer')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('Gateway down'));

    const error = await failure(approvePayout(adminUser.id, payout.id, now));

    expect(error).toMatchObject({ code: 'release_incomplete', status: 502 });
    expect((await payoutRow(payout.id)).status).toBe('draft');
    expect(gateway.transfers.filter((t) => t.released)).toHaveLength(1);

    spy.mockClear();
    spy.mockImplementation(real);
    await approvePayout(adminUser.id, payout.id, now);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(gateway.transfers.every((t) => t.released)).toBe(true);
    expect((await payoutRow(payout.id)).status).toBe('released');
  });

  test('an order whose transfer was reversed after the build comes off the payout', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    const refunded = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    expect(payout.grossPaise).toBe(29800);

    await adminRefund(adminUser.id, refunded.order.id, { amountPaise: 14900, chargedTo: 'vendor' }, now);
    await processRefunds(now);
    expect((await paymentFor(refunded.order.id)).transferStatus).toBe('reversed');

    await approvePayout(adminUser.id, payout.id, now);

    expect(await payoutRow(payout.id)).toMatchObject({
      status: 'released',
      grossPaise: 14900,
      commissionPaise: 2980,
      feesPaise: 300,
      netPaise: 11620,
    });
    expect((await getOrderRow(refunded.order.id)).payoutId).toBeNull();
    expect(gateway.transfers.filter((t) => t.released)).toHaveLength(1);
  });

  test('an unsent reversing refund stops the approval until it has gone', async () => {
    const { outlet } = await linkedOutlet();
    const refunded = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    await adminRefund(adminUser.id, refunded.order.id, { amountPaise: 14900, chargedTo: 'vendor' }, now);

    expect(await failure(approvePayout(adminUser.id, payout.id, now))).toMatchObject({ code: 'refund_pending', status: 409 });
    expect(gateway.transfers[0]!.released).toBe(false);
  });

  test('a refund that read on_hold just before the mark stops reversing, and becomes an adjustment', async () => {
    const { outlet } = await linkedOutlet();
    const refunded = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(gateway, 'releaseTransfer').mockImplementation(async (id) => {
      await real(id);
      await adminRefund(adminUser.id, refunded.order.id, { amountPaise: 14900, chargedTo: 'vendor' }, now);
    });

    await approvePayout(adminUser.id, payout.id, now);

    const [refund] = await refundsFor(refunded.order.id);
    expect(refund!.reverseTransfer).toBe(false);
    expect((await paymentFor(refunded.order.id)).transferStatus).toBe('released');

    gateway.refundStatus = 'processed';
    await processRefunds(now);
    const [next] = await buildPayouts(NEXT_WEEK, now);
    expect(next!.adjustmentPaise).toBe(-14900);
  });

  test('a reversal sent before the mark is flagged, as a released transfer cannot be taken back here', async () => {
    const { outlet } = await linkedOutlet();
    const refunded = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(gateway, 'releaseTransfer').mockImplementation(async (id) => {
      await real(id);
      await adminRefund(adminUser.id, refunded.order.id, { amountPaise: 14900, chargedTo: 'vendor' }, now);
      await db.update(refunds).set({ sendingAt: now.toISOString() });
    });

    await approvePayout(adminUser.id, payout.id, now);

    const flags = await auditsFor('transfer.reversal_after_release');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail).toMatchObject({ orderId: refunded.order.id });
  });

  test('approving a payout also releases the transfers of a negative payout it carried', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    const adminUser = await admin();
    await approvePayout(adminUser.id, (await built()).id, now);
    await addRefund(first.order, first.payment, 14900);
    const week2 = await sale(outlet.id, { serviceDate: '2026-11-10' });
    const negative = await built(NEXT_WEEK);
    expect(negative.status).toBe('held');
    const week3 = await sale(outlet.id, { serviceDate: '2026-11-17' });
    const next = await built(WEEK_AFTER);

    await approvePayout(adminUser.id, next.id, now);

    expect((await paymentFor(week2.order.id)).transferStatus).toBe('released');
    expect((await paymentFor(week3.order.id)).transferStatus).toBe('released');
  });
});

describe('settling an adjustment', () => {
  const remainders = (ids: string[]) =>
    gateway.transfers.filter((t) => ids.includes(t.id)).reduce((sum, t) => sum + t.remainingPaise, 0);
  const releasedFrom = (start: number) =>
    gateway.transfers.slice(start).filter((t) => t.released).reduce((sum, t) => sum + t.remainingPaise, 0);

  test('what is released equals the net exactly, taken from the largest transfer first', async () => {
    const { outlet } = await linkedOutlet();
    const small = await sale(outlet.id, { pricePaise: 10000, feePaise: 200 });
    const large = await sale(outlet.id, { pricePaise: 20000, feePaise: 400 });
    await addRefund(small.order, small.payment, 1234);
    const adminUser = await admin();
    const payout = await built();
    expect(payout).toMatchObject({ adjustmentPaise: -1234, netPaise: 7800 + 15600 - 1234 });

    await approvePayout(adminUser.id, payout.id, now);

    expect(releasedFrom(0)).toBe(payout.netPaise);
    expect(gateway.transferReversals).toHaveLength(1);
    expect(gateway.transferReversals[0]).toMatchObject({
      transferId: (await paymentFor(large.order.id)).razorpayTransferId,
      amountPaise: 1234,
      idempotencyKey: `reversal-${payout.id}-${large.payment.id}`,
    });
    expect((await paymentFor(large.order.id)).reversedPaise).toBe(1234);
    expect((await paymentFor(small.order.id)).reversedPaise).toBe(0);
    expect(await payoutRow(payout.id)).toMatchObject({ status: 'released', netPaise: 22166 });
  });

  test('an adjustment bigger than one transfer spreads to the next, and a transfer used up is not released', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    const second = await sale(outlet.id);
    await addRefund(first.order, first.payment, 12000);
    const adminUser = await admin();
    const payout = await built();
    expect(payout.netPaise).toBe(23240 - 12000);
    const realRelease = vi.spyOn(gateway, 'releaseTransfer');

    await approvePayout(adminUser.id, payout.id, now);

    expect(gateway.transferReversals.map((r) => r.amountPaise)).toEqual([11620, 380]);
    expect(realRelease).toHaveBeenCalledTimes(1);
    expect(releasedFrom(0)).toBe(payout.netPaise);
    expect((await paymentFor(first.order.id)).transferStatus).toBe('released');
    expect((await paymentFor(second.order.id)).transferStatus).toBe('released');
  });

  test('money released over the weeks equals what the vendor earned, through a carried negative', async () => {
    const { outlet } = await linkedOutlet();
    const adminUser = await admin();
    const first = await sale(outlet.id);
    await approvePayout(adminUser.id, (await built()).id, now);
    const paidSoFar = gateway.transfers.length;
    await addRefund(first.order, first.payment, 14900);

    await sale(outlet.id, { serviceDate: '2026-11-10' });
    const negative = await built(NEXT_WEEK);
    expect(negative).toMatchObject({ netPaise: -3280, status: 'held' });
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const next = await built(WEEK_AFTER);
    expect(next).toMatchObject({ adjustmentPaise: -3280, netPaise: 8340 });

    await approvePayout(adminUser.id, next.id, now);

    const later = gateway.transfers.slice(paidSoFar);
    expect(remainders(later.map((t) => t.id))).toBe(next.netPaise);
    expect(later.filter((t) => t.remainingPaise > 0).every((t) => t.released)).toBe(true);
    // Earned 3 x 11620 less the 14900 refund, and that is what left in all.
    expect(remainders(gateway.transfers.map((t) => t.id))).toBe(3 * 11620 - 14900);
  });

  test('a reversal that fails leaves a draft, and a retry never reverses twice', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    await sale(outlet.id);
    await addRefund(first.order, first.payment, 12000);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.reverseTransferPartial.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(gateway, 'reverseTransferPartial')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('Gateway down'));

    expect(await failure(approvePayout(adminUser.id, payout.id, now))).toMatchObject({ code: 'release_incomplete' });
    expect((await payoutRow(payout.id)).status).toBe('draft');
    expect(gateway.transfers.some((t) => t.released)).toBe(false);

    spy.mockImplementation(real);
    await approvePayout(adminUser.id, payout.id, now);

    expect(gateway.transferReversals).toHaveLength(2);
    expect(releasedFrom(0)).toBe(payout.netPaise);
  });

  test('a release that fails after settling reverses nothing more on retry', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    await sale(outlet.id);
    await addRefund(first.order, first.payment, 2000);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(gateway, 'releaseTransfer')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('Gateway down'));

    expect(await failure(approvePayout(adminUser.id, payout.id, now))).toMatchObject({ code: 'release_incomplete' });
    spy.mockImplementation(real);
    await approvePayout(adminUser.id, payout.id, now);

    expect(gateway.transferReversals).toHaveLength(1);
    expect(releasedFrom(0)).toBe(payout.netPaise);
    expect((await payoutRow(payout.id)).status).toBe('released');
  });

  test('a lost answer goes again on the same key, and is taken once', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    await addRefund(first.order, first.payment, 2000);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.reverseTransferPartial.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(gateway, 'reverseTransferPartial').mockImplementationOnce(async (id, paise, key) => {
      await real(id, paise, key);
      throw new Error('Gateway timed out');
    });

    await failure(approvePayout(adminUser.id, payout.id, now));
    await approvePayout(adminUser.id, payout.id, now);

    expect(gateway.transferReversals).toHaveLength(1);
    expect((await paymentFor(first.order.id)).reversedPaise).toBe(2000);
    expect(releasedFrom(0)).toBe(payout.netPaise);
  });

  test('transfers that cannot cover the adjustment leave the payout held, to carry forward', async () => {
    const { outlet } = await linkedOutlet();
    const kept = await sale(outlet.id);
    const lost = await sale(outlet.id);
    await addRefund(kept.order, kept.payment, 12000);
    const adminUser = await admin();
    const payout = await built();
    expect(payout).toMatchObject({ netPaise: 23240 - 12000, status: 'draft' });
    await adminRefund(adminUser.id, lost.order.id, { amountPaise: 14900, chargedTo: 'vendor' }, now);
    await processRefunds(now);

    const error = await failure(approvePayout(adminUser.id, payout.id, now));

    expect(error).toMatchObject({ code: 'payout_negative', status: 409 });
    expect(await payoutRow(payout.id)).toMatchObject({ status: 'held', netPaise: 11620 - 12000 });
    expect(gateway.transferReversals).toEqual([]);
    expect(gateway.transfers.some((t) => t.released)).toBe(false);

    await sale(outlet.id, { serviceDate: '2026-11-10' });
    const next = await built(NEXT_WEEK);
    expect(next.adjustmentPaise).toBe(-380);
  });

  test('the fake refuses to reverse more than a transfer has left', async () => {
    const { id } = await gateway.createTransfer({ paymentId: 'p', accountId: 'a', amountPaise: 100, idempotencyKey: 'k' });

    await gateway.reverseTransferPartial(id, 60, 'r1');

    expect((await failure(gateway.reverseTransferPartial(id, 41, 'r2')))?.name).toBe('GatewayRefusedError');
    expect(gateway.transfers[0]!.remainingPaise).toBe(40);
  });
});

describe('the account an order belongs to', () => {
  test('no transfer goes to an account on hold, and the order waits for the new linked account', async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    const { order } = await sale(outlet.id);
    await updatePayoutAccount(owner.id, account.id, bankChange, now);

    expect(await createTransfers(now)).toBe(0);
    expect(gateway.transfers).toEqual([]);

    await verifyPayoutAccount((await admin()).id, account.id, now);
    expect(await createTransfers(now)).toBe(0);

    await syncLinkedAccounts(now);
    expect(await createTransfers(now)).toBe(1);
    expect(gateway.transfers[0]!.accountId).toBe(gateway.linkedAccounts[0]!.id);
    expect((await paymentFor(order.id)).transferStatus).toBe('on_hold');
  });

  test('a reservation records the outlet account, and a franchise switch leaves unpaid orders with the old one', async () => {
    const { account: oldAccount, outlet } = await linkedOutlet();
    const newAccount = await linkedAccount({ brandId: oldAccount.brandId });
    const drop = await makeDrop({ outletId: outlet.id });
    const reserved = await reserveDrop({ dropId: drop.id, userId: (await makeUser()).id, ip: '1.1.1.1' }, new Date('2026-11-02T10:00:00Z'));
    expect(reserved.payoutAccountId).toBe(oldAccount.id);

    const before = await sale(outlet.id);
    const refundedBefore = await sale(outlet.id);
    await addRefund(refundedBefore.order, refundedBefore.payment, 1000);
    await db.update(outlets).set({ payoutAccountId: newAccount.id }).where(eq(outlets.id, outlet.id));
    const after = await sale(outlet.id, { pricePaise: 10000, feePaise: 200 });

    expect(await createTransfers(now)).toBe(3);
    expect((await paymentFor(before.order.id)).razorpayTransferId).toBe(
      gateway.transfers.find((t) => t.accountId === oldAccount.razorpayAccountId)!.id,
    );
    expect(gateway.transfers.filter((t) => t.accountId === newAccount.razorpayAccountId)).toHaveLength(1);

    const built = await buildPayouts(WEEK, now);

    expect(built).toHaveLength(2);
    const oldPayout = built.find((p) => p.payoutAccountId === oldAccount.id)!;
    const newPayout = built.find((p) => p.payoutAccountId === newAccount.id)!;
    expect(oldPayout).toMatchObject({ grossPaise: 29800, adjustmentPaise: -1000 });
    expect(newPayout).toMatchObject({ grossPaise: 10000, adjustmentPaise: 0 });
    expect((await getOrderRow(before.order.id)).payoutId).toBe(oldPayout.id);
    expect((await getOrderRow(after.order.id)).payoutId).toBe(newPayout.id);
  });

  test('earnings follow the order, not the outlet', async () => {
    const { account: oldAccount, outlet } = await linkedOutlet();
    const oldOwner = await ownerOf(oldAccount.brandId);
    const newAccount = await linkedAccount();
    await sale(outlet.id);
    await db.update(outlets).set({ payoutAccountId: newAccount.id }).where(eq(outlets.id, outlet.id));

    expect((await getEarnings(oldOwner.id, oldAccount.id)).thisWeek.orders).toBe(1);
  });

  test('an expired order sold again belongs to whoever holds the outlet by then', async () => {
    const { account: oldAccount, outlet } = await linkedOutlet();
    const newAccount = await linkedAccount({ brandId: oldAccount.brandId });
    const drop = await makeDrop({ outletId: outlet.id, pricePaise: 10000 });
    const reservedAt = new Date('2026-11-02T10:00:00Z');
    const order = await reserveDrop({ dropId: drop.id, userId: (await makeUser()).id, ip: '1.1.1.1' }, reservedAt);
    const payment = await makePayment({ orderId: order.id });
    await expireHolds(new Date(reservedAt.getTime() + 7 * MINUTES));
    await db.update(outlets).set({ payoutAccountId: newAccount.id }).where(eq(outlets.id, outlet.id));

    const settled = await applyCapture(
      {
        id: `pay_late_${++seq}`,
        orderId: payment.razorpayOrderId,
        status: 'captured',
        amountPaise: 10000,
        feePaise: 236,
        method: 'upi',
      },
      new Date(reservedAt.getTime() + 8 * MINUTES),
    );

    expect(settled).toBe(true);
    expect(await getOrderRow(order.id)).toMatchObject({ status: 'paid', payoutAccountId: newAccount.id });
  });
});

describe('markPayoutPaid', () => {
  test('sets paid and paid_at, only from released', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();

    expect(await failure(markPayoutPaid(adminUser.id, payout.id, now))).toMatchObject({ code: 'invalid_state', status: 409 });

    await approvePayout(adminUser.id, payout.id, now);
    await markPayoutPaid(adminUser.id, payout.id, now);

    const row = await payoutRow(payout.id);
    expect(row.status).toBe('paid');
    expect(new Date(row.paidAt!).toISOString()).toBe(now.toISOString());
    expect((await failure(markPayoutPaid(adminUser.id, payout.id, now)))?.code).toBe('invalid_state');
    expect(await auditsFor('payout.mark_paid')).toHaveLength(1);
  });

  test('a negative payout that was carried on was never money sent, so it cannot be marked paid', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    const adminUser = await admin();
    await approvePayout(adminUser.id, (await built()).id, now);
    await addRefund(first.order, first.payment, 20000 - 5100);
    const negative = await built(NEXT_WEEK);
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    await built(WEEK_AFTER);

    expect((await failure(markPayoutPaid(adminUser.id, negative.id, now)))?.code).toBe('invalid_state');
  });
});

describe('bank details', () => {
  test('changing bank details sets on_hold and is audited', async () => {
    const account = await linkedAccount({ panEncrypted: encrypt('ABCDE1234F') });
    const owner = await ownerOf(account.brandId);

    const updated = await updatePayoutAccount(owner.id, account.id, bankChange, now);

    expect(updated).toMatchObject({ status: 'on_hold', accountLast4: '5544', panLast4: '234F', ifsc: 'ICIC0000002' });
    const row = await accountRow(account.id);
    expect(decrypt(row.accountEncrypted)).toBe(bankChange.accountNumber);
    expect(decrypt(row.panEncrypted)).toBe(bankChange.pan);
    expect(row.razorpayAccountId).toBe(account.razorpayAccountId);

    const [logged] = await auditsFor('payout_account.update');
    expect(logged).toMatchObject({ actorId: owner.id, entityId: account.id });
    const detail = JSON.stringify(logged!.detail);
    expect(detail).not.toContain(bankChange.accountNumber);
    expect(detail).not.toContain(bankChange.pan);
  });

  test('a brand owner cannot change a franchisee account, and bad input is refused', async () => {
    const account = await linkedAccount();
    const outlet = await makeLiveOutlet({ brandId: account.brandId, payoutAccountId: account.id });
    const owner = await ownerOf(account.brandId);
    const franchisee = await franchiseeOf(account.brandId, outlet.id, account.id);

    expect((await failure(updatePayoutAccount(owner.id, account.id, bankChange, now)))?.status).toBe(403);
    const bad = await failure(updatePayoutAccount(franchisee.id, account.id, { ...bankChange, ifsc: 'nope' }, now));
    expect(bad?.code).toBe('invalid_request');
    expect((await accountRow(account.id)).status).toBe('verified');
  });

  test('admin verify clears the linked ID, so the job makes a new one with the new details', async () => {
    const account = await linkedAccount();
    const owner = await ownerOf(account.brandId);
    const adminUser = await admin();
    await updatePayoutAccount(owner.id, account.id, bankChange, now);

    await verifyPayoutAccount(adminUser.id, account.id, now);

    expect(await accountRow(account.id)).toMatchObject({ status: 'verified', razorpayAccountId: null });
    expect(await auditsFor('payout_account.verify')).toHaveLength(1);

    expect(await syncLinkedAccounts(now)).toBe(1);
    expect(gateway.linkedAccounts[0]).toMatchObject({ accountNumber: bankChange.accountNumber, ifsc: 'ICIC0000002' });
    expect((await accountRow(account.id)).razorpayAccountId).toBe(gateway.linkedAccounts[0]!.id);
  });

  test('verify works only on an account on hold', async () => {
    const account = await linkedAccount();
    const adminUser = await admin();

    expect(await failure(verifyPayoutAccount(adminUser.id, account.id, now))).toMatchObject({ code: 'invalid_state', status: 409 });
    expect((await failure(verifyPayoutAccount(adminUser.id, 'nonsense', now)))?.status).toBe(404);
    expect((await accountRow(account.id)).razorpayAccountId).toBe(account.razorpayAccountId);
  });

  test('verify lets a payout held for the account go to draft, but leaves a negative one held', async () => {
    const { account, outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    await createTransfers(now);
    await db.update(payoutAccounts).set({ status: 'on_hold' }).where(eq(payoutAccounts.id, account.id));
    const [held] = await buildPayouts(WEEK, now);
    await addRefund(first.order, first.payment, 5000);
    const [negative] = await buildPayouts(NEXT_WEEK, now);
    const adminUser = await admin();

    await verifyPayoutAccount(adminUser.id, account.id, now);

    expect((await payoutRow(held!.id)).status).toBe('draft');
    expect((await payoutRow(negative!.id)).status).toBe('held');
    await approvePayout(adminUser.id, held!.id, now);
    expect((await payoutRow(held!.id)).status).toBe('released');
  });
});

describe('earnings and statements', () => {
  test('earnings list the payouts and this week so far', async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    await sale(outlet.id);
    const payout = await built();
    const open = await sale(outlet.id, { serviceDate: '2026-11-10' });
    await sale(outlet.id, { serviceDate: '2026-11-11', status: 'paid' });
    await sale(outlet.id, { serviceDate: '2026-11-11', status: 'cancelled' });
    await addRefund(open.order, open.payment, 1000);
    await createTransfers(now);

    const view = await getEarnings(owner.id, account.id);

    expect(view.payouts.map((p) => p.id)).toEqual([payout.id]);
    expect(view.payouts[0]).toMatchObject({ periodStart: WEEK, status: 'draft', netPaise: 11620 });
    expect(view.thisWeek).toEqual({
      orders: 1,
      grossPaise: 14900,
      commissionPaise: 2980,
      feesPaise: 300,
      taxPaise: 0,
      adjustmentPaise: -1000,
      netPaise: 10620,
    });
  });

  test('franchisee cannot read another account earnings', async () => {
    const mine = await linkedOutlet();
    const other = await linkedAccount({ brandId: mine.account.brandId });
    const franchisee = await franchiseeOf(mine.account.brandId, mine.outlet.id, mine.account.id);
    const otherOutlet = await makeLiveOutlet({ brandId: mine.account.brandId, payoutAccountId: other.id });
    const rival = await franchiseeOf(mine.account.brandId, otherOutlet.id, other.id);
    await sale(mine.outlet.id);
    const payout = await built();

    expect((await getEarnings(franchisee.id, mine.account.id)).payouts).toHaveLength(1);
    expect((await failure(getEarnings(franchisee.id, other.id)))?.status).toBe(403);
    expect((await failure(statementCsv(rival.id, payout.id)))?.status).toBe(403);
  });

  test('a brand owner cannot read a franchisee account, and an unknown payout is refused', async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    await franchiseeOf(account.brandId, outlet.id, account.id);

    expect((await failure(getEarnings(owner.id, account.id)))?.status).toBe(403);
    expect((await failure(statementCsv(owner.id, 'nonsense')))?.status).toBe(403);
    expect((await failure(getEarnings(owner.id, 'nonsense')))?.status).toBe(403);
  });

  const rupees = (cell: string) => Math.round(Number(cell) * 100);
  const rowsOf = (csv: string) => csv.trim().split('\r\n');

  test('statement CSV totals equal the payout', async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    await sale(outlet.id, { taxPaise: 100 });
    const refunded = await sale(outlet.id);
    await addRefund(refunded.order, refunded.payment, 2000);
    const payout = await built();

    const csv = await statementCsv(owner.id, payout.id);
    const lines = rowsOf(csv);

    expect(lines[0]).toBe('Order number,Service date,Outlet,Gross,Commission,Fee,Tax,Net');
    expect(lines).toHaveLength(5); // Header, two orders, one adjustment, totals.
    const body = lines.slice(1, -1).map((l) => l.split(','));
    const total = lines.at(-1)!.split(',');
    expect(total[0]).toBe('Total');
    const fields = [payout.grossPaise, payout.commissionPaise, payout.feesPaise, payout.taxPaise, payout.netPaise];
    fields.forEach((expected, i) => {
      expect(rupees(total[3 + i]!)).toBe(expected);
      expect(body.reduce((sum, row) => sum + rupees(row[3 + i]!), 0)).toBe(expected);
    });
    expect(body[2]![7]).toBe('-20.00');
    expect(body[2]![0]).toBe(`SJ-${refunded.order.number.toString()}`);
  });

  test('a carried balance has a row of its own, so the totals still match', async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    const adminUser = await admin();
    const first = await sale(outlet.id);
    await approvePayout(adminUser.id, (await built()).id, now);
    await addRefund(first.order, first.payment, 14900);
    await sale(outlet.id, { serviceDate: '2026-11-10' });
    await built(NEXT_WEEK);
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const payout = await built(WEEK_AFTER);

    const lines = rowsOf(await statementCsv(owner.id, payout.id));

    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe(',,Carried from an earlier payout,0.00,0.00,0.00,0.00,-32.80');
    expect(rupees(lines[3]!.split(',')[7]!)).toBe(payout.netPaise);
  });

  test('CSV text is escaped, and cannot start a formula', async () => {
    const account = await linkedAccount();
    const owner = await ownerOf(account.brandId);
    const outlet = await makeLiveOutlet({
      brandId: account.brandId,
      payoutAccountId: account.id,
      branchName: '=HYPERLINK("x"), Indiranagar',
    });
    await sale(outlet.id);
    const payout = await built();

    const csv = await statementCsv(owner.id, payout.id);

    expect(csv).toContain(`"'=HYPERLINK(""x""), Indiranagar"`);
  });
});

describe('routes', () => {
  test('the vendor reads earnings and a statement', async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    const token = await createSession(owner.id, new Date());
    await sale(outlet.id);
    const payout = await built();

    const earnings = await request(`/api/v1/vendor/earnings?payout_account=${account.id}`, token);
    expect(earnings.status).toBe(200);
    expect(((await earnings.json()) as { payouts: { id: string }[] }).payouts[0]!.id).toBe(payout.id);

    const early = await request(`/api/v1/vendor/payouts/${payout.id}/statement`, token);
    expect(early.status).toBe(409);

    await approvePayout((await admin()).id, payout.id, now);
    const statement = await request(`/api/v1/vendor/payouts/${payout.id}/statement`, token);
    expect(statement.status).toBe(200);
    expect(statement.headers.get('content-type')).toContain('text/csv');
    expect(await statement.text()).toContain('Order number');
  });

  test('earnings need a payout account', async () => {
    const user = await makeUser();
    const token = await createSession(user.id, new Date());

    expect((await request('/api/v1/vendor/earnings', token)).status).toBe(400);
  });

  test('PATCH changes bank details and never returns the encrypted columns', async () => {
    const account = await linkedAccount();
    const owner = await ownerOf(account.brandId);
    const token = await createSession(owner.id, new Date());

    const res = await request(`/api/v1/vendor/payout-accounts/${account.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify(bankChange),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ payoutAccount: { status: 'on_hold', accountLast4: '5544' } });
    expect(body).not.toContain('Encrypted');
    expect(body).not.toContain(bankChange.accountNumber);
  });

  test('an admin lists, approves and marks a payout paid, and verifies an account', async () => {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    const payout = await built();
    const adminUser = await admin();
    const token = await createSession(adminUser.id, new Date());

    const list = await request('/api/v1/admin/payouts?status=draft', token);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { payouts: { id: string; legalName: string }[] };
    expect(listed.payouts).toHaveLength(1);
    expect(listed.payouts[0]).toMatchObject({ id: payout.id, legalName: 'Test Legal Name' });

    expect((await request(`/api/v1/admin/payouts/${payout.id}/approve`, token, { method: 'POST' })).status).toBe(200);
    expect((await request(`/api/v1/admin/payouts/${payout.id}/mark-paid`, token, { method: 'POST' })).status).toBe(200);
    expect((await payoutRow(payout.id)).status).toBe('paid');

    await db.update(payoutAccounts).set({ status: 'on_hold' }).where(eq(payoutAccounts.id, account.id));
    const verify = await request(`/api/v1/admin/payout-accounts/${account.id}/verify`, token, { method: 'POST' });
    expect(verify.status).toBe(200);
    expect((await accountRow(account.id)).status).toBe('verified');
  });

  test('admin routes refuse a vendor', async () => {
    const user = await makeUser();
    const token = await createSession(user.id, new Date());

    expect((await request('/api/v1/admin/payouts', token)).status).toBe(403);
  });

  test('an unknown payout status filter is refused', async () => {
    const adminUser = await admin();
    const token = await createSession(adminUser.id, new Date());

    expect((await request('/api/v1/admin/payouts?status=nonsense', token)).status).toBe(400);
  });
});

describe('money moved equals money owed', () => {
  const released = (from = 0) =>
    gateway.transfers.slice(from).filter((t) => t.released).reduce((sum, t) => sum + t.remainingPaise, 0);

  /** A vendor refund of the whole of a held transfer, which reverses it. */
  async function reverseInFull(adminId: string, orderId: string, amountPaise = 14900) {
    gateway.refundStatus = 'processed';
    await adminRefund(adminId, orderId, { amountPaise, chargedTo: 'vendor' }, now);
    await processRefunds(now);
    expect((await paymentFor(orderId)).transferStatus).toBe('reversed');
  }

  /** O1 paid out and refunded, so week 2 holds O2 at -3280. Returns what week 3 needs. */
  async function negativeSecondWeek() {
    const { outlet } = await linkedOutlet();
    const adminUser = await admin();
    const o1 = await sale(outlet.id);
    await approvePayout(adminUser.id, (await built()).id, now);
    await addRefund(o1.order, o1.payment, 14900);
    const o2 = await sale(outlet.id, { serviceDate: '2026-11-10' });
    const w2 = await built(NEXT_WEEK);
    expect(w2).toMatchObject({ netPaise: -3280, status: 'held' });
    return { outlet, adminId: adminUser.id, o2 };
  }

  /** O4 brings the account back above water: all of it, and no more, goes out. */
  async function expectSquaredByFourthWeek(outletId: string, adminId: string) {
    expect(released()).toBe(11620);
    await sale(outletId, { serviceDate: '2026-11-24' });
    const w4 = await built('2026-11-23');
    expect(w4).toMatchObject({ grossPaise: 14900, adjustmentPaise: -3280, netPaise: 8340, status: 'draft' });

    const before = released();
    await approvePayout(adminId, w4.id, now);

    expect(released() - before).toBe(8340);
    // Earned O1, O3 and O4, less the 14900 refund. O2 was reversed.
    expect(released()).toBe(3 * 11620 - 14900);
  }

  test('a transfer reversed before the next build no longer counts as owed', async () => {
    const { outlet, adminId, o2 } = await negativeSecondWeek();
    await reverseInFull(adminId, o2.order.id);
    await sale(outlet.id, { serviceDate: '2026-11-17' });

    const w3 = await built(WEEK_AFTER);

    // Owed to date is 11620 + 11620 - 14900 = 8340, and 11620 has moved, so the vendor is 3280 over.
    expect(w3).toMatchObject({ grossPaise: 14900, adjustmentPaise: -14900, netPaise: -3280, status: 'held' });
    await expectSquaredByFourthWeek(outlet.id, adminId);
  });

  test('a transfer reversed after the next build is caught when that payout is approved', async () => {
    const { outlet, adminId, o2 } = await negativeSecondWeek();
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const w3 = await built(WEEK_AFTER);
    expect(w3).toMatchObject({ adjustmentPaise: -3280, netPaise: 8340, status: 'draft' });
    await reverseInFull(adminId, o2.order.id);

    const error = await failure(approvePayout(adminId, w3.id, now));

    expect(error).toMatchObject({ code: 'payout_negative', status: 409 });
    expect(await payoutRow(w3.id)).toMatchObject({ adjustmentPaise: -14900, netPaise: -3280, status: 'held' });
    expect(gateway.transferReversals).toEqual([]);
    await expectSquaredByFourthWeek(outlet.id, adminId);
  });

  test('a balance is carried once, however many payouts are open', async () => {
    const { outlet, adminId } = await negativeSecondWeek();
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const w3 = await built(WEEK_AFTER);
    await sale(outlet.id, { serviceDate: '2026-11-24' });
    const w4 = await built('2026-11-23');
    expect(w3.adjustmentPaise).toBe(-3280);
    expect(w4.adjustmentPaise).toBe(0);

    await approvePayout(adminId, w4.id, now);
    await approvePayout(adminId, w3.id, now);

    expect(await payoutRow(w3.id)).toMatchObject({ adjustmentPaise: -3280, netPaise: 8340 });
    expect(await payoutRow(w4.id)).toMatchObject({ adjustmentPaise: 0, netPaise: 11620 });
    expect(released()).toBe(4 * 11620 - 14900);
  });

  test('a retry after a failed release keeps the net, the order, and the money', async () => {
    const { outlet, adminId } = await negativeSecondWeek();
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const w3 = await built(WEEK_AFTER);
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    let fail = true;
    vi.spyOn(gateway, 'releaseTransfer').mockImplementation(async (id) => {
      calls.push(id);
      if (fail && calls.length === 1) {
        fail = false;
        throw new Error('Gateway down');
      }
      await real(id);
    });

    expect(await failure(approvePayout(adminId, w3.id, now))).toMatchObject({ code: 'release_incomplete' });
    await approvePayout(adminId, w3.id, now);

    expect(gateway.transferReversals.map((r) => r.amountPaise)).toEqual([11620, 3280]);
    expect(calls[0]).toBe(calls[1]);
    expect(await payoutRow(w3.id)).toMatchObject({ status: 'released', adjustmentPaise: -3280, netPaise: 8340 });
    expect(released()).toBe(11620 + 8340);
    expect(await auditsFor('payout.mismatch')).toEqual([]);
  });

  /** Week 3 with a 15600 transfer at net 12320, and week 4 at 11620, both draft. */
  async function twoOpenPayouts() {
    const { outlet, adminId } = await negativeSecondWeek();
    await sale(outlet.id, { pricePaise: 20000, feePaise: 400, serviceDate: '2026-11-17' });
    const w3 = await built(WEEK_AFTER);
    await sale(outlet.id, { serviceDate: '2026-11-24' });
    const w4 = await built('2026-11-23');
    expect(w3).toMatchObject({ adjustmentPaise: -3280, netPaise: 12320, status: 'draft' });
    expect(w4).toMatchObject({ adjustmentPaise: 0, netPaise: 11620, status: 'draft' });
    return { accountId: outlet.payoutAccountId!, adminId, w3, w4 };
  }

  // O1 + O2 + O3 + O4 less the 14900 refund.
  const OWED = 11620 + 11620 + 15600 + 11620 - 14900;

  test('a failed approval must be retried before another on the account, and the excess goes once', async () => {
    const { accountId, adminId, w3, w4 } = await twoOpenPayouts();
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(gateway, 'releaseTransfer').mockRejectedValueOnce(new Error('Gateway down'));

    expect(await failure(approvePayout(adminId, w3.id, now))).toMatchObject({ code: 'release_incomplete' });
    expect(gateway.transferReversals.map((r) => r.amountPaise)).toEqual([14900]);
    expect((await payoutRow(w3.id)).approvingAt).not.toBeNull();

    const before = released();
    expect(await failure(approvePayout(adminId, w4.id, now))).toMatchObject({ code: 'approval_in_progress', status: 409 });
    expect(released()).toBe(before);
    expect((await payoutRow(w4.id)).status).toBe('draft');

    spy.mockImplementation(real);
    await approvePayout(adminId, w3.id, now);
    expect(await payoutRow(w3.id)).toMatchObject({ status: 'released', approvingAt: null });
    await approvePayout(adminId, w4.id, now);

    expect(gateway.transferReversals.map((r) => r.amountPaise)).toEqual([14900]);
    expect(released()).toBe(OWED);
    expect(await carriedBalance(db, accountId)).toBe(0);
    expect(await auditsFor('payout.mismatch')).toEqual([]);
  });

  test('two approvals on one account in parallel still move what is owed', async () => {
    const { accountId, adminId, w3, w4 } = await twoOpenPayouts();

    const results = await Promise.allSettled([approvePayout(adminId, w3.id, now), approvePayout(adminId, w4.id, now)]);

    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'approval_in_progress' });
    }
    if ((await payoutRow(w3.id)).status === 'draft') await approvePayout(adminId, w3.id, now);
    if ((await payoutRow(w4.id)).status === 'draft') await approvePayout(adminId, w4.id, now);

    expect(released()).toBe(OWED);
    expect(await carriedBalance(db, accountId)).toBe(0);
  });

  test('the same payout approved twice in parallel moves its net once', async () => {
    const { accountId, adminId, w3, w4 } = await twoOpenPayouts();

    await Promise.allSettled([approvePayout(adminId, w3.id, now), approvePayout(adminId, w3.id, now)]);
    await approvePayout(adminId, w4.id, now);

    expect(gateway.transferReversals.map((r) => r.amountPaise)).toEqual([14900]);
    expect(released()).toBe(OWED);
    expect(await carriedBalance(db, accountId)).toBe(0);
  });

  test('no balance in the vendor favour comes out of failures, retries or holds', async () => {
    const { accountId, adminId, w3, w4 } = await twoOpenPayouts();
    const real = gateway.releaseTransfer.bind(gateway);
    const realReversal = gateway.reverseTransferPartial.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const releases = vi.spyOn(gateway, 'releaseTransfer').mockImplementationOnce(real).mockRejectedValueOnce(new Error('Gateway down'));
    const reversals = vi.spyOn(gateway, 'reverseTransferPartial').mockRejectedValueOnce(new Error('Gateway down'));

    const stages = async () => expect(await carriedBalance(db, accountId)).toBeLessThanOrEqual(0);
    await stages();
    await failure(approvePayout(adminId, w3.id, now));
    await stages();
    reversals.mockImplementation(realReversal);
    await failure(approvePayout(adminId, w3.id, now));
    await stages();
    expect(await failure(holdPayout(adminId, w3.id, 'Vendor not answering', now))).toMatchObject({ code: 'approval_in_progress' });
    await failure(approvePayout(adminId, w4.id, now));
    await stages();
    releases.mockImplementation(real);
    await approvePayout(adminId, w3.id, now);
    await stages();
    await approvePayout(adminId, w4.id, now);

    expect(await carriedBalance(db, accountId)).toBe(0);
    expect(released()).toBe(OWED);
  });

  test('a marked payout that turns negative on retry goes held and frees the account', async () => {
    const { outlet, adminId, o2 } = await negativeSecondWeek();
    const large = await sale(outlet.id, { pricePaise: 20000, feePaise: 400, serviceDate: '2026-11-17' });
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    const w3 = await built(WEEK_AFTER);
    await sale(outlet.id, { serviceDate: '2026-11-24' });
    const w4 = await built('2026-11-23');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(gateway, 'releaseTransfer').mockRejectedValue(new Error('Gateway down'));
    await failure(approvePayout(adminId, w3.id, now));
    spy.mockRestore();
    await reverseInFull(adminId, o2.order.id);
    await reverseInFull(adminId, large.order.id, 20000);

    expect(await failure(approvePayout(adminId, w3.id, now))).toMatchObject({ code: 'payout_negative' });

    expect(await payoutRow(w3.id)).toMatchObject({ status: 'held', approvingAt: null, netPaise: -3280 });
    expect(await auditsFor('payout.mismatch')).toEqual([]);
    await approvePayout(adminId, w4.id, now);
    expect((await payoutRow(w4.id)).netPaise).toBe(8340);
    // O1, the third week's other order and O4, less the 14900 refund.
    expect(released()).toBe(3 * 11620 - 14900);
    expect(await carriedBalance(db, outlet.payoutAccountId!)).toBe(0);
  });

  /** Week 3 whose reversal of 2420 on the second transfer was accepted, with its answer lost. */
  async function lostReversal() {
    const { outlet, adminId, o2 } = await negativeSecondWeek();
    const x = await sale(outlet.id, { pricePaise: 16000, feePaise: 320, serviceDate: '2026-11-17' });
    // A little over O2, so the second reversal always lands here.
    const a = await sale(outlet.id, { pricePaise: 15000, feePaise: 300, serviceDate: '2026-11-17' });
    const w3 = await built(WEEK_AFTER);
    const real = gateway.reverseTransferPartial.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(gateway, 'reverseTransferPartial')
      .mockImplementationOnce(real)
      .mockImplementationOnce(async (id, paise, key) => {
        await real(id, paise, key);
        throw new Error('Gateway timed out');
      });
    expect(await failure(approvePayout(adminId, w3.id, now))).toMatchObject({ code: 'release_incomplete' });
    spy.mockRestore();
    expect(gateway.transferReversals.map((r) => r.amountPaise)).toEqual([12480, 2420]);
    expect((await paymentFor(a.order.id)).reversedPaise).toBe(0);
    return { outlet, adminId, o2, x, a, w3 };
  }

  test('a retry that goes negative takes up a lost reversal first, so the excess is not reversed again', async () => {
    const { outlet, adminId, o2, x, a, w3 } = await lostReversal();
    await reverseInFull(adminId, o2.order.id);
    await reverseInFull(adminId, x.order.id, 16000);

    expect(await failure(approvePayout(adminId, w3.id, now))).toMatchObject({ code: 'payout_negative' });

    expect((await paymentFor(a.order.id)).reversedPaise).toBe(2420);
    expect(await payoutRow(w3.id)).toMatchObject({ status: 'held', approvingAt: null, netPaise: -3200 });
    const [corrected] = await auditsFor('payout.reconciled_gateway');
    expect(corrected).toMatchObject({ entityId: w3.id });
    expect(corrected!.detail).toMatchObject({ paymentId: a.payment.id, reversedPaise: { from: 0, to: 2420 } });

    await sale(outlet.id, { pricePaise: 20000, feePaise: 400, serviceDate: '2026-11-24' });
    const w4 = await built('2026-11-23');
    expect(w4).toMatchObject({ netPaise: 12400, status: 'draft' });
    await approvePayout(adminId, w4.id, now);

    // O1, A and the fourth week's sale, less the 14900 refund.
    const owed = 11620 + 11700 + 15600 - 14900;
    expect(gateway.transferReversals.map((r) => r.amountPaise)).toEqual([12480, 2420, 12480]);
    expect(released()).toBe(owed);
    expect(await carriedBalance(db, outlet.payoutAccountId!)).toBe(0);
    expect(await auditsFor('payout.mismatch')).toEqual([]);
  });

  test('a retry that cannot read the gateway stops, with the mark and the figures as they were', async () => {
    const { adminId, a, w3 } = await lostReversal();
    const spy = vi.spyOn(gateway, 'listPaymentTransfers').mockRejectedValueOnce(new Error('Gateway down'));

    const error = await failure(approvePayout(adminId, w3.id, now));

    expect(error).toMatchObject({ code: 'gateway_unavailable', status: 409 });
    const row = await payoutRow(w3.id);
    expect(row.approvingAt).not.toBeNull();
    expect(row.status).toBe('draft');
    expect((await paymentFor(a.order.id)).reversedPaise).toBe(0);
    expect(gateway.transferReversals).toHaveLength(2);
    expect(released()).toBe(11620);

    spy.mockRestore();
    await approvePayout(adminId, w3.id, now);

    expect((await paymentFor(a.order.id)).reversedPaise).toBe(2420);
    expect(gateway.transferReversals).toHaveLength(2);
    expect(await payoutRow(w3.id)).toMatchObject({ status: 'released', approvingAt: null });
    expect(released()).toBe(11620 + w3.netPaise);
  });

  test('a transfer the gateway does not list stops the retry too', async () => {
    const { adminId, w3 } = await lostReversal();
    vi.spyOn(gateway, 'listPaymentTransfers').mockResolvedValue([]);

    expect(await failure(approvePayout(adminId, w3.id, now))).toMatchObject({ code: 'gateway_unavailable' });
    expect((await payoutRow(w3.id)).approvingAt).not.toBeNull();
  });

  test('a release accepted with its answer lost is taken up by the retry', async () => {
    const { outlet } = await linkedOutlet();
    const one = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(gateway, 'releaseTransfer').mockImplementationOnce(async (id) => {
      await real(id);
      throw new Error('Gateway timed out');
    });

    await failure(approvePayout(adminUser.id, payout.id, now));
    expect((await paymentFor(one.order.id)).transferStatus).toBe('on_hold');
    await approvePayout(adminUser.id, payout.id, now);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await paymentFor(one.order.id)).toMatchObject({ transferStatus: 'released', releasedPayoutId: payout.id });
    expect(await payoutRow(payout.id)).toMatchObject({ status: 'released', approvingAt: null });
    expect((await auditsFor('payout.reconciled_gateway'))[0]!.detail).toMatchObject({
      transferStatus: { from: 'on_hold', to: 'released' },
    });
    expect(await auditsFor('payout.mismatch')).toEqual([]);
  });

  test('a first approval makes no gateway read, and a clean retry audits nothing', async () => {
    const { outlet } = await linkedOutlet();
    await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    const list = vi.spyOn(gateway, 'listPaymentTransfers');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(gateway, 'releaseTransfer').mockRejectedValueOnce(new Error('Gateway down'));

    await failure(approvePayout(adminUser.id, payout.id, now));
    expect(list).not.toHaveBeenCalled();
    spy.mockRestore();
    await approvePayout(adminUser.id, payout.id, now);

    expect(list).toHaveBeenCalledTimes(1);
    expect(await auditsFor('payout.reconciled_gateway')).toEqual([]);
  });

  test('the refusal names the payout to retry, and the admin list shows it', async () => {
    const { adminId, w3, w4 } = await twoOpenPayouts();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(gateway, 'releaseTransfer').mockRejectedValueOnce(new Error('Gateway down'));
    await failure(approvePayout(adminId, w3.id, now));
    const token = await createSession(adminId, new Date());

    const res = await request(`/api/v1/admin/payouts/${w4.id}/approve`, token, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'approval_in_progress', payoutId: w3.id } });
    expect(await failure(holdPayout(adminId, w3.id, 'Reason', now))).toMatchObject({ details: { payoutId: w3.id } });
    const list = (await (await request('/api/v1/admin/payouts', token)).json()) as {
      payouts: { id: string; approvingAt: string | null }[];
    };
    expect(list.payouts.find((p) => p.id === w3.id)!.approvingAt).not.toBeNull();
    expect(list.payouts.find((p) => p.id === w4.id)!.approvingAt).toBeNull();
  });

  test('a retry after some releases went keeps the carried transfers out of the balance', async () => {
    const { outlet, adminId } = await negativeSecondWeek();
    await sale(outlet.id, { pricePaise: 20000, feePaise: 400, serviceDate: '2026-11-17' });
    const w3 = await built(WEEK_AFTER);
    const real = gateway.releaseTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(gateway, 'releaseTransfer').mockImplementationOnce(real).mockRejectedValueOnce(new Error('Gateway down'));

    await failure(approvePayout(adminId, w3.id, now));
    spy.mockImplementation(real);
    await approvePayout(adminId, w3.id, now);

    expect((await payoutRow(w3.id)).netPaise).toBe(w3.netPaise);
    expect(released()).toBe(11620 + w3.netPaise);
    expect(await auditsFor('payout.mismatch')).toEqual([]);
  });

  test('a refund landing in the release loop takes its order off, and what moved still equals the net', async () => {
    const { outlet } = await linkedOutlet();
    const large = await sale(outlet.id, { pricePaise: 20000, feePaise: 400 });
    const small = await sale(outlet.id);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.releaseTransfer.bind(gateway);
    const spy = vi.spyOn(gateway, 'releaseTransfer').mockImplementationOnce(async (id) => {
      await real(id);
      await reverseInFull(adminUser.id, small.order.id);
    });

    await approvePayout(adminUser.id, payout.id, now);

    expect(spy).toHaveBeenCalledTimes(1);
    expect((await getOrderRow(small.order.id)).payoutId).toBeNull();
    expect((await paymentFor(large.order.id)).transferStatus).toBe('released');
    expect((await payoutRow(payout.id)).netPaise).toBe(released());
    expect(await auditsFor('payout.mismatch')).toEqual([]);
  });

  test('a reversal of the transfer that settled the adjustment is audited, and the next payout makes it good', async () => {
    const { outlet } = await linkedOutlet();
    const large = await sale(outlet.id, { pricePaise: 20000, feePaise: 400 });
    const small = await sale(outlet.id);
    await addRefund(small.order, small.payment, 2000);
    const adminUser = await admin();
    const payout = await built();
    const real = gateway.reverseTransferPartial.bind(gateway);
    vi.spyOn(gateway, 'reverseTransferPartial').mockImplementationOnce(async (id, paise, key) => {
      const reversal = await real(id, paise, key);
      await reverseInFull(adminUser.id, large.order.id, 20000);
      return reversal;
    });

    await approvePayout(adminUser.id, payout.id, now);

    // The 2000 came off the transfer that has now gone, so 11620 moved against a net of 9620.
    expect(released()).toBe(11620);
    expect((await payoutRow(payout.id)).netPaise).toBe(9620);
    const [flag] = await auditsFor('payout.mismatch');
    expect(flag).toMatchObject({ entityId: payout.id });
    expect(flag!.detail).toMatchObject({ movedPaise: 11620, netPaise: 9620, differencePaise: 2000 });

    await sale(outlet.id, { serviceDate: '2026-11-10' });
    const next = await built(NEXT_WEEK);
    expect(next).toMatchObject({ adjustmentPaise: -2000, netPaise: 9620 });
    await approvePayout(adminUser.id, next.id, now);
    expect(released()).toBe(11620 + 11620 - 2000);
  });
});

describe('a transfer stranded by a lost claim', () => {
  const later = new Date(now.getTime() + 6 * MINUTES);

  async function paidSale() {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    const { order, payment } = await sale(outlet.id, { status: 'paid' });
    return { account, owner, order, payment };
  }

  test('timeout then cancel: the transfer is found, reversed in full, recorded and flagged', async () => {
    const { owner, order, payment } = await paidSale();
    const real = gateway.createTransfer.bind(gateway);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(gateway, 'createTransfer').mockImplementationOnce(async (a) => {
      await real(a);
      throw new Error('Gateway timed out');
    });
    await createTransfers(now);
    await cancelOrder(owner.id, order.id, 'ran_out', now);

    // Too soon: the claim may still be in flight.
    await createTransfers(new Date(now.getTime() + MINUTES));
    expect(gateway.transfers[0]!.remainingPaise).toBe(11620);

    await createTransfers(later);

    expect(gateway.transfers[0]!.remainingPaise).toBe(0);
    expect(await paymentFor(order.id)).toMatchObject({
      transferStatus: 'reversed',
      razorpayTransferId: gateway.transfers[0]!.id,
      transferPaise: 11620,
      reversedPaise: 11620,
      transferClaimedAt: null,
    });
    const [flag] = await auditsFor('transfer.orphaned');
    expect(flag).toMatchObject({ entityId: payment.id });
    expect(flag!.detail).toMatchObject({ orderId: order.id, razorpayTransferId: gateway.transfers[0]!.id, reversedPaise: 11620 });

    await createTransfers(new Date(later.getTime() + 6 * MINUTES));
    expect(gateway.transferReversals).toHaveLength(1);
    expect(await auditsFor('transfer.orphaned')).toHaveLength(1);
  });

  test('crash then cancel: a transfer no run ever saved is found the same way', async () => {
    const { account, owner, order, payment } = await paidSale();
    await db.update(payments).set({ transferClaimedAt: now.toISOString() }).where(eq(payments.id, payment.id));
    await gateway.createTransfer({
      paymentId: payment.razorpayPaymentId!,
      accountId: account.razorpayAccountId!,
      amountPaise: 11620,
      idempotencyKey: `transfer-${payment.id}`,
    });
    await cancelOrder(owner.id, order.id, 'ran_out', now);

    await createTransfers(later);

    expect(gateway.transfers[0]!.remainingPaise).toBe(0);
    expect((await paymentFor(order.id)).transferStatus).toBe('reversed');
    expect(await auditsFor('transfer.orphaned')).toHaveLength(1);
  });

  test('a transfer already reversed at the gateway is recorded and flagged once', async () => {
    const { account, owner, order, payment } = await paidSale();
    await db.update(payments).set({ transferClaimedAt: now.toISOString() }).where(eq(payments.id, payment.id));
    const { id } = await gateway.createTransfer({
      paymentId: payment.razorpayPaymentId!,
      accountId: account.razorpayAccountId!,
      amountPaise: 11620,
      idempotencyKey: `transfer-${payment.id}`,
    });
    await gateway.reverseTransferPartial(id, 11620, 'an-earlier-sweep');
    await cancelOrder(owner.id, order.id, 'ran_out', now);

    await createTransfers(later);

    expect(await paymentFor(order.id)).toMatchObject({ transferStatus: 'reversed', razorpayTransferId: id, transferClaimedAt: null });
    expect(gateway.transferReversals).toHaveLength(1);
    const flags = await auditsFor('transfer.orphaned');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail).toMatchObject({ orderId: order.id, razorpayTransferId: id });
  });

  test('a payment already flagged is not flagged again', async () => {
    const { account, owner, order, payment } = await paidSale();
    await db.update(payments).set({ transferClaimedAt: now.toISOString() }).where(eq(payments.id, payment.id));
    await gateway.createTransfer({
      paymentId: payment.razorpayPaymentId!,
      accountId: account.razorpayAccountId!,
      amountPaise: 11620,
      idempotencyKey: `transfer-${payment.id}`,
    });
    await cancelOrder(owner.id, order.id, 'ran_out', now);
    await db.insert(auditLog).values({ action: 'transfer.orphaned', entity: 'payment', entityId: payment.id });

    await createTransfers(later);

    expect((await paymentFor(order.id)).transferStatus).toBe('reversed');
    expect(await auditsFor('transfer.orphaned')).toHaveLength(1);
  });

  test('a claim that never reached the gateway is just cleared', async () => {
    const { owner, order, payment } = await paidSale();
    await db.update(payments).set({ transferClaimedAt: now.toISOString() }).where(eq(payments.id, payment.id));
    await cancelOrder(owner.id, order.id, 'ran_out', now);

    await createTransfers(later);

    expect(await paymentFor(order.id)).toMatchObject({ transferStatus: 'none', transferClaimedAt: null });
    expect(await auditsFor('transfer.orphaned')).toEqual([]);
  });

  test('a whole vendor refund is also no longer eligible', async () => {
    const { order, payment } = await paidSale();
    await db.update(payments).set({ transferClaimedAt: now.toISOString() }).where(eq(payments.id, payment.id));
    await addRefund(order, payment, 14900, { status: 'pending' });

    await createTransfers(later);

    expect((await paymentFor(order.id)).transferClaimedAt).toBeNull();
  });

  test('a stale claim on an order still eligible goes the usual way, and a gateway failure waits', async () => {
    const { order, payment } = await paidSale();
    await db.update(payments).set({ transferClaimedAt: now.toISOString() }).where(eq(payments.id, payment.id));
    expect(await createTransfers(later)).toBe(1);
    expect((await paymentFor(order.id)).transferStatus).toBe('on_hold');

    const stuck = await paidSale();
    await db.update(payments).set({ transferClaimedAt: now.toISOString() }).where(eq(payments.id, stuck.payment.id));
    await cancelOrder(stuck.owner.id, stuck.order.id, 'ran_out', now);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(gateway, 'listPaymentTransfers').mockRejectedValueOnce(new Error('Gateway down'));

    await createTransfers(later);
    expect((await paymentFor(stuck.order.id)).transferClaimedAt).not.toBeNull();

    await createTransfers(new Date(later.getTime() + 6 * MINUTES));
    expect((await paymentFor(stuck.order.id)).transferClaimedAt).toBeNull();
  });

  test('the fake lists what is left of each transfer', async () => {
    const { id } = await gateway.createTransfer({ paymentId: 'p', accountId: 'a', amountPaise: 100, idempotencyKey: 'k' });
    expect(await gateway.listPaymentTransfers('p')).toEqual([{ id, amountPaise: 100, status: 'on_hold' }]);

    await gateway.reverseTransferPartial(id, 100, 'r');

    expect(await gateway.listPaymentTransfers('p')).toEqual([{ id, amountPaise: 0, status: 'reversed' }]);
    expect(await gateway.listPaymentTransfers('other')).toEqual([]);
  });
});

describe('holding a payout', () => {
  async function draftPayout() {
    const { account, outlet } = await linkedOutlet();
    await sale(outlet.id);
    return { account, payout: await built(), adminId: (await admin()).id };
  }

  test('a draft goes held with a reason, and back to draft', async () => {
    const { payout, adminId } = await draftPayout();

    await holdPayout(adminId, payout.id, 'Vendor not answering', now);

    expect(await payoutRow(payout.id)).toMatchObject({ status: 'held', holdReason: 'Vendor not answering' });
    expect((await auditsFor('payout.hold'))[0]!.detail).toMatchObject({ reason: 'Vendor not answering' });
    expect((await failure(approvePayout(adminId, payout.id, now)))?.code).toBe('invalid_state');

    await unholdPayout(adminId, payout.id, now);

    expect(await payoutRow(payout.id)).toMatchObject({ status: 'draft', holdReason: null });
    expect(await auditsFor('payout.unhold')).toHaveLength(1);
    await approvePayout(adminId, payout.id, now);
  });

  test('a reason is needed, and only a draft can be held', async () => {
    const { payout, adminId } = await draftPayout();

    expect((await failure(holdPayout(adminId, payout.id, ' ', now)))?.code).toBe('invalid_request');
    expect((await failure(unholdPayout(adminId, payout.id, now)))?.code).toBe('invalid_state');
    await approvePayout(adminId, payout.id, now);
    expect((await failure(holdPayout(adminId, payout.id, 'Too late', now)))?.code).toBe('invalid_state');
    expect((await failure(holdPayout(adminId, 'nonsense', 'x', now)))?.status).toBe(404);
  });

  test('a held negative payout cannot be moved back', async () => {
    const { outlet } = await linkedOutlet();
    const first = await sale(outlet.id);
    const adminId = (await admin()).id;
    await approvePayout(adminId, (await built()).id, now);
    await addRefund(first.order, first.payment, 5000);
    const negative = await built(NEXT_WEEK);

    expect((await failure(unholdPayout(adminId, negative.id, now)))?.code).toBe('invalid_state');
  });

  test('verifying the account leaves an admin hold in place, and the next build leaves it out', async () => {
    const { account, payout, adminId } = await draftPayout();
    const [outlet] = await db.select().from(outlets).where(eq(outlets.payoutAccountId, account.id));
    await holdPayout(adminId, payout.id, 'Vendor not answering', now);
    await db.update(payoutAccounts).set({ status: 'on_hold' }).where(eq(payoutAccounts.id, account.id));

    await verifyPayoutAccount(adminId, account.id, now);
    expect((await payoutRow(payout.id)).status).toBe('held');

    await syncLinkedAccounts(now).catch(() => 0);
    await db.update(payoutAccounts).set({ razorpayAccountId: `acc_${++seq}` }).where(eq(payoutAccounts.id, account.id));
    await sale(outlet!.id, { serviceDate: '2026-11-10' });
    const next = await built(NEXT_WEEK);
    expect(next).toMatchObject({ adjustmentPaise: 0, netPaise: 11620 });
  });

  test('the routes hold and unhold', async () => {
    const { payout, adminId } = await draftPayout();
    const token = await createSession(adminId, new Date());

    const hold = (body: unknown) =>
      request(`/api/v1/admin/payouts/${payout.id}/hold`, token, { method: 'POST', body: JSON.stringify(body) });
    expect((await hold({})).status).toBe(400);
    expect((await hold({ reason: 'Vendor gone quiet' })).status).toBe(200);
    expect((await payoutRow(payout.id)).status).toBe('held');

    expect((await request(`/api/v1/admin/payouts/${payout.id}/unhold`, token, { method: 'POST' })).status).toBe(200);
    expect((await payoutRow(payout.id)).status).toBe('draft');
  });
});

describe('statements after a reversal', () => {
  test("a draft's totals still match it after a reversal", async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    await sale(outlet.id);
    const reversed = await sale(outlet.id);
    const payout = await built();
    await db.update(payments).set({ transferStatus: 'reversed' }).where(eq(payments.id, reversed.payment.id));

    const lines = (await statementCsv(owner.id, payout.id)).trim().split('\r\n');

    expect(lines).toHaveLength(4);
    const total = lines.at(-1)!.split(',');
    expect(Math.round(Number(total[3]) * 100)).toBe(payout.grossPaise);
    expect(Math.round(Number(total[7]) * 100)).toBe(payout.netPaise);
  });

  test('this week so far includes a negative balance waiting to be carried', async () => {
    const { account, outlet } = await linkedOutlet();
    const owner = await ownerOf(account.brandId);
    const adminId = (await admin()).id;
    const first = await sale(outlet.id);
    await approvePayout(adminId, (await built()).id, now);
    await addRefund(first.order, first.payment, 14900);
    await sale(outlet.id, { serviceDate: '2026-11-10' });
    await built(NEXT_WEEK);
    await sale(outlet.id, { serviceDate: '2026-11-17' });
    await createTransfers(now);

    const { thisWeek } = await getEarnings(owner.id, account.id);

    expect(thisWeek).toMatchObject({ orders: 1, grossPaise: 14900, adjustmentPaise: -3280, netPaise: 8340 });
  });
});

describe('a whole week', () => {
  test('reconciles to the paisa', async () => {
    const { outlet } = await linkedOutlet();
    const adminUser = await admin();
    // Prices that round differently, a tax, a no-show and a part refund.
    await sale(outlet.id, { pricePaise: 14999, feePaise: 354, serviceDate: '2026-11-02' });
    await sale(outlet.id, { pricePaise: 12345, feePaise: 291, taxPaise: 57, serviceDate: '2026-11-05', status: 'no_show' });
    const part = await sale(outlet.id, { pricePaise: 9999, feePaise: 236, serviceDate: '2026-11-08' });
    await addRefund(part.order, part.payment, 1234);

    const payout = await built();

    const nets = await db
      .select({ paise: payments.transferPaise })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(eq(orders.payoutId, payout.id));
    const transferred = nets.reduce((sum, n) => sum + n.paise!, 0);
    expect(payout.grossPaise).toBe(14999 + 12345 + 9999);
    expect(payout.commissionPaise).toBe(3000 + 2469 + 2000);
    expect(payout.feesPaise).toBe(354 + 291 + 236);
    expect(payout.taxPaise).toBe(57);
    expect(payout.adjustmentPaise).toBe(-1234);
    expect(payout.netPaise).toBe(transferred - 1234);
    expect(payout.netPaise).toBe(
      payout.grossPaise - payout.commissionPaise - payout.feesPaise - payout.taxPaise + payout.adjustmentPaise,
    );

    await approvePayout(adminUser.id, payout.id, now);
    await markPayoutPaid(adminUser.id, payout.id, now);
    expect((await payoutRow(payout.id)).status).toBe('paid');
  });
});
