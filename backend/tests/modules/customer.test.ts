import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { auditLog, follows, issues, notifications, orders, payments, refunds, sessions, users } from '../../src/db/schema.js';
import { FakeMessenger, setMessenger } from '../../src/integrations/messaging.js';
import { FakeGateway, setGateway } from '../../src/integrations/payments.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import {
  adminRefund,
  changeUserPhone,
  getOutletStats,
  listAdminOrders,
  listIssues,
} from '../../src/modules/admin/support.js';
import { sendOtp, verifyOtp } from '../../src/modules/auth/otp.js';
import { createSession, getSessionUser } from '../../src/modules/auth/session.js';
import { rateOrder, reportIssue } from '../../src/modules/customer/feedback.js';
import { follow, listFollowing, unfollow } from '../../src/modules/customer/follow.js';
import { deleteAccount, getProfile, updateProfile } from '../../src/modules/customer/profile.js';
import { processRefunds } from '../../src/modules/refunds/process.js';
import { app } from '../../src/app.js';
import { makeDrop, makeLiveOutlet, makeOrder, makePaidOrder, makeUser } from '../helpers/factories.js';
import { getOrderRow, refundsFor, resetDb } from '../helpers/db.js';

const NOW = new Date('2026-11-02T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

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

async function expectError(p: Promise<unknown>, code: string, status: number) {
  const e = await failure(p);
  expect(e).toBeInstanceOf(ApiError);
  expect(e).toMatchObject({ code, status });
}

const collected = (userId: string) =>
  makePaidOrder({ userId, status: 'collected', collectedAt: NOW.toISOString() });
const auditRows = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const paymentFor = async (orderId: string) =>
  (await db.select().from(payments).where(eq(payments.orderId, orderId)))[0]!;

/** Sends a request as this user, or with no session if there is no token. */
function api(token: string | undefined, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) {
    headers.cookie = `session=${token}`;
    headers.origin = env().FRONTEND_ORIGIN;
  }
  return app.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function signedIn(o: Parameters<typeof makeUser>[0] = {}) {
  const user = await makeUser(o);
  return { user, token: await createSession(user.id, new Date()) };
}

describe('profile', () => {
  test('shows the profile with bags collected and money saved', async () => {
    const user = await makeUser({ email: 'a@example.com' });
    await collected(user.id);
    const second = await makeDrop({ valuePaise: 50000, pricePaise: 20000 });
    await makePaidOrder({ userId: user.id, dropId: second.id, status: 'collected' });
    await makePaidOrder({ userId: user.id }); // Not collected, so not counted.

    expect(await getProfile(user.id)).toEqual({
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: 'a@example.com',
      whatsappOptIn: true,
      marketingOptIn: false,
      impact: { bagsCollected: 2, moneySavedPaise: 20000 + 30000 },
    });
  });

  test('a new customer has no impact yet', async () => {
    const user = await makeUser();
    expect((await getProfile(user.id)).impact).toEqual({ bagsCollected: 0, moneySavedPaise: 0 });
  });

  test('updates name, email and preferences, and leaves the rest alone', async () => {
    const user = await makeUser({ email: 'old@example.com' });
    const updated = await updateProfile(user.id, { name: ' Asha ', marketingOptIn: true, phone: '+919999999999' });
    expect(updated).toMatchObject({
      name: 'Asha',
      email: 'old@example.com',
      phone: user.phone,
      whatsappOptIn: true,
      marketingOptIn: true,
    });
    expect(await updateProfile(user.id, { whatsappOptIn: false, email: 'new@example.com' })).toMatchObject({
      name: 'Asha',
      email: 'new@example.com',
      whatsappOptIn: false,
    });
  });

  test('an empty update changes nothing', async () => {
    const user = await makeUser();
    expect(await updateProfile(user.id, {})).toMatchObject({ name: user.name });
  });

  test('a bad email or empty name returns 400', async () => {
    const user = await makeUser();
    await expectError(updateProfile(user.id, { email: 'nope' }), 'invalid_request', 400);
    await expectError(updateProfile(user.id, { name: '  ' }), 'invalid_request', 400);
  });

  test('GET and PATCH /me work through the routes, and need a session', async () => {
    const { user, token } = await signedIn();
    expect((await api(undefined, 'GET', '/me')).status).toBe(401);

    const got = await api(token, 'GET', '/me');
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ profile: { id: user.id, impact: { bagsCollected: 0 } } });

    const patched = await api(token, 'PATCH', '/me', { name: 'Ravi' });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ profile: { name: 'Ravi' } });
  });
});

