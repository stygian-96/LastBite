import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { ApiError } from '../lib/errors.js';
import { verifyAnonId } from '../lib/crypto.js';
import { route } from '../lib/http.js';
import { getSessionUser } from '../modules/auth/session.js';
import { getOrder, listMyOrders } from '../modules/orders/views.js';

// Customer order routes. `GET /orders/:id` also serves guests, who prove ownership with the signed anon_id cookie.
export const customerOrders = new Hono()
  .get(
    '/orders/:id',
    route({ auth: 'none' }, async ({ c, params, now }) => {
      const token = getCookie(c, 'session');
      const user = token ? await getSessionUser(token, now) : null;
      const signed = getCookie(c, 'anon_id');
      const anonId = signed ? verifyAnonId(signed) : null;
      const order = await getOrder({ userId: user?.id, anonId: anonId ?? undefined }, params.id!);
      return { order };
    }),
  )
  .get(
    '/me/orders',
    route({ auth: 'user' }, async ({ c, user, now }) => {
      const status = c.req.query('status');
      if (status !== 'active' && status !== 'past') throw new ApiError('invalid_request', 400, 'Invalid value for status');
      return { orders: await listMyOrders(user!.id, status, now) };
    }),
  );
