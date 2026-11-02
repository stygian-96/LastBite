import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { signAnonId, verifyAnonId } from '../lib/crypto.js';
import { cookieDomain, route } from '../lib/http.js';
import { getSessionUser } from '../modules/auth/session.js';
import { releaseHold, reserveDrop } from '../modules/orders/reserve.js';
import { getOrder, listMyOrders, type Viewer } from '../modules/orders/views.js';
import { startPayment } from '../modules/payments/start.js';

const ANON_MAX_AGE_SECONDS = 86_400;

/** Who is asking: the session's user, the holder of a validly signed anon_id cookie, or both. */
async function readViewer(c: Context, now: Date): Promise<Viewer> {
  const token = getCookie(c, 'session');
  const user = token ? await getSessionUser(token, now) : null;
  const signed = getCookie(c, 'anon_id');
  const anonId = signed ? verifyAnonId(signed) : null;
  return { userId: user?.id, anonId: anonId ?? undefined };
}

// Customer order routes. Guests prove ownership with the signed anon_id cookie.
export const customerOrders = new Hono()
  .post(
    '/orders',
    route({ body: z.object({ dropId: z.uuid() }) }, async ({ c, body, ip, now }) => {
      const viewer = await readViewer(c, now);
      if (!viewer.userId && !viewer.anonId) {
        viewer.anonId = randomUUID();
        setCookie(c, 'anon_id', signAnonId(viewer.anonId), {
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          path: '/',
          maxAge: ANON_MAX_AGE_SECONDS,
          domain: cookieDomain(),
        });
      }
      const holder = viewer.userId ? { userId: viewer.userId } : { anonId: viewer.anonId };
      const order = await reserveDrop({ dropId: body.dropId, ...holder, ip }, now);
      return { order: await getOrder(holder, order.id) };
    }),
  )
  .get(
    '/orders/:id',
    route({ auth: 'none' }, async ({ c, params, now }) => {
      const order = await getOrder(await readViewer(c, now), params.id!);
      return { order };
    }),
  )
  .delete(
    '/orders/:id/hold',
    route({ auth: 'none' }, async ({ c, params, now }) => {
      await releaseHold(await readViewer(c, now), params.id!, now);
      return { ok: true };
    }),
  )
  .post(
    '/orders/:id/pay',
    route({ auth: 'user', body: z.object({ allergenAck: z.boolean() }) }, async ({ params, body, user, now }) =>
      startPayment(user!.id, params.id!, body, now),
    ),
  )
  .get(
    '/me/orders',
    route({ auth: 'user' }, async ({ c, user, now }) => {
      const status = c.req.query('status');
      if (status !== undefined && status !== 'active' && status !== 'past') {
        throw new ApiError('invalid_request', 400, 'Invalid value for status');
      }
      return { orders: await listMyOrders(user!.id, status, now) };
    }),
  );
