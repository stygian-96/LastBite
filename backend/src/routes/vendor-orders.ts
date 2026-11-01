import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { collectByCode, collectOrder } from '../modules/pickup/collect.js';
import { listOutletOrders } from '../modules/pickup/list.js';
import { markNoShow } from '../modules/pickup/no-show.js';
import { cancelDrop, cancelOrder } from '../modules/refunds/cancel.js';

// The reason is checked in full by the modules.
const cancelBody = z.object({ reason: z.unknown() });
const collectBody = z.object({ code: z.string().max(20) });

export const vendorOrders = new Hono()
  .post(
    '/orders/:id/cancel',
    route({ auth: 'user', body: cancelBody }, async ({ user, params, body, now }) => {
      await cancelOrder(user!.id, params.id!, body.reason, now);
      return { ok: true };
    }),
  )
  .post(
    '/drops/:id/cancel',
    route({ auth: 'user', body: cancelBody }, async ({ user, params, body, now }) => {
      await cancelDrop(user!.id, params.id!, body.reason, now);
      return { ok: true };
    }),
  )
  .post(
    '/outlets/:id/collect',
    route({ auth: 'user', body: collectBody }, ({ user, params, body, now }) =>
      collectByCode(user!.id, params.id!, body.code, now),
    ),
  )
  .post(
    '/orders/:id/collect',
    route({ auth: 'user' }, ({ user, params, now }) => collectOrder(user!.id, params.id!, now)),
  )
  .post(
    '/orders/:id/no-show',
    route({ auth: 'user' }, async ({ user, params, now }) => {
      await markNoShow(user!.id, params.id!, now);
      return { ok: true };
    }),
  )
  .get(
    '/outlets/:id/orders',
    route({ auth: 'user' }, async ({ c, user, params, now }) => ({
      orders: await listOutletOrders(user!.id, params.id!, { date: c.req.query('date'), q: c.req.query('q') }, now),
    })),
  );
