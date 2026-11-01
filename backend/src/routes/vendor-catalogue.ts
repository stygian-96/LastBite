import { Hono } from 'hono';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { listAccessibleOutlets } from '../modules/auth/access.js';
import { getToday, publishDrop, updateDrop } from '../modules/catalogue/drops.js';
import {
  archiveListing,
  copyListing,
  createListing,
  listListings,
  updateListing,
} from '../modules/catalogue/listings.js';

// Bodies are checked in full by the modules; the routes only make sure they are objects.
const anyObject = z.record(z.string(), z.unknown());

export const vendorCatalogue = new Hono()
  .get(
    '/outlets',
    route({ auth: 'user' }, async ({ user }) => ({ outlets: await listAccessibleOutlets(user!.id) })),
  )
  .get(
    '/outlets/:id/listings',
    route({ auth: 'user' }, async ({ user, params }) => ({ listings: await listListings(user!.id, params.id!) })),
  )
  .post(
    '/outlets/:id/listings',
    route({ auth: 'user', body: anyObject }, async ({ user, params, body }) => ({
      listing: await createListing(user!.id, params.id!, body),
    })),
  )
  .patch(
    '/listings/:id',
    route({ auth: 'user', body: anyObject }, async ({ user, params, body }) => ({
      listing: await updateListing(user!.id, params.id!, body),
    })),
  )
  .delete(
    '/listings/:id',
    route({ auth: 'user' }, async ({ user, params, now }) => ({
      listing: await archiveListing(user!.id, params.id!, now),
    })),
  )
  .post(
    '/listings/:id/copy',
    route({ auth: 'user', body: z.object({ targetOutletId: z.string() }) }, async ({ user, params, body }) => ({
      listing: await copyListing(user!.id, params.id!, body.targetOutletId),
    })),
  )
  .get(
    '/outlets/:id/today',
    route({ auth: 'user' }, async ({ user, params, now }) => ({
      today: await getToday(user!.id, params.id!, now),
    })),
  )
  .put(
    '/listings/:id/drops/today',
    route({ auth: 'user', body: z.object({ quantity: z.unknown() }) }, async ({ user, params, body, now }) => ({
      drop: await publishDrop(user!.id, params.id!, body.quantity as number, now),
    })),
  )
  .patch(
    '/drops/:id',
    route({ auth: 'user', body: anyObject }, async ({ user, params, body, now }) => ({
      drop: await updateDrop(user!.id, params.id!, body, now),
    })),
  );
