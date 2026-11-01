import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env.js';
import { handleError } from './lib/http.js';
import { adminReview } from './routes/admin-review.js';
import { auth } from './routes/auth.js';
import { health } from './routes/health.js';
import { vendorOnboarding } from './routes/vendor-onboarding.js';
import { vendorStaff } from './routes/vendor-staff.js';

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
app.route('/api/v1/admin', adminReview);
