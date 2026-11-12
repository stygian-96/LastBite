import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { areas, documents, notifications, outlets, payoutAccounts } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { FakeStore, setStore } from '../../src/integrations/storage.js';
import { createSession } from '../../src/modules/auth/session.js';
import { decideOutlet, listApplications, reviewDocument } from '../../src/modules/admin/review.js';
import { addDocument } from '../../src/modules/onboarding/documents.js';
import { getOutletStatus, saveOutletStep, startOutlet, submitOutlet, withdrawOutlet } from '../../src/modules/onboarding/outlets.js';
import { createPayoutAccount, fixBankDetails, fixPanDetails, signAgreement } from '../../src/modules/onboarding/payout-accounts.js';
import { app } from '../../src/app.js';
import { makeListing, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

const T0 = new Date('2026-11-01T10:00:00Z');

beforeEach(async () => {
  await resetDb();
  setStore(new FakeStore());
});

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );

const PAYOUT = {
  legalName: 'Butterfold Foods Pvt Ltd',
  pan: 'AAJFB4821K',
  holderName: 'Butterfold Foods Pvt Ltd',
  accountNumber: '123456789012',
  ifsc: 'HDFC0001234',
};
const docKey = (userId: string) => `documents/${userId}/${randomUUID()}.pdf`;

/** A complete application, submitted, and an admin. */
async function submitted(brandName = 'Butterfold Bakery') {
  const owner = await makeUser();
  const outlet = await startOutlet(owner.id, { brandName, branchName: 'Indiranagar', category: 'bakery' });
  const pa = await createPayoutAccount(owner.id, outlet.brandId, PAYOUT);
  const [area] = await db.select({ id: areas.id }).from(areas).limit(1);
  await saveOutletStep(owner.id, outlet.id, {
    address: '12 Church Street',
    pincode: '560001',
    areaId: area!.id,
    mapsUrl: 'https://maps.app.goo.gl/abc123',
    contactPhone: '9876543210',
    openingHours: { mon: [['08:00', '22:00']] },
    fssaiNumber: '12345678901234',
    fssaiExpiresOn: '2027-06-30',
    payoutAccountId: pa.id,
  });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'pan', fileKey: docKey(owner.id) });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'bank_proof', fileKey: docKey(owner.id) });
  await signAgreement(owner.id, pa.id, { signedName: 'A Founder', ip: '203.0.113.5', version: 'v1' }, T0);
  await makeListing({ outletId: outlet.id });
  await submitOutlet(owner.id, outlet.id, T0);
  const admin = await makeUser({ isAdmin: true });
  return { owner, outlet, pa, admin };
}

const docOf = async (kind: string, where: { outletId?: string; payoutAccountId?: string }) => {
  const rows = await db.select().from(documents).where(eq(documents.kind, kind));
  return rows.filter((d) => d.status !== 'replaced' && (d.outletId === where.outletId || d.payoutAccountId === where.payoutAccountId)).at(-1)!;
};
const statusOf = async (id: string) => (await db.select().from(outlets).where(eq(outlets.id, id)))[0]!;
const sectionOf = async (ownerId: string, outletId: string, key: string) =>
  (await getOutletStatus(ownerId, outletId)).sections.find((s) => s.key === key);

describe('admin tabs', () => {
  test('review, sent back, drafts and rejected each list their own', async () => {
    const review = await submitted('Review Co');
    const sent = await submitted('Sent Co');
    await decideOutlet(sent.admin.id, sent.outlet.id, { decision: 'request_changes', reason: 'Add photos' }, T0);
    const rejected = await submitted('Gone Co');
    await decideOutlet(rejected.admin.id, rejected.outlet.id, { decision: 'reject', reason: 'Spam' }, T0);
    const owner = await makeUser();
    const draft = await startOutlet(owner.id, { brandName: 'Draft Co', branchName: 'HSR', category: 'cafe' });

    const ids = async (tab?: string) => (await listApplications(tab)).map((a) => a.outlet.id);
    expect(await ids()).toEqual([review.outlet.id]);
    expect(await ids('review')).toEqual([review.outlet.id]);
    expect(await ids('sent_back')).toEqual([sent.outlet.id]);
    expect(await ids('drafts')).toEqual([draft.id]);
    expect(await ids('rejected')).toEqual([rejected.outlet.id]);
    expect(await ids('nonsense')).toEqual([review.outlet.id]);
  });
});

