import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { getVendor, getVendorHistory, listInventory, listVendors } from '../modules/admin/vendors.js';
import { updateDrop } from '../modules/catalogue/drops.js';
import { adminCancelDrop } from '../modules/refunds/cancel.js';

export const adminVendors = new Hono()
  .get(
    '/vendors',
    route({ auth: 'admin' }, async ({ c, now }) => {
      const { status, q, area_id: areaId, offset } = c.req.query();
      return listVendors({ status, q, areaId, offset }, now);
    }),
  )
  .get(
    '/vendors/:id',
    route({ auth: 'admin' }, async ({ params, now }) => ({ vendor: await getVendor(params.id!, now) })),
  )
  .get(
    '/vendors/:id/history',
    route({ auth: 'admin' }, async ({ c, params, now }) => getVendorHistory(params.id!, now, c.req.query('days'))),
  )
  .get(
    '/inventory',
    route({ auth: 'admin' }, async ({ c, now }) => {
      const { outlet_id: outletId, q, area_id: areaId } = c.req.query();
      return listInventory({ outletId, q, areaId }, now);
    }),
  )
  .patch(
    '/drops/:id',
    // An admin only pauses and resumes. Quantity, price and times stay the vendor's.
    route({ auth: 'admin', body: z.strictObject({ status: z.enum(['live', 'paused']) }) }, async ({ user, params, body, now }) => ({
      drop: await updateDrop(user!.id, params.id!, body, now, true),
    })),
  )
  .post(
    '/drops/:id/cancel',
    route(
      { auth: 'admin', body: z.object({ reason: z.string(), chargedTo: z.string() }) },
      async ({ user, params, body, now }) => {
        await adminCancelDrop(user!.id, params.id!, body, now);
        return { ok: true };
      },
    ),
  );
