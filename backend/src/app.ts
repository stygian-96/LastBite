import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env.js';
import { handleError } from './lib/http.js';
import { adminPayouts } from './routes/admin-payouts.js';
import { adminReview } from './routes/admin-review.js';
import { adminSupport } from './routes/admin-support.js';
import { auth } from './routes/auth.js';
import { customer } from './routes/customer.js';
import { customerOrders } from './routes/customer-orders.js';
import { health } from './routes/health.js';
import { publicBrowse } from './routes/public.js';
import { vendorCatalogue } from './routes/vendor-catalogue.js';
import { vendorEarnings } from './routes/vendor-earnings.js';
import { vendorOnboarding } from './routes/vendor-onboarding.js';
import { vendorOrders } from './routes/vendor-orders.js';
import { vendorStaff } from './routes/vendor-staff.js';
import { webhooks } from './routes/webhooks.js';

export const app = new Hono();

app.onError(handleError);
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

// Only FRONTEND_ORIGIN may call the API from a browser, with credentials.
app.use(
  '/api/v1/*',
  cors({
    origin: (origin) => (origin === env().FRONTEND_ORIGIN ? origin : null),
    credentials: true,
  }),
);

app.route('/api/v1/health', health);
app.route('/api/v1/auth', auth);
app.route('/api/v1/vendor', vendorStaff);
app.route('/api/v1/vendor', vendorOnboarding);
app.route('/api/v1/vendor', vendorCatalogue);
app.route('/api/v1/vendor', vendorOrders);
app.route('/api/v1/vendor', vendorEarnings);
app.route('/api/v1/admin', adminReview);
app.route('/api/v1/admin', adminSupport);
app.route('/api/v1/admin', adminPayouts);
app.route('/api/v1', publicBrowse);
app.route('/api/v1', customerOrders);
app.route('/api/v1', customer);
app.route('/api/v1', webhooks);
