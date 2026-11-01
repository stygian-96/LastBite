import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { areas, auditLog, documents, memberships, outlets, payoutAccounts } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { FakeStore, setStore } from '../../src/integrations/storage.js';
import { createSession } from '../../src/modules/auth/session.js';
import { decideOutlet, listApplications, reviewDocument, updateOutletAdmin } from '../../src/modules/admin/review.js';
import { addDocument } from '../../src/modules/onboarding/documents.js';
import { saveOutletStep, startOutlet, submitOutlet } from '../../src/modules/onboarding/outlets.js';
import { createPayoutAccount, signAgreement } from '../../src/modules/onboarding/payout-accounts.js';
import { app } from '../../src/app.js';
import { makeBrand, makeListing, makeLiveOutlet, makePayoutAccount, makeUser } from '../helpers/factories.js';
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

async function submittedOutlet(brandName = 'Butterfold Bakery', fssai = '12345678901234') {
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
    fssaiNumber: fssai,
    fssaiExpiresOn: '2027-06-30',
    payoutAccountId: pa.id,
  });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'pan', fileKey: docKey(owner.id) });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'bank_proof', fileKey: docKey(owner.id) });
  await signAgreement(owner.id, pa.id, { signedName: 'A Founder', ip: '203.0.113.5', version: 'v1' }, T0);
  await makeListing({ outletId: outlet.id });
  await submitOutlet(owner.id, outlet.id, T0);
  return { owner, outlet, pa };
}

const docsOf = (outletId: string, payoutAccountId: string) =>
  db.select().from(documents).then((rows) => rows.filter((d) => d.outletId === outletId || d.payoutAccountId === payoutAccountId));

async function approveAll(adminId: string, outletId: string, payoutAccountId: string) {
  for (const d of await docsOf(outletId, payoutAccountId)) {
    if (d.status === 'pending') await reviewDocument(adminId, d.id, { approve: true }, T0);
  }
}

const statusOf = async (id: string) => (await db.select().from(outlets).where(eq(outlets.id, id)))[0]!.status;
const auditActions = async (entityId: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.entityId, entityId))).map((r) => r.action);