describe('follows', () => {
  test('follow twice stays one row', async () => {
    const user = await makeUser();
    const outlet = await makeLiveOutlet();
    await follow(user.id, outlet.id);
    await follow(user.id, outlet.id);
    expect(await db.select().from(follows).where(eq(follows.userId, user.id))).toHaveLength(1);
  });

  test('unfollow removes the row, and is fine with none there', async () => {
    const user = await makeUser();
    const outlet = await makeLiveOutlet();
    await follow(user.id, outlet.id);
    await unfollow(user.id, outlet.id);
    await unfollow(user.id, outlet.id);
    expect(await listFollowing(user.id)).toEqual([]);
  });

  test('lists followed outlets with their brand', async () => {
    const user = await makeUser();
    const outlet = await makeLiveOutlet({ branchName: 'Indiranagar' });
    await follow(user.id, outlet.id);
    await follow((await makeUser()).id, (await makeLiveOutlet()).id);
    expect(await listFollowing(user.id)).toMatchObject([
      { outletId: outlet.id, branchName: 'Indiranagar', outletSlug: outlet.slug, status: 'live' },
    ]);
    expect((await listFollowing(user.id))[0]!.brandName).toMatch(/^Brand /);
  });

  test('an unknown or hidden outlet cannot be followed', async () => {
    const user = await makeUser();
    await expectError(follow(user.id, randomUUID()), 'not_found', 404);
    await expectError(follow(user.id, 'nope'), 'not_found', 404);
    await expectError(unfollow(user.id, 'nope'), 'not_found', 404);
    const draft = await makeLiveOutlet({ status: 'draft' });
    await expectError(follow(user.id, draft.id), 'not_found', 404);
  });

  test('PUT, DELETE and GET work through the routes', async () => {
    const { token } = await signedIn();
    const outlet = await makeLiveOutlet();
    expect((await api(undefined, 'PUT', `/outlets/${outlet.id}/follow`)).status).toBe(401);
    expect((await api(token, 'PUT', `/outlets/${outlet.id}/follow`)).status).toBe(200);
    const list = await api(token, 'GET', '/me/following');
    expect(await list.json()).toMatchObject({ following: [{ outletId: outlet.id }] });
    expect((await api(token, 'DELETE', `/outlets/${outlet.id}/follow`)).status).toBe(200);
    expect(await (await api(token, 'GET', '/me/following')).json()).toEqual({ following: [] });
  });
});

describe('ratings', () => {
  test('only collected orders can be rated, once', async () => {
    const user = await makeUser();
    const paid = await makePaidOrder({ userId: user.id });
    await expectError(rateOrder(user.id, paid.id, 5), 'not_collected', 409);

    const order = await collected(user.id);
    await rateOrder(user.id, order.id, 4);
    expect((await getOrderRow(order.id)).rating).toBe(4);

    await expectError(rateOrder(user.id, order.id, 2), 'already_rated', 409);
    expect((await getOrderRow(order.id)).rating).toBe(4);
  });

  test("someone else's order is not found", async () => {
    const order = await collected((await makeUser()).id);
    await expectError(rateOrder((await makeUser()).id, order.id, 5), 'not_found', 404);
    await expectError(rateOrder((await makeUser()).id, 'nope', 5), 'not_found', 404);
  });

  test('rating outside 1 to 5 returns 400', async () => {
    const user = await makeUser();
    const order = await collected(user.id);
    for (const stars of [0, 6, 2.5]) await expectError(rateOrder(user.id, order.id, stars), 'invalid_request', 400);

    const token = await createSession(user.id, new Date());
    expect((await api(token, 'POST', `/orders/${order.id}/rating`, { stars: 9 })).status).toBe(400);
    expect((await api(token, 'POST', `/orders/${order.id}/rating`, { stars: 5 })).status).toBe(200);
    expect((await getOrderRow(order.id)).rating).toBe(5);
  });
});

