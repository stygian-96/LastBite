import { Hono } from 'hono';
import { z } from 'zod';
import { getStore } from '../integrations/storage.js';
import { route } from '../lib/http.js';
import { uploadFile, uploadKey } from '../lib/uploads.js';
import { addDocument } from '../modules/onboarding/documents.js';
import { getOutletStatus, saveOutletStep, startOutlet, submitOutlet } from '../modules/onboarding/outlets.js';
import { createPayoutAccount, signAgreement, updatePayoutAccount, type PayoutAccount } from '../modules/onboarding/payout-accounts.js';

const FOLDERS = { photo: 'photos', logo: 'logos', document: 'documents' } as const;

const uploadBody = uploadFile
  .extend({ purpose: z.enum(['photo', 'logo', 'document']) })
  .refine((b) => b.purpose === 'document' || b.contentType.startsWith('image/'));

const payoutAccountDetails = z.object({
  legalName: z.string(),
  pan: z.string(),
  holderName: z.string(),
  accountNumber: z.string(),
  ifsc: z.string(),
});

/** The encrypted columns never leave the server. */
const publicPayoutAccount = (a: PayoutAccount) => ({
  id: a.id,
  brandId: a.brandId,
  legalName: a.legalName,
  panLast4: a.panLast4,
  holderName: a.holderName,
  accountLast4: a.accountLast4,
  ifsc: a.ifsc,
  status: a.status,
});

export const vendorOnboarding = new Hono()
  .post(
    '/outlets',
    route(
      {
        auth: 'user',
        body: z.object({
          brandName: z.string().optional(),
          brandId: z.string().optional(),
          branchName: z.string(),
          category: z.string(),
        }),
      },
      async ({ user, body }) => ({ outlet: await startOutlet(user!.id, body) }),
    ),
  )
  .patch(
    '/outlets/:id',
    route({ auth: 'user', body: z.record(z.string(), z.unknown()) }, async ({ user, params, body }) => ({
      outlet: await saveOutletStep(user!.id, params.id!, body),
    })),
  )
  .post(
    '/uploads',
    route({ auth: 'user', body: uploadBody }, async ({ user, body }) => {
      const key = uploadKey(FOLDERS[body.purpose], user!.id, body.contentType);
      const bucket = body.purpose === 'document' ? 'private' : 'public';
      const url = await getStore().signedUpload(key, body.contentType, bucket, body.size);
      return { key, url };
    }),
  )
  .post(
    '/outlets/:id/documents',
    route(
      {
        auth: 'user',
        body: z.object({ kind: z.enum(['fssai', 'gst', 'pan', 'bank_proof']), fileKey: z.string(), payoutAccountId: z.string().optional() }),
      },
      async ({ user, params, body }) => ({ document: await addDocument(user!.id, { outletId: params.id!, ...body }) }),
    ),
  )
  .post(
    '/payout-accounts',
    route({ auth: 'user', body: payoutAccountDetails.extend({ brandId: z.uuid() }) }, async ({ user, body }) => {
      const { brandId, ...input } = body;
      return { payoutAccount: publicPayoutAccount(await createPayoutAccount(user!.id, brandId, input)) };
    }),
  )
  .patch(
    '/payout-accounts/:id',
    route({ auth: 'user', body: payoutAccountDetails }, async ({ user, params, body, now }) => ({
      payoutAccount: publicPayoutAccount(await updatePayoutAccount(user!.id, params.id!, body, now)),
    })),
  )
  .post(
    '/payout-accounts/:id/agreement',
    route(
      { auth: 'user', body: z.object({ signedName: z.string(), version: z.string() }) },
      async ({ user, params, body, ip, now }) => {
        await signAgreement(user!.id, params.id!, { ...body, ip }, now);
        return { ok: true };
      },
    ),
  )
  .post(
    '/outlets/:id/submit',
    route({ auth: 'user' }, async ({ user, params, now }) => ({
      outlet: await submitOutlet(user!.id, params.id!, now),
    })),
  )
  .get(
    '/outlets/:id/status',
    route({ auth: 'user' }, async ({ user, params }) => getOutletStatus(user!.id, params.id!)),
  );