describe('rejecting an application', () => {
  test('needs a reason, tells the vendor, and locks the application', async () => {
    const { owner, outlet, admin } = await submitted();
    expect(await failure(decideOutlet(admin.id, outlet.id, { decision: 'reject' }, T0))).toMatchObject({ status: 400 });
    await decideOutlet(admin.id, outlet.id, { decision: 'reject', reason: 'Not in our area yet' }, T0);
    expect(await statusOf(outlet.id)).toMatchObject({ status: 'rejected', rejectionReason: 'Not in our area yet' });
    const [msg] = await db.select().from(notifications).where(eq(notifications.template, 'application_rejected'));
    expect(msg!.variables).toMatchObject({ reason: 'Not in our area yet' });
    expect(await getOutletStatus(owner.id, outlet.id)).toMatchObject({ status: 'rejected', rejectionReason: 'Not in our area yet', fixes: [] });
    expect(await failure(saveOutletStep(owner.id, outlet.id, { address: 'Elsewhere' }))).toMatchObject({ code: 'not_editable' });
    expect(await failure(submitOutlet(owner.id, outlet.id, T0))).toMatchObject({ status: 409 });
  });

  test('works on drafts and sent-back applications, not on live outlets', async () => {
    const { outlet, admin } = await submitted();
    await decideOutlet(admin.id, outlet.id, { decision: 'request_changes', reason: 'x' }, T0);
    await decideOutlet(admin.id, outlet.id, { decision: 'reject', reason: 'Spam' }, T0);
    const live = await submitted('Live Co');
    for (const kind of ['fssai'] as const) await reviewDocument(live.admin.id, (await docOf(kind, { outletId: live.outlet.id })).id, { approve: true }, T0);
    for (const kind of ['pan', 'bank_proof'] as const) {
      await reviewDocument(live.admin.id, (await docOf(kind, { payoutAccountId: live.pa.id })).id, { approve: true }, T0);
    }
    await decideOutlet(live.admin.id, live.outlet.id, { decision: 'approve' }, T0);
    expect(await failure(decideOutlet(live.admin.id, live.outlet.id, { decision: 'reject', reason: 'x' }, T0))).toMatchObject({ code: 'invalid_state' });
  });
});

describe('asking to change an approved section', () => {
  test('an approved file goes back to the vendor with a reason', async () => {
    const { owner, outlet, pa, admin } = await submitted();
    const proof = await docOf('bank_proof', { payoutAccountId: pa.id });
    await reviewDocument(admin.id, proof.id, { approve: true }, T0);
    expect(await sectionOf(owner.id, outlet.id, 'bank')).toMatchObject({ state: 'approved' });

    await reviewDocument(admin.id, proof.id, { approve: false, reason: 'IFSC does not match the cheque' }, T0);
    expect((await statusOf(outlet.id)).status).toBe('changes_needed');
    expect(await sectionOf(owner.id, outlet.id, 'bank')).toEqual({ key: 'bank', state: 'needs_fix', reason: 'IFSC does not match the cheque' });
  });

  test('not once the outlet is live', async () => {
    const { outlet, pa, admin } = await submitted();
    await reviewDocument(admin.id, (await docOf('fssai', { outletId: outlet.id })).id, { approve: true }, T0);
    await reviewDocument(admin.id, (await docOf('pan', { payoutAccountId: pa.id })).id, { approve: true }, T0);
    const proof = await docOf('bank_proof', { payoutAccountId: pa.id });
    await reviewDocument(admin.id, proof.id, { approve: true }, T0);
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0);
    expect(await failure(reviewDocument(admin.id, proof.id, { approve: false, reason: 'x' }, T0))).toMatchObject({ code: 'invalid_state' });
  });
});