describe('issues', () => {
  test('issue only on your own paid, collected or no-show order', async () => {
    const user = await makeUser();
    const input = { reason: 'quality', description: 'Stale bread' };
    const paid = await makePaidOrder({ userId: user.id });
    const done = await collected(user.id);
    const noShow = await makePaidOrder({ userId: user.id, status: 'no_show' });
    for (const order of [paid, done, noShow]) {
      expect(await reportIssue(user.id, order.id, input)).toMatchObject({
        orderId: order.id,
        reason: 'quality',
        description: 'Stale bread',
        status: 'open',
      });
    }

    for (const status of ['held', 'expired', 'cancelled']) {
      const order = await makeOrder({ userId: user.id, status });
      await expectError(reportIssue(user.id, order.id, input), 'not_reportable', 409);
    }
    await expectError(reportIssue((await makeUser()).id, paid.id, input), 'not_found', 404);
  });

  test('a bad reason returns 400', async () => {
    const user = await makeUser();
    const order = await collected(user.id);
    await expectError(reportIssue(user.id, order.id, { reason: 'bored' }), 'invalid_request', 400);
  });

  test("a photo must be from the caller's own uploads", async () => {
    const user = await makeUser();
    const order = await collected(user.id);
    const mine = `documents/${user.id}/photo.jpg`;
    expect(await reportIssue(user.id, order.id, { reason: 'quality', photoKey: mine })).toMatchObject({ photoKey: mine });

    for (const photoKey of [
      `documents/${randomUUID()}/photo.jpg`,
      `documents/${user.id}/../${randomUUID()}/photo.jpg`,
      `photos/${user.id}/photo.jpg`,
    ]) {
      await expectError(reportIssue(user.id, order.id, { reason: 'quality', photoKey }), 'invalid_request', 400);
    }
  });

  test('POST works through the route', async () => {
    const { user, token } = await signedIn();
    const order = await collected(user.id);
    const res = await api(token, 'POST', `/orders/${order.id}/issues`, { reason: 'bag_not_ready' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ issue: { orderId: order.id, reason: 'bag_not_ready' } });
  });

  test('allergen issues sort first for admin', async () => {
    const user = await makeUser();
    const insert = async (reason: string, createdAt: string, status = 'open') => {
      const order = await collected(user.id);
      const [row] = await db
        .insert(issues)
        .values({ orderId: order.id, userId: user.id, reason, createdAt, status })
        .returning();
      return row!;
    };
    const oldQuality = await insert('quality', daysAgo(5));
    const newAllergen = await insert('allergen', daysAgo(1));
    const newQuality = await insert('other', daysAgo(2));
    const oldAllergen = await insert('allergen', daysAgo(3));
    const closed = await insert('allergen', daysAgo(9), 'resolved');

    const open = await listIssues('open');
    expect(open.map((i) => i.id)).toEqual([oldAllergen.id, newAllergen.id, oldQuality.id, newQuality.id]);
    expect((await listIssues('resolved')).map((i) => i.id)).toEqual([closed.id]);
    await expectError(listIssues('nope'), 'invalid_request', 400);
  });

  test('issues carry a signed photo link and their order', async () => {
    const user = await makeUser();
    const order = await collected(user.id);
    const key = `documents/${user.id}/photo.jpg`;
    await reportIssue(user.id, order.id, { reason: 'quality', photoKey: key });
    await reportIssue(user.id, order.id, { reason: 'other' });

    const [withPhoto, without] = await listIssues('open');
    expect(withPhoto).toMatchObject({ orderNumber: `SJ-${order.number}`, outletId: order.outletId });
    expect(withPhoto!.photoUrl).toContain(key);
    expect(withPhoto!.photoUrl).toContain('expires=');
    expect(without!.photoUrl).toBeNull();
  });
});