describe('routes', () => {
  const calls = (token: string | null) => {
    const id = randomUUID();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) {
      headers.cookie = `session=${token}`;
      headers.origin = env().FRONTEND_ORIGIN;
    }
    const req = (method: string, path: string, body?: unknown) =>
      app.request(`/api/v1/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return [
      () => req('GET', '/applications'),
      () => req('POST', `/documents/${id}/review`, { approve: true }),
      () => req('POST', `/outlets/${id}/decision`, { decision: 'approve' }),
      () => req('PATCH', `/outlets/${id}`, { commissionBps: 1500 }),
    ];
  };

  test('non-admin gets 403 on every admin route, signed-out gets 401', async () => {
    const user = await makeUser();
    const token = await createSession(user.id, new Date());
    for (const call of calls(token)) expect((await call()).status).toBe(403);
    for (const call of calls(null)) expect((await call()).status).toBe(401);
  });

  test('an admin can review over HTTP', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const token = await createSession(admin.id, new Date());
    const headers = { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN, 'content-type': 'application/json' };

    const list = await app.request('/api/v1/admin/applications', { headers });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { applications: { outlet: { id: string }; documents: { id: string }[] }[] };
    const app1 = body.applications.find((a) => a.outlet.id === outlet.id)!;
    for (const d of app1.documents) {
      const r = await app.request(`/api/v1/admin/documents/${d.id}/review`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ approve: true }),
      });
      expect(r.status).toBe(200);
    }
    const res = await app.request(`/api/v1/admin/outlets/${outlet.id}/decision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(200);
    expect(await statusOf(outlet.id)).toBe('live');
    const patch = await app.request(`/api/v1/admin/outlets/${outlet.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ commissionBps: 1500 }),
    });
    expect(patch.status).toBe(200);
    expect((await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, pa.id)))[0]!.status).toBe('verified');
  });
});

describe('listApplications', () => {
  test('lists in-review outlets with signed read links and no secrets', async () => {
    const { outlet } = await submittedOutlet();
    await makeLiveOutlet(); // live and clean: not in the queue
    const apps = await listApplications();
    expect(apps.map((a) => a.outlet.id)).toEqual([outlet.id]);
    const a = apps[0]!;
    expect(a.documents.map((d) => d.kind).sort()).toEqual(['bank_proof', 'fssai', 'pan']);
    for (const d of a.documents) expect(d.url).toMatch(/^https:\/\/fake-storage\.test\/private\/documents\//);
    expect(a.payoutAccount).toMatchObject({ panLast4: '821K', accountLast4: '9012' });
    expect(JSON.stringify(a)).not.toContain('panEncrypted');
    expect(JSON.stringify(a)).not.toContain('accountEncrypted');
  });

  test('warns when another outlet has the same FSSAI number', async () => {
    const one = await submittedOutlet('Brand One', '11111111111111');
    const two = await submittedOutlet('Brand Two', '11111111111111');
    const three = await submittedOutlet('Brand Three', '22222222222222');
    const apps = await listApplications();
    const byId = new Map(apps.map((a) => [a.outlet.id, a]));
    expect(byId.get(one.outlet.id)!.warnings).toEqual([
      expect.objectContaining({ code: 'duplicate_fssai', outletIds: [two.outlet.id] }),
    ]);
    expect(byId.get(two.outlet.id)!.warnings.map((w) => w.code)).toEqual(['duplicate_fssai']);
    expect(byId.get(three.outlet.id)!.warnings).toEqual([]);
  });

  test('a live outlet with a pending renewal shows up', async () => {
    const { owner, outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    await approveAll(admin.id, outlet.id, pa.id);
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0);
    expect(await listApplications()).toEqual([]);
    await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    const apps = await listApplications();
    expect(apps.map((a) => a.outlet.id)).toEqual([outlet.id]);
  });
});

describe('document review', () => {
  test('rejected document requires a reason and sets changes_needed', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const fssai = (await docsOf(outlet.id, pa.id)).find((d) => d.kind === 'fssai')!;

    expect((await failure(reviewDocument(admin.id, fssai.id, { approve: false }, T0)))?.status).toBe(400);
    expect((await failure(reviewDocument(admin.id, fssai.id, { approve: false, reason: '  ' }, T0)))?.status).toBe(400);
    expect((await db.select().from(documents).where(eq(documents.id, fssai.id)))[0]!.status).toBe('pending');
    expect(await statusOf(outlet.id)).toBe('in_review');

    await reviewDocument(admin.id, fssai.id, { approve: false, reason: 'Blurry photo' }, T0);
    const row = (await db.select().from(documents).where(eq(documents.id, fssai.id)))[0]!;
    expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'Blurry photo', reviewedBy: admin.id });
    expect(await statusOf(outlet.id)).toBe('changes_needed');
  });

  test('a rejected payout-account document sends the outlets on that account back for changes', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const pan = (await docsOf(outlet.id, pa.id)).find((d) => d.kind === 'pan')!;
    await reviewDocument(admin.id, pan.id, { approve: false, reason: 'Name mismatch' }, T0);
    expect(await statusOf(outlet.id)).toBe('changes_needed');
  });

  test('only the rejected document needs review after re-upload', async () => {
    const { owner, outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const all = await docsOf(outlet.id, pa.id);
    for (const d of all) {
      if (d.kind === 'fssai') await reviewDocument(admin.id, d.id, { approve: false, reason: 'Expired' }, T0);
      else await reviewDocument(admin.id, d.id, { approve: true }, T0);
    }
    await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    await submitOutlet(owner.id, outlet.id, T0);

    const [a] = await listApplications();
    expect(a!.outlet.id).toBe(outlet.id);
    expect(a!.documents.filter((d) => d.status === 'pending').map((d) => d.kind)).toEqual(['fssai']);
    expect(a!.documents.filter((d) => d.status === 'approved').map((d) => d.kind).sort()).toEqual(['bank_proof', 'pan']);
  });

  test('an already reviewed document cannot be reviewed again', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const d = (await docsOf(outlet.id, pa.id))[0]!;
    await reviewDocument(admin.id, d.id, { approve: true }, T0);
    const err = await failure(reviewDocument(admin.id, d.id, { approve: false, reason: 'x' }, T0));
    expect(err).toMatchObject({ status: 409, code: 'invalid_state' });
    expect((await failure(reviewDocument(admin.id, randomUUID(), { approve: true }, T0)))?.status).toBe(404);
  });

  test('approving a renewal on a live outlet retires the older approved file and can update the licence', async () => {
    const { owner, outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    await approveAll(admin.id, outlet.id, pa.id);
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0);

    const renewal = await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    const before = (await docsOf(outlet.id, pa.id)).filter((d) => d.kind === 'fssai' && d.status === 'approved');
    expect(before).toHaveLength(1);

    await reviewDocument(
      admin.id,
      renewal.id,
      { approve: true, fssaiNumber: '99999999999999', fssaiExpiresOn: '2028-06-30' },
      T0,
    );
    const fssai = (await docsOf(outlet.id, pa.id)).filter((d) => d.kind === 'fssai');
    expect(fssai.filter((d) => d.status === 'approved').map((d) => d.id)).toEqual([renewal.id]);
    expect(fssai.find((d) => d.id === before[0]!.id)!.status).toBe('replaced');
    const row = (await db.select().from(outlets).where(eq(outlets.id, outlet.id)))[0]!;
    expect(row).toMatchObject({ fssaiNumber: '99999999999999', fssaiExpiresOn: '2028-06-30', status: 'live' });
  });

  test('without the optional licence fields an approved renewal changes nothing else', async () => {
    const { owner, outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    await approveAll(admin.id, outlet.id, pa.id);
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0);
    const renewal = await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    await reviewDocument(admin.id, renewal.id, { approve: true }, T0);
    const row = (await db.select().from(outlets).where(eq(outlets.id, outlet.id)))[0]!;
    expect(row).toMatchObject({ fssaiNumber: '12345678901234', fssaiExpiresOn: '2027-06-30' });
  });

  test('licence fields are refused on a rejection, a non-FSSAI file or an outlet that is not live', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const docs = await docsOf(outlet.id, pa.id);
    const fssai = docs.find((d) => d.kind === 'fssai')!;
    const pan = docs.find((d) => d.kind === 'pan')!;
    const lic = { fssaiNumber: '99999999999999', fssaiExpiresOn: '2028-06-30' };
    expect((await failure(reviewDocument(admin.id, fssai.id, { approve: true, ...lic }, T0)))?.status).toBe(400);
    expect((await failure(reviewDocument(admin.id, pan.id, { approve: true, ...lic }, T0)))?.status).toBe(400);
    expect((await failure(reviewDocument(admin.id, fssai.id, { approve: false, reason: 'x', ...lic }, T0)))?.status).toBe(400);
    expect((await failure(reviewDocument(admin.id, fssai.id, { approve: true, fssaiNumber: '12' }, T0)))?.status).toBe(400);
    expect((await db.select().from(documents).where(eq(documents.id, fssai.id)))[0]!.status).toBe('pending');
  });

  test('approving a replacement bank proof retires the older approved one for that account', async () => {
    const { owner, outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    await approveAll(admin.id, outlet.id, pa.id);
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0);
    const next = await addDocument(owner.id, { outletId: outlet.id, kind: 'bank_proof', fileKey: docKey(owner.id) });
    await reviewDocument(admin.id, next.id, { approve: true }, T0);
    const proofs = (await docsOf(outlet.id, pa.id)).filter((d) => d.kind === 'bank_proof');
    expect(proofs.filter((d) => d.status === 'approved').map((d) => d.id)).toEqual([next.id]);
  });
});

describe('outlet decisions', () => {
  test('approve is blocked while a required document is pending', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const docs = await docsOf(outlet.id, pa.id);
    for (const d of docs.filter((x) => x.kind !== 'bank_proof')) await reviewDocument(admin.id, d.id, { approve: true }, T0);

    const err = await failure(decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0));
    expect(err).toMatchObject({ status: 409, code: 'documents_pending' });
    expect(err!.details?.fixes).toEqual([expect.objectContaining({ code: 'bank_proof_document_pending' })]);
    expect(await statusOf(outlet.id)).toBe('in_review');
    expect((await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, pa.id)))[0]!.status).toBe('pending');
  });

  test('approve moves outlet to live and verifies the payout account', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    await approveAll(admin.id, outlet.id, pa.id);
    await decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0);
    expect(await statusOf(outlet.id)).toBe('live');
    expect((await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, pa.id)))[0]!.status).toBe('verified');
  });

  test('approve refuses a payout account that is on hold', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    await approveAll(admin.id, outlet.id, pa.id);
    await db.update(payoutAccounts).set({ status: 'on_hold' }).where(eq(payoutAccounts.id, pa.id));
    const err = await failure(decideOutlet(admin.id, outlet.id, { decision: 'approve' }, T0));
    expect(err).toMatchObject({ status: 409, code: 'payout_account_unavailable' });
    expect(await statusOf(outlet.id)).toBe('in_review');
  });

  test('request_changes sends an in-review outlet back to the vendor', async () => {
    const { outlet } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    await decideOutlet(admin.id, outlet.id, { decision: 'request_changes', reason: 'Photos missing' }, T0);
    expect(await statusOf(outlet.id)).toBe('changes_needed');
  });

  test('suspended outlet can be reinstated, closed cannot', async () => {
    const admin = await makeUser({ isAdmin: true });
    const live = await makeLiveOutlet();
    await decideOutlet(admin.id, live.id, { decision: 'suspend', reason: 'Food safety' }, T0);
    expect(await statusOf(live.id)).toBe('suspended');
    await decideOutlet(admin.id, live.id, { decision: 'reinstate' }, T0);
    expect(await statusOf(live.id)).toBe('live');

    await decideOutlet(admin.id, live.id, { decision: 'suspend' }, T0);
    await decideOutlet(admin.id, live.id, { decision: 'close' }, T0);
    expect(await statusOf(live.id)).toBe('closed');
    for (const decision of ['approve', 'request_changes', 'suspend', 'reinstate', 'close'] as const) {
      expect(await failure(decideOutlet(admin.id, live.id, { decision }, T0))).toMatchObject({
        status: 409,
        code: 'invalid_state',
      });
    }
    expect(await statusOf(live.id)).toBe('closed');
  });

  test('close works from live, and reinstate only from suspended', async () => {
    const admin = await makeUser({ isAdmin: true });
    const a = await makeLiveOutlet();
    expect(await failure(decideOutlet(admin.id, a.id, { decision: 'reinstate' }, T0))).toMatchObject({ code: 'invalid_state' });
    await decideOutlet(admin.id, a.id, { decision: 'close' }, T0);
    expect(await statusOf(a.id)).toBe('closed');
  });

  test('other transitions are rejected with 409 invalid_state', async () => {
    const admin = await makeUser({ isAdmin: true });
    const live = await makeLiveOutlet();
    const draft = await makeLiveOutlet({ status: 'draft' });
    const review = await makeLiveOutlet({ status: 'in_review' });
    const cases: [string, 'approve' | 'request_changes' | 'suspend' | 'reinstate' | 'close'][] = [
      [live.id, 'approve'],
      [live.id, 'request_changes'],
      [draft.id, 'approve'],
      [draft.id, 'suspend'],
      [draft.id, 'close'],
      [review.id, 'suspend'],
      [review.id, 'close'],
      [review.id, 'reinstate'],
    ];
    for (const [id, decision] of cases) {
      expect(await failure(decideOutlet(admin.id, id, { decision }, T0))).toMatchObject({ status: 409, code: 'invalid_state' });
    }
    expect((await failure(decideOutlet(admin.id, randomUUID(), { decision: 'close' }, T0)))?.status).toBe(404);
    expect((await failure(decideOutlet(admin.id, live.id, { decision: 'nope' as 'close' }, T0)))?.status).toBe(400);
  });

  test('every decision writes to audit_log', async () => {
    const { outlet, pa } = await submittedOutlet();
    const admin = await makeUser({ isAdmin: true });
    const doc = (await docsOf(outlet.id, pa.id)).find((d) => d.kind === 'fssai')!;
    await reviewDocument(admin.id, doc.id, { approve: false, reason: 'Blurry' }, T0);
    expect(await auditActions(doc.id)).toContain('document.reject');
    await approveAll(admin.id, outlet.id, pa.id);

    const live = await makeLiveOutlet();
    for (const decision of ['suspend', 'reinstate', 'close'] as const) {
      await decideOutlet(admin.id, live.id, { decision }, T0);
    }
    expect((await auditActions(live.id)).filter((a) => a.startsWith('outlet.')).sort()).toEqual([
      'outlet.close',
      'outlet.reinstate',
      'outlet.suspend',
    ]);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, live.id));
    expect(rows.every((r) => r.actorId === admin.id)).toBe(true);
    await updateOutletAdmin(admin.id, live.id, { commissionBps: 1000 });
    expect(await auditActions(live.id)).toContain('outlet.admin_update');
  });
});

describe('updateOutletAdmin', () => {
  test('sets commission within bounds', async () => {
    const admin = await makeUser({ isAdmin: true });
    const o = await makeLiveOutlet();
    await updateOutletAdmin(admin.id, o.id, { commissionBps: 1500 });
    expect((await db.select().from(outlets).where(eq(outlets.id, o.id)))[0]!.commissionBps).toBe(1500);
    for (const bad of [-1, 10001, 12.5]) {
      expect((await failure(updateOutletAdmin(admin.id, o.id, { commissionBps: bad })))?.status).toBe(400);
    }
    expect((await failure(updateOutletAdmin(admin.id, randomUUID(), { commissionBps: 100 })))?.status).toBe(404);
  });

  test('admin can move an outlet to another brand, taking its sole payout account and staff along', async () => {
    const admin = await makeUser({ isAdmin: true });
    const oldBrand = await makeBrand();
    const newBrand = await makeBrand();
    const pa = await makePayoutAccount({ brandId: oldBrand.id });
    const o = await makeLiveOutlet({ brandId: oldBrand.id, payoutAccountId: pa.id, slug: 'indiranagar' });
    await makeLiveOutlet({ brandId: newBrand.id, slug: 'indiranagar' }); // slug taken in the new brand
    const staff = await makeUser();
    const [m] = await db
      .insert(memberships)
      .values({ userId: staff.id, brandId: oldBrand.id, outletId: o.id, role: 'manager', payoutAccountId: pa.id })
      .returning();
    const oldOwner = await makeUser();
    const [om] = await db
      .insert(memberships)
      .values({ userId: oldOwner.id, brandId: oldBrand.id, outletId: null, role: 'owner', payoutAccountId: pa.id })
      .returning();

    await updateOutletAdmin(admin.id, o.id, { brandId: newBrand.id });

    const row = (await db.select().from(outlets).where(eq(outlets.id, o.id)))[0]!;
    expect(row.brandId).toBe(newBrand.id);
    expect(row.slug).toBe('indiranagar-2');
    expect((await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, pa.id)))[0]!.brandId).toBe(newBrand.id);
    const staffRow = (await db.select().from(memberships).where(eq(memberships.id, m!.id)))[0]!;
    expect(staffRow).toMatchObject({ brandId: newBrand.id, payoutAccountId: pa.id });
    // The old brand's own owner keeps their old brand but no longer names the moved account.
    const ownerRow = (await db.select().from(memberships).where(eq(memberships.id, om!.id)))[0]!;
    expect(ownerRow).toMatchObject({ brandId: oldBrand.id, payoutAccountId: null });
    expect(await auditActions(o.id)).toContain('outlet.admin_update');
  });

  test('rejects a move while another outlet shares the payout account', async () => {
    const admin = await makeUser({ isAdmin: true });
    const oldBrand = await makeBrand();
    const newBrand = await makeBrand();
    const pa = await makePayoutAccount({ brandId: oldBrand.id });
    const o = await makeLiveOutlet({ brandId: oldBrand.id, payoutAccountId: pa.id });
    await makeLiveOutlet({ brandId: oldBrand.id, payoutAccountId: pa.id });
    const err = await failure(updateOutletAdmin(admin.id, o.id, { brandId: newBrand.id }));
    expect(err).toMatchObject({ status: 409, code: 'payout_account_shared' });
    expect((await db.select().from(outlets).where(eq(outlets.id, o.id)))[0]!.brandId).toBe(oldBrand.id);
    expect((await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, pa.id)))[0]!.brandId).toBe(oldBrand.id);
  });

  test('a payout account already in the target brand stays put; an unknown brand is a 404', async () => {
    const admin = await makeUser({ isAdmin: true });
    const oldBrand = await makeBrand();
    const newBrand = await makeBrand();
    const pa = await makePayoutAccount({ brandId: newBrand.id });
    const o = await makeLiveOutlet({ brandId: oldBrand.id, payoutAccountId: pa.id });
    expect((await failure(updateOutletAdmin(admin.id, o.id, { brandId: randomUUID() })))?.status).toBe(404);
    await updateOutletAdmin(admin.id, o.id, { brandId: newBrand.id });
    const row = (await db.select().from(outlets).where(eq(outlets.id, o.id)))[0]!;
    expect(row).toMatchObject({ brandId: newBrand.id, payoutAccountId: pa.id });
    // Moving to the brand it is already in changes nothing.
    await updateOutletAdmin(admin.id, o.id, { brandId: newBrand.id });
  });

  test('a move with no outlet-scoped memberships and no account leaves no dangling rows', async () => {
    const admin = await makeUser({ isAdmin: true });
    const oldBrand = await makeBrand();
    const newBrand = await makeBrand();
    const o = await makeLiveOutlet({ brandId: oldBrand.id });
    await db.update(outlets).set({ payoutAccountId: null }).where(eq(outlets.id, o.id));
    await updateOutletAdmin(admin.id, o.id, { brandId: newBrand.id });
    expect(await db.select().from(memberships).where(and(eq(memberships.brandId, oldBrand.id)))).toEqual([]);
  });
});
