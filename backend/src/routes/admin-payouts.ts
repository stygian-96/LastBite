import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { approvePayout, holdPayout, markPayoutPaid, unholdPayout, verifyPayoutAccount } from '../modules/payouts/approve.js';
import { listPayouts } from '../modules/payouts/statements.js';

export const adminPayouts = new Hono()
  .get(
    '/payouts',
    route({ auth: 'admin' }, async ({ c }) => ({ payouts: await listPayouts(c.req.query('status')) })),
  )
  .post(
    '/payouts/:id/approve',
    route({ auth: 'admin' }, async ({ user, params, now }) => {
      await approvePayout(user!.id, params.id!, now);
      return { ok: true };
    }),
  )
  .post(
    '/payouts/:id/hold',
    route({ auth: 'admin', body: z.object({ reason: z.string() }) }, async ({ user, params, body, now }) => {
      await holdPayout(user!.id, params.id!, body.reason, now);
      return { ok: true };
    }),
  )
  .post(
    '/payouts/:id/unhold',
    route({ auth: 'admin' }, async ({ user, params, now }) => {
      await unholdPayout(user!.id, params.id!, now);
      return { ok: true };
    }),
  )
  .post(
    '/payouts/:id/mark-paid',
    route({ auth: 'admin' }, async ({ user, params, now }) => {
      await markPayoutPaid(user!.id, params.id!, now);
      return { ok: true };
    }),
  )
  .post(
    '/payout-accounts/:id/verify',
    route({ auth: 'admin' }, async ({ user, params, now }) => {
      await verifyPayoutAccount(user!.id, params.id!, now);
      return { ok: true };
    }),
  );
