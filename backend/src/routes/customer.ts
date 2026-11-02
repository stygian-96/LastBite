import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { getStore } from '../integrations/storage.js';
import { cookieDomain, route } from '../lib/http.js';
import { uploadFile, uploadKey } from '../lib/uploads.js';
import { ISSUE_PHOTO_FOLDER, rateOrder, reportIssue } from '../modules/customer/feedback.js';
import { follow, listFollowing, unfollow } from '../modules/customer/follow.js';
import { deleteAccount, getProfile, updateProfile } from '../modules/customer/profile.js';

// The signed-in customer's account, follows, ratings and problem reports.
export const customer = new Hono()
  .get(
    '/me',
    route({ auth: 'user' }, async ({ user }) => ({ profile: await getProfile(user!.id) })),
  )
  .patch(
    '/me',
    route({ auth: 'user', body: z.record(z.string(), z.unknown()) }, async ({ user, body }) => ({
      profile: await updateProfile(user!.id, body),
    })),
  )
  .delete(
    '/me',
    route({ auth: 'user' }, async ({ c, user, now }) => {
      await deleteAccount(user!.id, now);
      deleteCookie(c, 'session', { path: '/', domain: cookieDomain(), secure: true });
      return { ok: true };
    }),
  )
  .post(
    '/me/uploads',
    route({ auth: 'user', body: uploadFile }, async ({ user, body }) => {
      const key = uploadKey(ISSUE_PHOTO_FOLDER, user!.id, body.contentType);
      return { key, url: await getStore().signedUpload(key, body.contentType, 'private', body.size) };
    }),
  )
  .get(
    '/me/following',
    route({ auth: 'user' }, async ({ user }) => ({ following: await listFollowing(user!.id) })),
  )
  .put(
    '/outlets/:id/follow',
    route({ auth: 'user' }, async ({ user, params }) => {
      await follow(user!.id, params.id!);
      return { ok: true };
    }),
  )
  .delete(
    '/outlets/:id/follow',
    route({ auth: 'user' }, async ({ user, params }) => {
      await unfollow(user!.id, params.id!);
      return { ok: true };
    }),
  )
  .post(
    '/orders/:id/rating',
    route({ auth: 'user', body: z.object({ stars: z.number() }) }, async ({ user, params, body }) => {
      await rateOrder(user!.id, params.id!, body.stars);
      return { ok: true };
    }),
  )
  .post(
    '/orders/:id/issues',
    route({ auth: 'user', body: z.record(z.string(), z.unknown()) }, async ({ user, params, body }) => ({
      issue: await reportIssue(user!.id, params.id!, body),
    })),
  );