describe('adminRefund', () => {
  const refund = (orderId: string, amountPaise: number, chargedTo: 'vendor' | 'platform' = 'vendor', issueId?: string) =>
    adminRefund(adminId, orderId, { amountPaise, chargedTo, issueId }, NOW);
  let adminId: string;

  beforeEach(async () => {
    adminId = (await makeUser({ isAdmin: true })).id;
  });

  test('admin refund cannot exceed the amount paid', async () => {
    const order = await collected((await makeUser()).id);
    await expectError(refund(order.id, 10001), 'refund_too_large', 400);
    expect(await refundsFor(order.id)).toHaveLength(0);
    for (const bad of [0, -1, 1.5]) await expectError(refund(order.id, bad), 'invalid_request', 400);
  });

  test('admin refund cannot exceed what is left after other refunds', async () => {
    const order = await collected((await makeUser()).id);
    const payment = await paymentFor(order.id);
    const earlier = { orderId: order.id, paymentId: payment.id, amountPaise: 8000, chargedTo: 'vendor' };
    await db.insert(refunds).values({ ...earlier, reason: 'vendor_cancelled' });

    await expectError(refund(order.id, 2001), 'refund_too_large', 400);
    await db.update(refunds).set({ status: 'failed' }).where(eq(refunds.paymentId, payment.id));
    await refund(order.id, 10000);
    expect((await refundsFor(order.id)).filter((r) => r.reason === 'issue_resolution')).toHaveLength(1);
  });

  test('a second refund on a payment returns 409, whatever its amount', async () => {
    const order = await collected((await makeUser()).id);
    await refund(order.id, 4000);
    await expectError(refund(order.id, 1000), 'already_refunded', 409);
    await expectError(refund(order.id, 9000), 'already_refunded', 409);
    expect(await refundsFor(order.id)).toMatchObject([{ amountPaise: 4000 }]);
  });

  test('two refunds at once make one, and the other is told so', async () => {
    const order = await collected((await makeUser()).id);
    const results = await Promise.all([failure(refund(order.id, 4000)), failure(refund(order.id, 4000))]);
    expect(results.filter((e) => e === undefined)).toHaveLength(1);
    expect(results.find((e) => e !== undefined)).toMatchObject({ code: 'already_refunded', status: 409 });
    expect(await refundsFor(order.id)).toHaveLength(1);
  });

  test('needs a captured payment that bought the bag', async () => {
    const held = await makeOrder();
    await expectError(refund(held.id, 100), 'not_refundable', 409);
    await expectError(refund(randomUUID(), 100), 'not_found', 404);
    await expectError(refund('nope', 100), 'not_found', 404);

    const late = await makePaidOrder({ status: 'cancelled' });
    const payment = await paymentFor(late.id);
    await db.insert(refunds).values({
      orderId: late.id,
      paymentId: payment.id,
      amountPaise: 10000,
      reason: 'late_payment',
      chargedTo: 'platform',
    });
    await expectError(refund(late.id, 100), 'not_refundable', 409);
  });

  test('admin refund resolves the issue and is audited', async () => {
    const user = await makeUser();
    const order = await collected(user.id);
    const issue = await reportIssue(user.id, order.id, { reason: 'allergen' });

    await refund(order.id, 5000, 'platform', issue.id);

    const [row] = await refundsFor(order.id);
    expect(row).toMatchObject({
      amountPaise: 5000,
      reason: 'issue_resolution',
      chargedTo: 'platform',
      createdBy: adminId,
      status: 'pending',
    });
    expect(new Date(row!.createdAt)).toEqual(NOW);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toMatchObject({ status: 'resolved', resolvedBy: adminId });
    expect(saved!.resolution).toContain('platform');
    expect(await auditRows('refund.create')).toMatchObject([
      {
        actorId: adminId,
        entity: 'refund',
        entityId: row!.id,
        detail: { orderId: order.id, amountPaise: 5000, chargedTo: 'platform', issueId: issue.id },
      },
    ]);
  });

  test('an issue must be open and belong to the order, and a bad one refunds nothing', async () => {
    const user = await makeUser();
    const order = await collected(user.id);
    const other = await reportIssue(user.id, (await collected(user.id)).id, { reason: 'other' });
    await expectError(refund(order.id, 100, 'vendor', other.id), 'not_found', 404);
    await expectError(refund(order.id, 100, 'vendor', randomUUID()), 'not_found', 404);
    await expectError(refund(order.id, 100, 'vendor', 'nope'), 'invalid_request', 400);

    const closed = await reportIssue(user.id, order.id, { reason: 'other' });
    await db.update(issues).set({ status: 'resolved' }).where(eq(issues.id, closed.id));
    await expectError(refund(order.id, 100, 'vendor', closed.id), 'issue_resolved', 409);
    expect(await refundsFor(order.id)).toHaveLength(0);
  });

  test('a refund that is refused leaves the issue open', async () => {
    const user = await makeUser();
    const order = await collected(user.id);
    const issue = await reportIssue(user.id, order.id, { reason: 'other' });
    await expectError(refund(order.id, 10001, 'vendor', issue.id), 'refund_too_large', 400);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!.status).toBe('open');
  });

  test('the reversal is set for a vendor refund of the whole remainder, and sent as saved', async () => {
    const order = await collected((await makeUser()).id);
    const payment = await paymentFor(order.id);
    await db.update(payments).set({ transferStatus: 'on_hold' }).where(eq(payments.id, payment.id));

    await refund(order.id, 10000);

    expect(await refundsFor(order.id)).toMatchObject([{ reverseTransfer: true }]);
    await processRefunds(NOW);
    expect(gateway.refunds).toMatchObject([{ amountPaise: 10000, reverseTransfer: true }]);
    expect((await paymentFor(order.id)).transferStatus).toBe('reversed');
  });

  test('a vendor refund of what is left after a part-refund also reverses', async () => {
    const order = await collected((await makeUser()).id);
    const payment = await paymentFor(order.id);
    await db.insert(refunds).values({
      orderId: order.id,
      paymentId: payment.id,
      amountPaise: 3000,
      reason: 'vendor_cancelled',
      chargedTo: 'vendor',
    });
    await refund(order.id, 7000);
    const row = (await refundsFor(order.id)).find((r) => r.reason === 'issue_resolution');
    expect(row).toMatchObject({ reverseTransfer: true });
  });

  test('a partial or platform refund leaves the held transfer alone', async () => {
    const partial = await collected((await makeUser()).id);
    const platform = await collected((await makeUser()).id);
    for (const order of [partial, platform]) {
      const payment = await paymentFor(order.id);
      await db.update(payments).set({ transferStatus: 'on_hold' }).where(eq(payments.id, payment.id));
    }

    await refund(partial.id, 9999);
    await refund(platform.id, 10000, 'platform');

    expect(gateway.refunds).toHaveLength(0);
    await processRefunds(NOW);
    expect(gateway.refunds.map((r) => r.reverseTransfer)).toEqual([false, false]);
    expect((await paymentFor(partial.id)).transferStatus).toBe('on_hold');
    expect((await paymentFor(platform.id)).transferStatus).toBe('on_hold');
  });

  test('POST /admin/orders/:id/refund is admin only', async () => {
    const order = await collected((await makeUser()).id);
    const body = { amountPaise: 100, chargedTo: 'vendor' };
    const { token: customer } = await signedIn();
    expect((await api(customer, 'POST', `/admin/orders/${order.id}/refund`, body)).status).toBe(403);
    const admin = await createSession(adminId, new Date());
    expect((await api(admin, 'POST', `/admin/orders/${order.id}/refund`, { ...body, chargedTo: 'nobody' })).status).toBe(400);
    expect((await api(admin, 'POST', `/admin/orders/${order.id}/refund`, body)).status).toBe(200);
    expect(await refundsFor(order.id)).toHaveLength(1);
  });
});

