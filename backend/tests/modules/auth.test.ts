import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { rateLimits, users } from '../../src/db/schema.js';
import { signAnonId } from '../../src/lib/crypto.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { handleError, route } from '../../src/lib/http.js';
import { FakeMessenger, setMessenger } from '../../src/integrations/messaging.js';
import { sendOtp, verifyOtp } from '../../src/modules/auth/otp.js';
import { getSessionUser } from '../../src/modules/auth/session.js';
import { app } from '../../src/app.js';
import { makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

const PHONE = '+919876543210';
const T0 = new Date('2026-11-01T10:00:10Z');
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const DAY = 86_400_000;

let fake: FakeMessenger;
beforeEach(async () => {
  await resetDb();
  fake = new FakeMessenger();
  setMessenger(fake);
});

const lastCode = () => (fake.sent.at(-1)!.variables as { code: string }).code;
const wrongCode = () => (lastCode() === '000000' ? '111111' : '000000');
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

describe('OTP sign-in', () => {
  test('correct code signs in and creates the user once', async () => {
    await sendOtp('98765 43210', '1.1.1.1', T0);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ phone: PHONE, channel: 'sms' });
    expect(lastCode()).toMatch(/^\d{6}$/);

    const first = await verifyOtp(PHONE, lastCode(), minutes(T0, 1));
    expect(first.user.phone).toBe(PHONE);
    expect(first.token.length).toBeGreaterThan(20);
    expect(await getSessionUser(first.token, minutes(T0, 2))).toMatchObject({
      id: first.user.id,
      phone: PHONE,
      isAdmin: false,
    });

    await sendOtp(PHONE, '1.1.1.1', minutes(T0, 3));
    const second = await verifyOtp(PHONE, lastCode(), minutes(T0, 4));
    expect(second.user.id).toBe(first.user.id);
    expect(await db.select().from(users).where(eq(users.phone, PHONE))).toHaveLength(1);
  });

  test('code is stored hashed', async () => {
    await sendOtp(PHONE, '1.1.1.1', T0);
    const { rows } = await pool.query<{ code_hash: string }>('SELECT code_hash FROM otp_codes');
    expect(rows[0]!.code_hash).not.toContain(lastCode());
  });

  test('code expires after 5 minutes', async () => {
    await sendOtp(PHONE, '1.1.1.1', T0);
    const err = await failure(verifyOtp(PHONE, lastCode(), new Date(T0.getTime() + 5 * 60_000 + 1000)));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'otp_invalid', status: 401 });
  });

  test('sixth wrong attempt is rejected even with the right code', async () => {
    await sendOtp(PHONE, '1.1.1.1', T0);
    for (let i = 0; i < 5; i++) {
      expect(await failure(verifyOtp(PHONE, wrongCode(), minutes(T0, 1)))).toMatchObject({
        code: 'otp_invalid',
        status: 401,
      });
    }
    expect(await failure(verifyOtp(PHONE, lastCode(), minutes(T0, 1)))).toMatchObject({
      code: 'otp_invalid',
      status: 401,
    });
  });

  test('code cannot be used twice', async () => {
    await sendOtp(PHONE, '1.1.1.1', T0);
    await verifyOtp(PHONE, lastCode(), minutes(T0, 1));
    expect(await failure(verifyOtp(PHONE, lastCode(), minutes(T0, 2)))).toMatchObject({
      code: 'otp_invalid',
      status: 401,
    });
  });

  test('a phone that never asked for a code gets the same otp_invalid', async () => {
    expect(await failure(verifyOtp(PHONE, '123456', T0))).toMatchObject({ code: 'otp_invalid', status: 401 });
    expect(await failure(verifyOtp('nonsense', '123456', T0))).toMatchObject({ code: 'otp_invalid', status: 401 });
  });

  test('fourth send inside 10 minutes returns 429', async () => {
    for (let i = 0; i < 3; i++) await sendOtp(PHONE, '1.1.1.1', T0);
    expect(await failure(sendOtp(PHONE, '1.1.1.1', minutes(T0, 5)))).toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    expect(fake.sent).toHaveLength(3);
  });

  test('21st send from one IP inside an hour returns 429', async () => {
    for (let i = 0; i < 20; i++) await sendOtp(`+9190000${String(i).padStart(5, '0')}`, '2.2.2.2', T0);
    expect(await failure(sendOtp('+919111111111', '2.2.2.2', T0))).toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    await sendOtp('+919111111111', '3.3.3.3', T0);
  });

  test('with no known IP the IP limit is skipped, so strangers do not share one bucket', async () => {
    for (let i = 0; i < 21; i++) await sendOtp(`+91900${String(i).padStart(7, '0')}`, '', T0);
    const keys = (await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key);
    expect(keys.filter((k) => k.startsWith('otp:ip:'))).toEqual([]);
  });

  test('rejects a malformed phone on send', async () => {
    expect(await failure(sendOtp('12345', '1.1.1.1', T0))).toMatchObject({ code: 'invalid_phone', status: 400 });
  });
});

