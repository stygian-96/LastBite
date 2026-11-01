import { Hono } from 'hono';
import { ApiError } from '../lib/errors.js';
import { route } from '../lib/http.js';
import { getDrop, getOutletPage, listCities, listDrops, type DropFilters } from '../modules/catalogue/feed.js';

const bad = (name: string) => new ApiError('invalid_request', 400, `Invalid value for ${name}`);

// Public, no sign-in. Query strings are turned into typed filters here; the module checks the values.
export const publicBrowse = new Hono()
  .get(
    '/cities',
    route({}, async () => ({ cities: await listCities() })),
  )
  .get(
    '/drops',
    route({}, async ({ c, now }) => {
      const q = c.req.query();
      const f: DropFilters = { city: q.city ?? '' };
      if (q.area) f.area = q.area;
      if (q.category) f.category = q.category;
      if (q.veg !== undefined && q.veg !== '') {
        if (q.veg !== 'true' && q.veg !== 'false') throw bad('veg');
        f.veg = q.veg === 'true';
      }
      if (q.pickup_by) f.pickupBy = q.pickup_by;
      if (q.max_price) {
        if (!/^\d+$/.test(q.max_price)) throw bad('max_price');
        f.maxPricePaise = Number(q.max_price);
      }
      if (q.q) f.q = q.q;
      return { drops: await listDrops(f, now) };
    }),
  )
  .get(
    '/drops/:id',
    route({}, async ({ params, now }) => ({ drop: await getDrop(params.id!, now) })),
  )
  .get(
    '/outlets/:brandSlug/:outletSlug',
    route({}, async ({ params, now }) => ({ outlet: await getOutletPage(params.brandSlug!, params.outletSlug!, now) })),
  );