describe('deleteAccount', () => {
  test('delete anonymises name and phone, keeps orders and blocks with an active order', async () => {
    const user = await makeUser({ email: 'a@example.com' });
    const done = await collected(user.id);

    const held = await makeOrder({ userId: user.id, status: 'held' });
    await expectError(deleteAccount(user.id, NOW), 'active_order', 409);
    await db.update(orders).set({ status: 'expired' }).where(eq(orders.id, held.id));
    const paid = await makePaidOrder({ userId: user.id });
    await expectError(deleteAccount(user.id, NOW), 'active_order', 409);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0]!.phone).toBe(user.phone);
    await db.update(orders).set({ status: 'no_show' }).where(eq(orders.id, paid.id));

    await deleteAccount(user.id, NOW);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ phone: `deleted:${user.id}`, name: null, email: null });
    expect(new Date(row!.deletedAt!)).toEqual(NOW);
    expect(await getOrderRow(done.id)).toMatchObject({ userId: user.id, status: 'collected' });
    expect(await refundsFor(done.id)).toEqual([]);
    expect((await paymentFor(done.id)).status).toBe('captured');
  });

  test('delete removes follows and sessions, and gives up pending messages', async () => {
    const user = await makeUser();
    const token = await createSession(user.id, new Date());
    await follow(user.id, (await makeLiveOutlet()).id);
    const message = { template: 'otp', variables: {}, channel: 'sms' };
    await db.insert(notifications).values([
      { dedupeKey: 'pending', phone: user.phone, ...message },
      { dedupeKey: 'sent', phone: user.phone, status: 'sent', ...message },
      { dedupeKey: 'other', phone: '+919111111111', ...message },
    ]);

    await deleteAccount(user.id, NOW);

    expect(await db.select().from(follows).where(eq(follows.userId, user.id))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toEqual([]);
    expect(await getSessionUser(token, new Date())).toBeNull();
    const rows = await db.select().from(notifications);
    const status = Object.fromEntries(rows.map((n) => [n.dedupeKey, n.status]));
    expect(status).toEqual({ pending: 'failed', sent: 'sent', other: 'pending' });
  });

  test('deleted phone can register again as a new user', async () => {
    const messenger = new FakeMessenger();
    setMessenger(messenger);
    const user = await makeUser({ phone: '+919876543210' });
    await deleteAccount(user.id, NOW);

    await sendOtp('+919876543210', '1.1.1.1', NOW);
    const code = (messenger.sent.at(-1)!.variables as { code: string }).code;
    const again = await verifyOtp('+919876543210', code, NOW);

    expect(again.user.id).not.toBe(user.id);
    expect(again.user).toMatchObject({ phone: '+919876543210', deletedAt: null, name: null });
  });

  test('an account cannot be deleted twice', async () => {
    const user = await makeUser();
    await deleteAccount(user.id, NOW);
    await expectError(deleteAccount(user.id, NOW), 'not_found', 404);
  });

  test('DELETE /me clears the session cookie', async () => {
    const { user, token } = await signedIn();
    const res = await api(token, 'DELETE', '/me');
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join()).toMatch(/session=;/);
    expect((await api(token, 'GET', '/me')).status).toBe(401);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0]!.deletedAt).not.toBeNull();
  });

  test('DELETE /me with an active order answers 409', async () => {
    const { user, token } = await signedIn();
    await makePaidOrder({ userId: user.id });
    const res = await api(token, 'DELETE', '/me');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'active_order' } });
  });
});

