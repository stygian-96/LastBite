import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { verifyAnonId } from '../lib/crypto.js';
import { cookieDomain, route } from '../lib/http.js';
import { sendOtp, verifyOtp } from '../modules/auth/otp.js';
import { deleteSession, SESSION_MAX_AGE_SECONDS } from '../modules/auth/session.js';
import { attachHolds } from '../modules/orders/reserve.js';

const SESSION_COOKIE = 'session';

/** Sign-in has already happened, so a failure here is logged and never reaches the customer. */
async function attachAnonHold(signedAnonId: string | undefined, userId: string, now: Date) {
  try {
    const anonId = signedAnonId ? verifyAnonId(signedAnonId) : null;
    return anonId ? await attachHolds(anonId, userId, now) : {};
  } catch (err) {
    console.error(err);
    return {};
  }
}

export const auth = new Hono()
  .post(
    '/otp/send',
    route({ body: z.object({ phone: z.string().min(1).max(20) }) }, async ({ body, ip, now }) => {
      await sendOtp(body.phone, ip, now);
      return { ok: true };
    }),
  )
  .post(
    '/otp/verify',
    route(
      { body: z.object({ phone: z.string().min(1).max(20), code: z.string().regex(/^\d{6}$/) }) },
      async ({ c, body, now }) => {
        const { user, token } = await verifyOtp(body.phone, body.code, now);
        setCookie(c, SESSION_COOKIE, token, {
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          path: '/',
          maxAge: SESSION_MAX_AGE_SECONDS,
          domain: cookieDomain(),
        });
        const { attachedOrderId, existingOrderId } = await attachAnonHold(getCookie(c, 'anon_id'), user.id, now);
        return {
          user: { id: user.id, phone: user.phone, name: user.name, isAdmin: user.isAdmin },
          attachedOrderId,
          existingOrderId,
        };
      },
    ),
  )
  .post(
    '/logout',
    route({}, async ({ c }) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) await deleteSession(token);
      deleteCookie(c, SESSION_COOKIE, { path: '/', domain: cookieDomain(), secure: true });
      deleteCookie(c, 'anon_id', { path: '/', domain: cookieDomain(), secure: true });
      return { ok: true };
    }),
  );
