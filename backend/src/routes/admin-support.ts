import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { adminRefund, changeUserPhone, getOutletStats, listAdminOrders, listIssues } from '../modules/admin/support.js';

export const adminSupport = new Hono()
  .get(
    '/orders',
    route({ auth: 'admin' }, async ({ c }) => {
      const q = c.req.query();
      const filters = { status: q.status, outletId: q.outlet_id, date: q.date, phone: q.phone, number: q.number };
      return { orders: await listAdminOrders(filters) };
    }),
  )
  .get(
    '/issues',
    route({ auth: 'admin' }, async ({ c }) => ({ issues: await listIssues(c.req.query('status') ?? 'open') })),
  )
  .post(
    '/orders/:id/refund',
    route(
      {
        auth: 'admin',
        body: z.object({
          amountPaise: z.number(),
          chargedTo: z.enum(['vendor', 'platform']),
          issueId: z.string().optional(),
        }),
      },
      async ({ user, params, body, now }) => {
        await adminRefund(user!.id, params.id!, body, now);
        return { ok: true };
      },
    ),
  )
  .get(
    '/outlets/:id/stats',
    route({ auth: 'admin' }, async ({ params, now }) => ({ stats: await getOutletStats(params.id!, now) })),
  )
  .post(
    '/users/:id/phone',
    route({ auth: 'admin', body: z.object({ phone: z.string().min(1).max(20) }) }, async ({ user, params, body }) => {
      await changeUserPhone(user!.id, params.id!, body.phone);
      return { ok: true };
    }),
  );
