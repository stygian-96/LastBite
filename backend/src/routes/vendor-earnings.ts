import { Hono } from 'hono';
import { ApiError } from '../lib/errors.js';
import { route } from '../lib/http.js';
import { getEarnings, statementCsv } from '../modules/payouts/statements.js';

export const vendorEarnings = new Hono()
  .get(
    '/earnings',
    route({ auth: 'user' }, async ({ c, user }) => {
      const account = c.req.query('payout_account');
      if (!account) throw new ApiError('invalid_request', 400, 'Say which payout account');
      return getEarnings(user!.id, account);
    }),
  )
  .get(
    '/payouts/:id/statement',
    route({ auth: 'user' }, async ({ c, user, params }) => {
      const csv = await statementCsv(user!.id, params.id!);
      return c.body(csv, 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="statement-${params.id!}.csv"`,
      });
    }),
  );
