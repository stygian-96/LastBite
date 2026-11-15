import { Hono } from 'hono';
import { z } from 'zod';
import { getStore } from '../integrations/storage.js';
import { route } from '../lib/http.js';
import { listAccessibleOutlets } from '../modules/auth/access.js';
import { getToday, publishDrop, updateDrop } from '../modules/catalogue/drops.js';
import {
  deleteListing,
  copyListing,
  createListing,
  listListings,
  updateListing,
  type Listing,
} from '../modules/catalogue/listings.js';

// Bodies are checked in full by the modules; the routes only make sure they are objects.
const anyObject = z.record(z.string(), z.unknown());

/** Adds the photo's public link, so the edit form can show the photo already there. */
const withPhotoUrl = (l: Listing) => ({ ...l, photoUrl: l.photoKey ? getStore().publicUrl(l.photoKey) : null });

export const vendorCatalogue = new Hono()
  .get(
    '/outlets',
    route({ auth: 'user' }, async ({ user }) => ({ outlets: await listAccessibleOutlets(user!.id) })),
  )
  .get(
    '/outlets/:id/listings',
    route({ auth: 'user' }, async ({ user, params }) => ({
      listings: (await listListings(user!.id, params.id!)).map(withPhotoUrl),
    })),
  )
  .post(
    '/outlets/:id/listings',
    route({ auth: 'user', body: anyObject }, async ({ user, params, body }) => ({
      listing: withPhotoUrl(await createListing(user!.id, params.id!, body)),
    })),
  )
  .patch(
    '/listings/:id',
    route({ auth: 'user', body: anyObject }, async ({ user, params, body, now }) => ({
      listing: withPhotoUrl(await updateListing(user!.id, params.id!, body, now)),
    })),
  )
  .delete(
    '/listings/:id',
    route({ auth: 'user' }, async ({ user, params, now }) => deleteListing(user!.id, params.id!, now)),
  )
  .post(
    '/listings/:id/copy',
    route({ auth: 'user', body: z.object({ targetOutletId: z.string() }) }, async ({ user, params, body }) => ({
      listing: withPhotoUrl(await copyListing(user!.id, params.id!, body.targetOutletId)),
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