describe('the vendor fixing flagged details', () => {
  test('a flagged bank proof can be fixed by correcting the details, without a new photo', async () => {
    const { owner, outlet, pa, admin } = await submitted();
    const proof = await docOf('bank_proof', { payoutAccountId: pa.id });
    await reviewDocument(admin.id, proof.id, { approve: false, reason: 'Account number does not match' }, T0);
    expect((await getOutletStatus(owner.id, outlet.id)).fixes.map((f) => f.code)).toContain('bank_proof_document_rejected');

    await fixBankDetails(owner.id, pa.id, { holderName: 'Butterfold Foods', accountNumber: '999988887777', ifsc: 'icic0004321' });
    const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, pa.id));
    expect(account).toMatchObject({ holderName: 'Butterfold Foods', accountLast4: '7777', ifsc: 'ICIC0004321', status: 'pending' });
    expect((await db.select().from(documents).where(eq(documents.id, proof.id)))[0]).toMatchObject({ status: 'pending', rejectionReason: null });
    expect(await sectionOf(owner.id, outlet.id, 'bank')).toMatchObject({ state: 'waiting' });

    // Nothing left to fix, so it goes back for review, and can be approved.
    expect((await getOutletStatus(owner.id, outlet.id)).fixes.filter((f) => f.code !== 'changes_requested')).toEqual([]);
    await submitOutlet(owner.id, outlet.id, T0);
    for (const d of await db.select().from(documents).where(eq(documents.status, 'pending'))) await reviewDocument(admin.id, d.id, { approve: true }, T0);
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0);
    expect((await statusOf(outlet.id)).status).toBe('live');
  });

  test('changing approved PAN details sends that section back for review', async () => {
    const { owner, outlet, pa, admin } = await submitted();
    await decideOutlet(admin.id, outlet.id, { decision: 'request_changes', reason: 'Add a photo' }, T0);
    const pan = await docOf('pan', { payoutAccountId: pa.id });
    // Approved before it was sent back: reviewDocument would refuse now, so mark it as an earlier review did.
    await db.update(documents).set({ status: 'approved' }).where(eq(documents.id, pan.id));
    expect(await sectionOf(owner.id, outlet.id, 'pan')).toMatchObject({ state: 'approved' });
    await fixPanDetails(owner.id, pa.id, { legalName: 'Butterfold Foods LLP', pan: 'aajfb4821k' });
    expect(await sectionOf(owner.id, outlet.id, 'pan')).toMatchObject({ state: 'waiting' });
    expect((await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, pa.id)))[0]).toMatchObject({ legalName: 'Butterfold Foods LLP', panLast4: '821K' });
  });

  test('a new FSSAI number sends the licence back for review', async () => {
    const { owner, outlet, admin } = await submitted();
    const licence = await docOf('fssai', { outletId: outlet.id });
    await reviewDocument(admin.id, licence.id, { approve: false, reason: 'Number is wrong' }, T0);
    await saveOutletStep(owner.id, outlet.id, { fssaiNumber: '99999999999999' });
    expect((await db.select().from(documents).where(eq(documents.id, licence.id)))[0]!.status).toBe('pending');
    // The same number again changes nothing.
    await db.update(documents).set({ status: 'approved' }).where(eq(documents.id, licence.id));
    await saveOutletStep(owner.id, outlet.id, { fssaiNumber: '99999999999999' });
    expect((await db.select().from(documents).where(eq(documents.id, licence.id)))[0]!.status).toBe('approved');
  });

  test('details are locked under review, and a verified account is changed elsewhere', async () => {
    const { owner, outlet, pa } = await submitted();
    expect(await failure(fixBankDetails(owner.id, pa.id, PAYOUT))).toMatchObject({ code: 'not_editable' });
    await withdrawOutlet(owner.id, outlet.id);
    await db.update(payoutAccounts).set({ status: 'verified' }).where(eq(payoutAccounts.id, pa.id));
    expect(await failure(fixBankDetails(owner.id, pa.id, PAYOUT))).toMatchObject({ code: 'not_editable' });
    const stranger = await makeUser();
    expect(await failure(fixPanDetails(stranger.id, pa.id, PAYOUT))).toMatchObject({ status: 403 });
  });
});

