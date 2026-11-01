import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { cancelDrop, cancelOrder } from '../modules/refunds/cancel.js';

// The reason is checked in full by the modules.
const cancelBody = z.object({ reason: z.unknown() });

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
  );
