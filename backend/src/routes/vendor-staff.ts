import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { addStaff, listStaff, removeStaff } from '../modules/auth/access.js';

export const vendorStaff = new Hono()
  .get(
    '/outlets/:id/staff',
    route({ auth: 'user' }, async ({ user, params }) => ({ staff: await listStaff(user!.id, params.id!) })),
  )
  .post(
    '/outlets/:id/staff',
    route(
      {
        auth: 'user',
        body: z.object({
          phone: z.string().min(1).max(20),
          name: z.string().trim().min(1).max(100),
          role: z.enum(['manager', 'counter']),
        }),
      },
      async ({ user, params, body }) => {
        const m = await addStaff(user!.id, params.id!, body);
        return { membership: { id: m.id, userId: m.userId, outletId: m.outletId, role: m.role } };
      },
    ),
  )
  .delete(
    '/outlets/:id/staff',
    route({ auth: 'user', body: z.object({ membershipId: z.uuid() }) }, async ({ user, params, body, now }) => {
      await removeStaff(user!.id, body.membershipId, now, params.id!);
      return { ok: true };
    }),
  );
