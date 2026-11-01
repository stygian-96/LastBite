import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { route } from '../lib/http.js';
import { sendOtp, verifyOtp } from '../modules/auth/otp.js';
import { deleteSession, SESSION_MAX_AGE_SECONDS } from '../modules/auth/session.js';

const SESSION_COOKIE = 'session';

// Domain is only sent when COOKIE_DOMAIN is set, so localhost works without it.
const cookieDomain = () => env().COOKIE_DOMAIN || undefined;

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
        return { user: { id: user.id, phone: user.phone, name: user.name, isAdmin: user.isAdmin } };
      },
    ),
  )
  .post(
    '/logout',
    route({}, async ({ c }) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) await deleteSession(token);
      deleteCookie(c, SESSION_COOKIE, { path: '/', domain: cookieDomain(), secure: true });
      return { ok: true };
    }),
  );