describe('admin support views', () => {
  test('cancellation rate covers the last 30 days', async () => {
    const outlet = await makeLiveOutlet();
    const order = async (status: string, paidDaysAgo: number) => {
      const drop = await makeDrop({ outletId: outlet.id, serviceDate: daysAgo(paidDaysAgo).slice(0, 10) });
      const user = await makeUser();
      return makeOrder({ dropId: drop.id, userId: user.id, status, paidAt: daysAgo(paidDaysAgo) });
    };
    await order('collected', 1);
    await order('no_show', 10);
    await order('paid', 2);
    await order('cancelled', 29);
    await order('cancelled', 31); // Outside the window.
    await order('collected', 45); // Outside the window.
    await makeOrder({ dropId: (await makeDrop({ outletId: outlet.id, serviceDate: '2026-10-30' })).id, status: 'expired' });
    await makePaidOrder({ status: 'cancelled', paidAt: daysAgo(1) }); // Another outlet.

    expect(await getOutletStats(outlet.id, NOW)).toEqual({ orders30d: 4, cancelled30d: 1, cancellationRate: 0.25 });
  });

  test('an outlet with no orders has a rate of zero, and an unknown one is not found', async () => {
    const outlet = await makeLiveOutlet();
    expect(await getOutletStats(outlet.id, NOW)).toEqual({ orders30d: 0, cancelled30d: 0, cancellationRate: 0 });
    await expectError(getOutletStats(randomUUID(), NOW), 'not_found', 404);
    await expectError(getOutletStats('nope', NOW), 'not_found', 404);
  });

  test('admin orders show the customer and what was refunded, newest first, and filter', async () => {
    const asha = await makeUser({ name: 'Asha', phone: '+919876500001' });
    const first = await makePaidOrder({ userId: asha.id, createdAt: daysAgo(2) });
    const second = await makePaidOrder({ userId: asha.id, status: 'collected', createdAt: daysAgo(1) });
    const other = await makePaidOrder({ status: 'no_show', createdAt: daysAgo(3) });
    const payment = await paymentFor(first.id);
    const refund = { orderId: first.id, paymentId: payment.id, chargedTo: 'vendor' };
    await db.insert(refunds).values([
      { ...refund, amountPaise: 2500, reason: 'issue_resolution' },
      { ...refund, amountPaise: 9999, reason: 'vendor_cancelled', status: 'failed' },
    ]);

    const all = await listAdminOrders({});
    expect(all.map((o) => o.id)).toEqual([second.id, first.id, other.id]);
    expect(all[1]).toMatchObject({
      number: `SJ-${first.number}`,
      status: 'paid',
      pricePaise: 10000,
      refundedPaise: 2500,
      customerName: 'Asha',
      customerPhone: '+919876500001',
      outletId: first.outletId,
    });
    expect(all[1]!.branchName).toMatch(/^Branch /);
    expect(all[1]!.brandName).toMatch(/^Brand /);

    const ids = async (f: Parameters<typeof listAdminOrders>[0]) => (await listAdminOrders(f)).map((o) => o.id);
    expect(await ids({ status: 'no_show' })).toEqual([other.id]);
    expect(await ids({ outletId: other.outletId })).toEqual([other.id]);
    expect(await ids({ phone: '98765 00001' })).toEqual([second.id, first.id]);
    expect(await ids({ number: `SJ-${first.number}` })).toEqual([first.id]);
    expect(await ids({ number: String(first.number) })).toEqual([first.id]);
    expect(await ids({ date: '2026-11-03' })).toEqual([]);
    expect(await ids({ date: '2026-11-02', status: 'paid' })).toEqual([first.id]);
    await expectError(listAdminOrders({ status: 'nope' }), 'invalid_request', 400);
    await expectError(listAdminOrders({ phone: '12' }), 'invalid_phone', 400);
  });

  test('admin orders, issues and stats work through the routes, for admins only', async () => {
    const { token: customer } = await signedIn();
    const { token: admin } = await signedIn({ isAdmin: true });
    const order = await makePaidOrder();
    const paths = ['/admin/orders', '/admin/issues', `/admin/outlets/${order.outletId}/stats`];

    for (const path of paths) {
      expect((await api(undefined, 'GET', path)).status).toBe(401);
      expect((await api(customer, 'GET', path)).status).toBe(403);
      expect((await api(admin, 'GET', path)).status).toBe(200);
    }
    const listed = await api(admin, 'GET', `/admin/orders?outlet_id=${order.outletId}&status=paid`);
    expect(await listed.json()).toMatchObject({ orders: [{ id: order.id }] });
    expect((await api(admin, 'GET', '/admin/issues?status=nope')).status).toBe(400);
    const stats = await api(admin, 'GET', `/admin/outlets/${order.outletId}/stats`);
    expect(await stats.json()).toMatchObject({ stats: { orders30d: expect.any(Number) } });
  });
});

