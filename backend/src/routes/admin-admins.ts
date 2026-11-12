import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { addAdmin, listAdmins, removeAdmin } from '../modules/admin/admins.js';

export const adminAdmins = new Hono()
  .get(
    '/me',
    route({ auth: 'admin' }, async ({ user }) => ({
      me: { id: user!.id, phone: user!.phone, name: user!.name, isSuperAdmin: user!.isSuperAdmin },
    })),
  )
  .get(
    '/admins',
    route({ auth: 'superadmin' }, async () => ({ admins: await listAdmins() })),
  )
  .post(
    '/admins',
    route({ auth: 'superadmin', body: z.object({ phone: z.string(), name: z.string().optional() }) }, async ({ user, body }) => ({
      admin: await addAdmin(user!.id, body),
    })),
  )
  .delete(
    '/admins/:id',
    route({ auth: 'superadmin' }, async ({ user, params }) => {
      await removeAdmin(user!.id, params.id!);
      return { ok: true };
    }),
  );
