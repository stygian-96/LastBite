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
import { approvePayout, markPayoutPaid, verifyPayoutAccount } from '../../src/modules/payouts/approve.js';
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