describe('changeUserPhone', () => {
  const NEW_PHONE = '+919876512345';

  test('admin phone change ends sessions, is audited, and rejects a number in use', async () => {
    const admin = await makeUser({ isAdmin: true });
    const user = await makeUser();
    const token = await createSession(user.id, new Date());
    const adminToken = await createSession(admin.id, new Date());

    await changeUserPhone(admin.id, user.id, '98765 12345');

    expect((await db.select().from(users).where(eq(users.id, user.id)))[0]!.phone).toBe(NEW_PHONE);
    expect(await getSessionUser(token, new Date())).toBeNull();
    expect(await getSessionUser(adminToken, new Date())).not.toBeNull();
    const [row] = await auditRows('user.phone_change');
    expect(row).toMatchObject({
      actorId: admin.id,
      entity: 'user',
      entityId: user.id,
      detail: { fromLast4: user.phone.slice(-4), toLast4: '2345' },
    });
    expect(JSON.stringify(row!.detail)).not.toContain(NEW_PHONE);

    const other = await makeUser();
    const kept = await createSession(other.id, new Date());
    await expectError(changeUserPhone(admin.id, other.id, NEW_PHONE), 'phone_in_use', 409);
    expect((await db.select().from(users).where(eq(users.id, other.id)))[0]!.phone).toBe(other.phone);
    expect(await getSessionUser(kept, new Date())).not.toBeNull();
    expect(await auditRows('user.phone_change')).toHaveLength(1);
  });

  test('needs a valid number and a live user', async () => {
    const admin = await makeUser({ isAdmin: true });
    const user = await makeUser();
    await expectError(changeUserPhone(admin.id, user.id, '12345'), 'invalid_phone', 400);
    await expectError(changeUserPhone(admin.id, randomUUID(), NEW_PHONE), 'not_found', 404);
    await expectError(changeUserPhone(admin.id, 'nope', NEW_PHONE), 'not_found', 404);
    await deleteAccount(user.id, NOW);
    await expectError(changeUserPhone(admin.id, user.id, NEW_PHONE), 'not_found', 404);
  });

  test('POST /admin/users/:id/phone is admin only', async () => {
    const { user, token: customer } = await signedIn();
    const { token: admin } = await signedIn({ isAdmin: true });
    const target = await makeUser();
    expect((await api(customer, 'POST', `/admin/users/${target.id}/phone`, { phone: NEW_PHONE })).status).toBe(403);
    expect((await api(admin, 'POST', `/admin/users/${target.id}/phone`, { phone: user.phone })).status).toBe(409);
    expect((await api(admin, 'POST', `/admin/users/${target.id}/phone`, { phone: NEW_PHONE })).status).toBe(200);
    expect(
      await db.select().from(users).where(and(eq(users.id, target.id), eq(users.phone, NEW_PHONE))),
    ).toHaveLength(1);
  });
});
