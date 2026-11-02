import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { decideOutlet, listApplications, reviewDocument, updateOutletAdmin } from '../modules/admin/review.js';

export const adminReview = new Hono()
  .get(
    '/applications',
    route({ auth: 'admin' }, async () => ({ applications: await listApplications() })),
  )
  .post(
    '/documents/:id/review',
    route(
      {
        auth: 'admin',
        body: z.object({
          approve: z.boolean(),
          reason: z.string().optional(),
          fssaiNumber: z.string().optional(),
          fssaiExpiresOn: z.string().optional(),
        }),
      },
      async ({ user, params, body, now }) => {
        await reviewDocument(user!.id, params.id!, body, now);
        return { ok: true };
      },
    ),
  )
  .post(
    '/outlets/:id/decision',
    route(
      {
        auth: 'admin',
        body: z.object({ decision: z.string(), reason: z.string().optional() }),
      },
      async ({ user, params, body, now }) => {
        // The module owns the list of valid decisions and answers an unknown one with a 400.
        await decideOutlet(user!.id, params.id!, body as Parameters<typeof decideOutlet>[2], now);
        return { ok: true };
      },
    ),
  )
  .patch(
    '/outlets/:id',
    route(
      {
        auth: 'admin',
        body: z.object({
          brandId: z.string().optional(),
          commissionBps: z.number().optional(),
          payoutAccountId: z.string().optional(),
        }),
      },
      async ({ user, params, body }) => {
        await updateOutletAdmin(user!.id, params.id!, body);
        return { ok: true };
      },
    ),
  );