describe('sessions', () => {
  test('expired session returns null', async () => {
    await sendOtp(PHONE, '1.1.1.1', T0);
    const { token } = await verifyOtp(PHONE, lastCode(), T0);
    expect(await getSessionUser(token, new Date(T0.getTime() + 29 * DAY))).not.toBeNull();
    expect(await getSessionUser(token, new Date(T0.getTime() + 31 * DAY))).toBeNull();
  });

  test('deleted user session returns null', async () => {
    await sendOtp(PHONE, '1.1.1.1', T0);
    const { token, user } = await verifyOtp(PHONE, lastCode(), T0);
    await db.update(users).set({ deletedAt: T0.toISOString() }).where(eq(users.id, user.id));
    expect(await getSessionUser(token, minutes(T0, 1))).toBeNull();
  });

  test('unknown token returns null', async () => {
    expect(await getSessionUser('nope', T0)).toBeNull();
  });
});

describe('route auth', () => {
  function harness() {
    const t = new Hono().onError(handleError);
    t.get('/u', route({ auth: 'user' }, async (ctx) => ({ id: ctx.user?.id })));
    t.post('/u', route({ auth: 'user' }, async () => ({ ok: true })));
    t.get('/a', route({ auth: 'admin' }, async () => ({ ok: true })));
    return t;
  }
  async function sessionFor(isAdmin: boolean) {
    const u = await makeUser({ isAdmin });
    await sendOtp(u.phone, '1.1.1.1', new Date());
    return (await verifyOtp(u.phone, lastCode(), new Date())).token;
  }

  test('auth user route without cookie returns 401', async () => {
    const res = await harness().request('/u');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: expect.any(String) } });
  });

  test('auth admin route for a non-admin returns 403', async () => {
    const token = await sessionFor(false);
    const res = await harness().request('/a', { headers: { cookie: `session=${token}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  test('admin passes the admin route and the user is set on ctx', async () => {
    const token = await sessionFor(true);
    const t = harness();
    expect((await t.request('/a', { headers: { cookie: `session=${token}` } })).status).toBe(200);
    const res = await t.request('/u', { headers: { cookie: `session=${token}` } });
    expect(((await res.json()) as { id: string }).id).toBeTruthy();
  });

  test('cookie-authenticated non-GET needs a matching Origin', async () => {
    const token = await sessionFor(false);
    const t = harness();
    const post = (origin?: string) =>
      t.request('/u', { method: 'POST', headers: { cookie: `session=${token}`, ...(origin ? { origin } : {}) } });

    for (const res of [await post(), await post('https://evil.test')]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_origin');
    }
    expect((await post(env().FRONTEND_ORIGIN)).status).toBe(200);
    // GET is not checked, and a request with no cookie is not cookie-authenticated.
    expect((await t.request('/u', { headers: { cookie: `session=${token}` } })).status).toBe(200);
    expect((await t.request('/u', { method: 'POST' })).status).toBe(401);
  });
});

describe('auth routes', () => {
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  test('send, verify sets the session cookie, logout ends the session', async () => {
    const sent = await app.request('/api/v1/auth/otp/send', json({ phone: PHONE }));
    expect(sent.status).toBe(200);

    const bad = await app.request('/api/v1/auth/otp/verify', json({ phone: PHONE, code: wrongCode() }));
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('otp_invalid');

    const ok = await app.request('/api/v1/auth/otp/verify', json({ phone: PHONE, code: lastCode() }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ user: { phone: PHONE, isAdmin: false } });
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^session=[^;]+/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/i);
    const pair = cookie.split(';')[0]!;

    const out = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: pair, origin: env().FRONTEND_ORIGIN },
    });
    expect(out.status).toBe(200);
    const token = decodeURIComponent(pair.split('=')[1]!);
    expect(await getSessionUser(token, new Date())).toBeNull();
  });

  test('logout also clears the anon_id cookie', async () => {
    await sendOtp(PHONE, '1.1.1.1', new Date());
    const { token } = await verifyOtp(PHONE, lastCode(), new Date());
    const out = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: `session=${token}; anon_id=${signAnonId('shared')}`, origin: env().FRONTEND_ORIGIN },
    });
    expect(out.status).toBe(200);
    const cleared = out.headers.getSetCookie();
    expect(cleared.find((c) => c.startsWith('session='))).toMatch(/Max-Age=0/i);
    expect(cleared.find((c) => c.startsWith('anon_id='))).toMatch(/Max-Age=0/i);
    expect(cleared.find((c) => c.startsWith('anon_id='))).toMatch(/Path=\//i);
  });

  test('send validates the body', async () => {
    const res = await app.request('/api/v1/auth/otp/send', json({}));
    expect(res.status).toBe(400);
  });
});