describe('withdrawing to edit', () => {
  test('takes an application back to draft so it can change and go again', async () => {
    const { owner, outlet } = await submitted();
    expect(await failure(saveOutletStep(owner.id, outlet.id, { address: 'New place' }))).toMatchObject({ code: 'not_editable' });
    await withdrawOutlet(owner.id, outlet.id);
    expect((await statusOf(outlet.id)).status).toBe('draft');
    await saveOutletStep(owner.id, outlet.id, { address: 'New place' });
    await submitOutlet(owner.id, outlet.id, T0);
    expect((await statusOf(outlet.id)).status).toBe('in_review');
    await withdrawOutlet(owner.id, outlet.id);
    expect(await failure(withdrawOutlet(owner.id, outlet.id))).toMatchObject({ code: 'not_in_review' });
    const stranger = await makeUser();
    expect(await failure(withdrawOutlet(stranger.id, outlet.id))).toMatchObject({ status: 403 });
  });
});

describe('sections', () => {
  test('show approved, waiting and flagged parts', async () => {
    const { owner, outlet, pa, admin } = await submitted();
    await reviewDocument(admin.id, (await docOf('fssai', { outletId: outlet.id })).id, { approve: true }, T0);
    await reviewDocument(admin.id, (await docOf('pan', { payoutAccountId: pa.id })).id, { approve: false, reason: 'Blurred' }, T0);
    const { sections } = await getOutletStatus(owner.id, outlet.id);
    expect(sections).toEqual([
      { key: 'details', state: 'done' },
      { key: 'licence', state: 'approved' },
      { key: 'pan', state: 'needs_fix', reason: 'Blurred' },
      { key: 'bank', state: 'waiting' },
      { key: 'listing', state: 'done' },
      { key: 'agreement', state: 'done' },
    ]);
  });

  test('a fresh draft is all missing', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'New', branchName: 'HSR', category: 'cafe' });
    const { sections } = await getOutletStatus(owner.id, outlet.id);
    expect(sections.map((s) => s.state)).toEqual(['missing', 'missing', 'missing', 'missing', 'missing', 'missing']);
  });
});

describe('over HTTP', () => {
  test('the new vendor and admin routes answer', async () => {
    const { owner, outlet, pa, admin } = await submitted();
    const as = async (userId: string) => ({
      cookie: `session=${await createSession(userId, new Date())}`,
      origin: env().FRONTEND_ORIGIN,
      'content-type': 'application/json',
    });
    const vendor = await as(owner.id);
    expect((await app.request(`/api/v1/vendor/outlets/${outlet.id}/withdraw`, { method: 'POST', headers: vendor })).status).toBe(200);
    const fixed = await app.request(`/api/v1/vendor/payout-accounts/${pa.id}/bank`, {
      method: 'PATCH',
      headers: vendor,
      body: JSON.stringify({ holderName: 'X', accountNumber: '111122223333', ifsc: 'HDFC0001234' }),
    });
    expect(fixed.status).toBe(200);
    expect(JSON.stringify(await fixed.json())).not.toContain('111122223333');
    const tab = await app.request('/api/v1/admin/applications?tab=drafts', { headers: await as(admin.id) });
    expect(((await tab.json()) as { applications: { outlet: { id: string } }[] }).applications.map((a) => a.outlet.id)).toEqual([outlet.id]);
    const rows = await db.select().from(documents).where(and(eq(documents.payoutAccountId, pa.id), eq(documents.kind, 'bank_proof')));
    expect(rows.some((d) => d.status === 'pending')).toBe(true);
  });
});
