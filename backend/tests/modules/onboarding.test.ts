import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { agreements, areas, auditLog, brands, documents, memberships, outlets, payoutAccounts } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { ApiError } from '../../src/lib/errors.js';
import { FakeStore, setStore } from '../../src/integrations/storage.js';
import { createSession } from '../../src/modules/auth/session.js';
import { addDocument } from '../../src/modules/onboarding/documents.js';
import { getOutletStatus, saveOutletStep, startOutlet, submitOutlet } from '../../src/modules/onboarding/outlets.js';
import { createPayoutAccount, signAgreement } from '../../src/modules/onboarding/payout-accounts.js';
import { app } from '../../src/app.js';
import { makeBrand, makeListing, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

const T0 = new Date('2026-11-01T10:00:00Z');
const MB = 1024 * 1024;

let store: FakeStore;
beforeEach(async () => {
  await resetDb();
  store = new FakeStore();
  setStore(store);
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
const HOURS = { mon: [['08:00', '22:00']], tue: [['08:00', '22:00']] };
const docKey = (userId: string) => `documents/${userId}/${randomUUID()}.pdf`;

async function areaId() {
  const [a] = await db.select({ id: areas.id }).from(areas).limit(1);
  return a!.id;
}

/** Everything an outlet needs to pass details, except documents, payout account, agreement and listing. */
async function fillDetails(userId: string, outletId: string, extra: Record<string, unknown> = {}) {
  return saveOutletStep(userId, outletId, {
    address: '12 Church Street',
    pincode: '560001',
    areaId: await areaId(),
    mapsUrl: 'https://maps.app.goo.gl/abc123',
    contactPhone: '9876543210',
    openingHours: HOURS,
    fssaiNumber: '12345678901234',
    fssaiExpiresOn: '2027-06-30',
    ...extra,
  });
}

/** A first outlet taken all the way to ready-to-submit. */
async function readyOutlet() {
  const owner = await makeUser();
  const outlet = await startOutlet(owner.id, {
    brandName: 'Butterfold Bakery',
    branchName: 'Indiranagar',
    category: 'bakery',
  });
  const pa = await createPayoutAccount(owner.id, outlet.brandId, PAYOUT);
  await fillDetails(owner.id, outlet.id, { payoutAccountId: pa.id });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'pan', fileKey: docKey(owner.id) });
  await addDocument(owner.id, { outletId: outlet.id, kind: 'bank_proof', fileKey: docKey(owner.id) });
  await signAgreement(owner.id, pa.id, { signedName: 'A Founder', ip: '203.0.113.5', version: 'v1' }, T0);
  await makeListing({ outletId: outlet.id });
  return { owner, outlet, pa };
}

const codes = (r: { fixes: { code: string }[] }) => r.fixes.map((f) => f.code).sort();

describe('starting an outlet', () => {
  test('first outlet creates the brand and an owner membership', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, {
      brandName: 'Butterfold Bakery',
      branchName: 'Indiranagar',
      category: 'bakery',
    });
    expect(outlet).toMatchObject({ slug: 'indiranagar', status: 'draft', onboardingStep: 1, payoutAccountId: null });
    const [brand] = await db.select().from(brands).where(eq(brands.id, outlet.brandId));
    expect(brand).toMatchObject({ name: 'Butterfold Bakery', slug: 'butterfold-bakery', createdBy: owner.id });
    const ms = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ brandId: brand!.id, outletId: null, role: 'owner', removedAt: null });
    const log = await db.select().from(auditLog).where(eq(auditLog.entityId, outlet.id));
    expect(log.map((l) => l.action)).toContain('outlet.start');
  });

  test('slugs clash with a numeric suffix', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const first = await startOutlet(a.id, { brandName: 'Butterfold Bakery!', branchName: 'Koramangala 5th Block', category: 'bakery' });
    const other = await startOutlet(b.id, { brandName: 'Butterfold Bakery', branchName: 'X', category: 'cafe' });
    expect(first.slug).toBe('koramangala-5th-block');
    const [brand1] = await db.select().from(brands).where(eq(brands.id, first.brandId));
    const [brand2] = await db.select().from(brands).where(eq(brands.id, other.brandId));
    expect(brand1!.slug).toBe('butterfold-bakery');
    expect(brand2!.slug).toBe('butterfold-bakery-2');

    const again = await startOutlet(a.id, { brandId: first.brandId, branchName: 'Koramangala 5th Block', category: 'bakery' });
    expect(again.slug).toBe('koramangala-5th-block-2');
    expect(again.brandId).toBe(first.brandId);
  });

  test('adding to an existing brand needs the brand owner', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const brand = await makeBrand({ createdBy: owner.id });
    await db.insert(memberships).values({ userId: owner.id, brandId: brand.id, role: 'owner' });
    const err = await failure(startOutlet(stranger.id, { brandId: brand.id, branchName: 'Hack', category: 'cafe' }));
    expect(err).toMatchObject({ code: 'forbidden', status: 403 });
    expect(await failure(startOutlet(owner.id, { branchName: 'No brand', category: 'cafe' }))).toMatchObject({ status: 400 });
    expect(await failure(startOutlet(owner.id, { brandId: brand.id, branchName: 'Odd', category: 'spa' as 'cafe' }))).toMatchObject({ status: 400 });
  });
});

describe('saving steps', () => {
  test('step saves persist and onboarding_step advances', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });

    const saved = await saveOutletStep(owner.id, outlet.id, {
      step: 1,
      address: '12 Church Street',
      pincode: '560001',
      contactPhone: '9876543210',
      pickupInstructions: 'Ask at the counter',
    });
    expect(saved).toMatchObject({ address: '12 Church Street', pincode: '560001', onboardingStep: 2 });

    // An earlier step saved later does not move the user backwards.
    await saveOutletStep(owner.id, outlet.id, { step: 3, openingHours: HOURS, photoKeys: [] });
    const back = await saveOutletStep(owner.id, outlet.id, { step: 1, address: '14 Church Street' });
    expect(back.onboardingStep).toBe(4);

    const [row] = await db.select().from(outlets).where(eq(outlets.id, outlet.id));
    expect(row).toMatchObject({ address: '14 Church Street', pincode: '560001', openingHours: HOURS, onboardingStep: 4 });
    expect(row!.contactPhone).toBe('+919876543210');
  });

  test('photo keys must be the caller\'s own uploads', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    const mine = `photos/${owner.id}/${randomUUID()}.jpg`;
    expect((await saveOutletStep(owner.id, outlet.id, { photoKeys: [mine] })).photoKeys).toEqual([mine]);
    const theirs = `photos/${randomUUID()}/${randomUUID()}.jpg`;
    expect(await failure(saveOutletStep(owner.id, outlet.id, { photoKeys: [theirs] }))).toMatchObject({ status: 400 });
  });

  test('invalid FSSAI, PAN, IFSC and GSTIN formats return 400', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    for (const bad of [
      { fssaiNumber: '1234567890123' },
      { fssaiNumber: '1234567890123A' },
      { gstin: '29AAJFB4821K1Z' },
      { pincode: '56001' },
      { pincode: '5600011' },
      { fssaiExpiresOn: '30/06/2027' },
      { openingHours: { mon: [['8am', '10pm']] } },
    ]) {
      expect(await failure(saveOutletStep(owner.id, outlet.id, bad)), JSON.stringify(bad)).toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
    }
    const brandId = outlet.brandId;
    for (const bad of [{ pan: 'AAJFB4821' }, { pan: 'aajfb4821k' + '1' }, { ifsc: 'HDFC1001234' }, { ifsc: 'HDFC000123' }, { accountNumber: '12ab' }]) {
      expect(await failure(createPayoutAccount(owner.id, brandId, { ...PAYOUT, ...bad })), JSON.stringify(bad)).toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
    }
    // Valid values pass.
    await saveOutletStep(owner.id, outlet.id, { fssaiNumber: '12345678901234', gstin: '29AAJFB4821K1Z5' });
  });

  test('maps_url must be https on a Google Maps host', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    for (const ok of [
      'https://maps.google.com/?q=bakery',
      'https://www.google.com/maps/place/Butterfold',
      'https://maps.app.goo.gl/abc123',
      'https://goo.gl/maps/xyz',
    ]) {
      expect((await saveOutletStep(owner.id, outlet.id, { mapsUrl: ok })).mapsUrl).toBe(ok);
    }
    for (const bad of [
      'http://maps.google.com/?q=bakery',
      'https://www.google.com/search?q=bakery',
      'https://evil.example/maps',
      'https://maps.google.com.evil.example/',
      'https://goo.gl/other',
      'not a url',
    ]) {
      expect(await failure(saveOutletStep(owner.id, outlet.id, { mapsUrl: bad })), bad).toMatchObject({ status: 400 });
    }
  });

  test('only members of the outlet can change it, and only before review', async () => {
    const { owner, outlet } = await readyOutlet();
    const stranger = await makeUser();
    expect(await failure(saveOutletStep(stranger.id, outlet.id, { address: 'x' }))).toMatchObject({ status: 403 });
    expect(await failure(submitOutlet(stranger.id, outlet.id, T0))).toMatchObject({ status: 403 });
    expect(await failure(getOutletStatus(stranger.id, outlet.id))).toMatchObject({ status: 403 });
    await submitOutlet(owner.id, outlet.id, T0);
    expect(await failure(saveOutletStep(owner.id, outlet.id, { address: 'changed' }))).toMatchObject({
      code: 'not_editable',
      status: 409,
    });
  });
});

describe('payout accounts and agreements', () => {
  test('payout account stores PAN and account encrypted, last 4 in clear', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    const a = await createPayoutAccount(owner.id, outlet.brandId, { ...PAYOUT, ifsc: 'hdfc0001234' });
    expect(a.panLast4).toBe('821K');
    expect(a.accountLast4).toBe('9012');
    expect(a.ifsc).toBe('HDFC0001234');
    expect(a.status).toBe('pending');
    expect(a.panEncrypted.toString()).not.toContain('AAJFB4821K');
    expect(a.panEncrypted.toString('latin1')).not.toContain('AAJFB4821K');
    expect(a.accountEncrypted.toString('latin1')).not.toContain('123456789012');
    const log = JSON.stringify(await db.select().from(auditLog), (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    expect(log).not.toContain('AAJFB4821K');
    expect(log).not.toContain('123456789012');
  });

  test('only the brand owner can add a payout account', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    expect(await failure(createPayoutAccount(stranger.id, outlet.brandId, PAYOUT))).toMatchObject({ status: 403 });
  });

  test('signing records name, ip, version and time, and repeating it is harmless', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    const pa = await createPayoutAccount(owner.id, outlet.brandId, PAYOUT);
    const input = { signedName: 'A Founder', ip: '203.0.113.5', version: 'v1' };
    await signAgreement(owner.id, pa.id, input, T0);
    await signAgreement(owner.id, pa.id, input, new Date(T0.getTime() + 60_000));
    const rows = await db.select().from(agreements).where(eq(agreements.payoutAccountId, pa.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signedName: 'A Founder', signedBy: owner.id, version: 'v1' });
    expect(rows[0]!.ipAddress).toBe('203.0.113.5');
    expect(new Date(rows[0]!.signedAt).getTime()).toBe(T0.getTime());
    expect(await failure(signAgreement(owner.id, pa.id, { ...input, ip: 'nope' }, T0))).toMatchObject({ status: 400 });
    expect(await failure(signAgreement(owner.id, pa.id, { ...input, signedName: ' ' }, T0))).toMatchObject({ status: 400 });
    const stranger = await makeUser();
    expect(await failure(signAgreement(stranger.id, pa.id, { ...input, version: 'v2' }, T0))).toMatchObject({ status: 403 });
  });
});

describe('documents', () => {
  test('kinds attach to the right owner and keys must be the caller\'s own uploads', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    const pa = await createPayoutAccount(owner.id, outlet.brandId, PAYOUT);

    // No payout account on the outlet yet, and none named.
    expect(await failure(addDocument(owner.id, { outletId: outlet.id, kind: 'pan', fileKey: docKey(owner.id) }))).toMatchObject({ status: 400 });
    const pan = await addDocument(owner.id, { outletId: outlet.id, kind: 'pan', fileKey: docKey(owner.id), payoutAccountId: pa.id });
    expect(pan).toMatchObject({ kind: 'pan', payoutAccountId: pa.id, outletId: null, status: 'pending' });
    const fssai = await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    expect(fssai).toMatchObject({ kind: 'fssai', outletId: outlet.id, payoutAccountId: null });

    expect(await failure(addDocument(owner.id, { outletId: outlet.id, kind: 'gst', fileKey: docKey(randomUUID()) }))).toMatchObject({ status: 400 });
    expect(await failure(addDocument(owner.id, { outletId: outlet.id, kind: 'gst', fileKey: docKey(owner.id), payoutAccountId: pa.id }))).toMatchObject({ status: 400 });

    // An account from another brand is refused.
    const otherBrand = await makeUser();
    const o2 = await startOutlet(otherBrand.id, { brandName: 'Other', branchName: 'Main', category: 'cafe' });
    const pa2 = await createPayoutAccount(otherBrand.id, o2.brandId, PAYOUT);
    expect(await failure(addDocument(owner.id, { outletId: outlet.id, kind: 'pan', fileKey: docKey(owner.id), payoutAccountId: pa2.id }))).toMatchObject({ status: 400 });
  });

  test('re-uploading replaces the rejected document and clears the fix', async () => {
    const { owner, outlet } = await readyOutlet();
    const [doc] = await db.select().from(documents).where(and(eq(documents.outletId, outlet.id), eq(documents.kind, 'fssai')));
    await db.update(documents).set({ status: 'rejected', rejectionReason: 'Photo is blurry' }).where(eq(documents.id, doc!.id));

    const before = await getOutletStatus(owner.id, outlet.id);
    expect(before.fixes).toEqual([{ code: 'fssai_document_rejected', message: expect.stringContaining('Photo is blurry') }]);

    const fresh = await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    expect(fresh.status).toBe('pending');
    const rows = await db.select().from(documents).where(and(eq(documents.outletId, outlet.id), eq(documents.kind, 'fssai')));
    expect(rows.find((r) => r.id === doc!.id)!.status).toBe('replaced');
    expect((await getOutletStatus(owner.id, outlet.id)).fixes).toEqual([]);
  });
});

describe('documents after review', () => {
  const fssaiRows = (outletId: string) =>
    db.select().from(documents).where(and(eq(documents.outletId, outletId), eq(documents.kind, 'fssai')));

  test('draft and changes_needed replace an approved document', async () => {
    const { owner, outlet } = await readyOutlet();
    await db.update(documents).set({ status: 'approved' }).where(eq(documents.kind, 'fssai'));
    await db.update(outlets).set({ status: 'changes_needed' }).where(eq(outlets.id, outlet.id));
    await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    expect((await fssaiRows(outlet.id)).map((r) => r.status).sort()).toEqual(['pending', 'replaced']);
  });

  test('in_review refuses new documents', async () => {
    const { owner, outlet } = await readyOutlet();
    await submitOutlet(owner.id, outlet.id, T0);
    expect(await failure(addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) }))).toMatchObject({
      code: 'not_editable',
      status: 409,
    });
    expect(await fssaiRows(outlet.id)).toHaveLength(1);
  });

  test('live outlet adds a pending renewal and the approved file stays in force', async () => {
    const { owner, outlet, pa } = await readyOutlet();
    await db.update(documents).set({ status: 'approved' });
    await db.update(outlets).set({ status: 'live' }).where(eq(outlets.id, outlet.id));

    const fresh = await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    expect(fresh.status).toBe('pending');
    expect((await fssaiRows(outlet.id)).map((r) => r.status).sort()).toEqual(['approved', 'pending']);

    // A second renewal supersedes the first pending one but never the approved one.
    await addDocument(owner.id, { outletId: outlet.id, kind: 'fssai', fileKey: docKey(owner.id) });
    expect((await fssaiRows(outlet.id)).map((r) => r.status).sort()).toEqual(['approved', 'pending', 'replaced']);

    // Payout-account documents follow the same rule.
    await addDocument(owner.id, { outletId: outlet.id, kind: 'pan', fileKey: docKey(owner.id) });
    const pan = await db.select().from(documents).where(and(eq(documents.payoutAccountId, pa.id), eq(documents.kind, 'pan')));
    expect(pan.map((r) => r.status).sort()).toEqual(['approved', 'pending']);
  });
});

describe('submitting', () => {
  test('submit lists every missing item', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });

    const err = await failure(submitOutlet(owner.id, outlet.id, T0));
    expect(err).toMatchObject({ code: 'incomplete', status: 422 });
    const fixes = (err!.details as { fixes: { code: string; message: string }[] }).fixes;
    expect(fixes.map((f) => f.code).sort()).toEqual(
      [
        'address_missing',
        'agreement_missing',
        'area_missing',
        'bank_proof_document_missing',
        'fssai_details_missing',
        'fssai_document_missing',
        'hours_missing',
        'listing_missing',
        'maps_url_missing',
        'pan_document_missing',
        'payout_account_missing',
      ].sort(),
    );
    for (const f of fixes) expect(f.message.length).toBeGreaterThan(5);
    const [row] = await db.select().from(outlets).where(eq(outlets.id, outlet.id));
    expect(row).toMatchObject({ status: 'draft', submittedAt: null });
  });

  test('changes_needed never shows with no fixes, even when nothing is missing', async () => {
    const { owner, outlet } = await readyOutlet();
    await db.update(outlets).set({ status: 'changes_needed' }).where(eq(outlets.id, outlet.id));
    expect(codes(await getOutletStatus(owner.id, outlet.id))).toEqual(['changes_requested']);
  });

  test('a reason for changes does not block a resubmission, and goes with it', async () => {
    const { owner, outlet } = await readyOutlet();
    await db.update(outlets).set({ status: 'changes_needed', changesReason: 'Fix the hours' }).where(eq(outlets.id, outlet.id));

    const submitted = await submitOutlet(owner.id, outlet.id, T0);

    expect(submitted).toMatchObject({ status: 'in_review', changesReason: null });
  });

  test('the 422 body carries the fixes in the error envelope', async () => {
    const owner = await makeUser();
    const outlet = await startOutlet(owner.id, { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    const token = await createSession(owner.id, new Date());
    const res = await app.request(`/api/v1/vendor/outlets/${outlet.id}/submit`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string; fixes: { code: string; message: string }[] } };
    expect(body.error.code).toBe('incomplete');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.fixes.map((f) => f.code)).toContain('listing_missing');
  });

  test('submit moves a complete outlet to in_review', async () => {
    const { owner, outlet } = await readyOutlet();
    const status = await getOutletStatus(owner.id, outlet.id);
    expect(status).toMatchObject({ status: 'draft', fixes: [] });
    expect(status.steps.every((s) => s.done)).toBe(true);

    const submitted = await submitOutlet(owner.id, outlet.id, T0);
    expect(submitted.status).toBe('in_review');
    expect(new Date(submitted.submittedAt!).getTime()).toBe(T0.getTime());
    expect((await getOutletStatus(owner.id, outlet.id)).status).toBe('in_review');
    expect(await failure(submitOutlet(owner.id, outlet.id, T0))).toMatchObject({ code: 'not_submittable', status: 409 });
  });

  test('a rejected PAN document shows up as a fix', async () => {
    const { owner, outlet } = await readyOutlet();
    await db.update(documents).set({ status: 'rejected', rejectionReason: 'Wrong name' }).where(eq(documents.kind, 'pan'));
    const s = await getOutletStatus(owner.id, outlet.id);
    expect(codes(s)).toEqual(['pan_document_rejected']);
    expect(s.steps.find((x) => !x.done)).toBeDefined();
  });

  test('second outlet reuses payout account and needs only its own FSSAI', async () => {
    const { owner, outlet: first, pa } = await readyOutlet();
    await db.update(payoutAccounts).set({ status: 'verified' }).where(eq(payoutAccounts.id, pa.id));

    const second = await startOutlet(owner.id, { brandId: first.brandId, branchName: 'Koramangala', category: 'bakery' });
    expect(second.brandId).toBe(first.brandId);
    await fillDetails(owner.id, second.id, { payoutAccountId: pa.id, fssaiNumber: '98765432109876' });
    await makeListing({ outletId: second.id });

    // PAN, bank proof and the agreement already exist on the account; the licence does not.
    expect(codes(await getOutletStatus(owner.id, second.id))).toEqual(['fssai_document_missing']);
    await addDocument(owner.id, { outletId: second.id, kind: 'fssai', fileKey: docKey(owner.id) });
    expect((await getOutletStatus(owner.id, second.id)).fixes).toEqual([]);
    expect((await submitOutlet(owner.id, second.id, T0)).status).toBe('in_review');
    expect(await db.select().from(documents).where(eq(documents.payoutAccountId, pa.id))).toHaveLength(2);
  });

  test('a payout account from another brand cannot be attached', async () => {
    const { owner, outlet } = await readyOutlet();
    const other = await makeUser();
    const o2 = await startOutlet(other.id, { brandName: 'Other', branchName: 'Main', category: 'cafe' });
    const pa2 = await createPayoutAccount(other.id, o2.brandId, PAYOUT);
    expect(await failure(saveOutletStep(owner.id, outlet.id, { payoutAccountId: pa2.id }))).toMatchObject({ status: 400 });
    expect(await failure(saveOutletStep(owner.id, outlet.id, { payoutAccountId: randomUUID() }))).toMatchObject({ status: 400 });
  });

  test('duplicate FSSAI does not block submit', async () => {
    const a = await readyOutlet();
    const b = await readyOutlet();
    const [x] = await db.select().from(outlets).where(eq(outlets.id, a.outlet.id));
    const [y] = await db.select().from(outlets).where(eq(outlets.id, b.outlet.id));
    expect(x!.fssaiNumber).toBe(y!.fssaiNumber);
    expect((await submitOutlet(a.owner.id, a.outlet.id, T0)).status).toBe('in_review');
    expect((await submitOutlet(b.owner.id, b.outlet.id, T0)).status).toBe('in_review');
  });
});

describe('uploads', () => {
  const post = async (userId: string | null, body: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: env().FRONTEND_ORIGIN };
    if (userId) headers.cookie = `session=${await createSession(userId, new Date())}`;
    return app.request('/api/v1/vendor/uploads', { method: 'POST', headers, body: JSON.stringify(body) });
  };

  test('returns a key and a signed url, public for photos and private for documents', async () => {
    const user = await makeUser();
    const photo = await post(user.id, { purpose: 'photo', contentType: 'image/jpeg', size: 2 * MB });
    expect(photo.status).toBe(200);
    const p = (await photo.json()) as { key: string; url: string };
    expect(p.key).toMatch(new RegExp(`^photos/${user.id}/[0-9a-f-]{36}\\.jpg$`));
    expect(p.url).toContain(p.key);
    expect(store.uploads.at(-1)).toMatchObject({ key: p.key, contentType: 'image/jpeg', bucket: 'public', sizeBytes: 2 * MB });

    const doc = await post(user.id, { purpose: 'document', contentType: 'application/pdf', size: 10 * MB });
    expect(doc.status).toBe(200);
    const d = (await doc.json()) as { key: string };
    expect(d.key).toMatch(new RegExp(`^documents/${user.id}/[0-9a-f-]{36}\\.pdf$`));
    expect(store.uploads.at(-1)).toMatchObject({ bucket: 'private' });

    const again = (await (await post(user.id, { purpose: 'photo', contentType: 'image/jpeg', size: 1 })).json()) as { key: string };
    expect(again.key).not.toBe(p.key);
  });

  test('upload rejects other content types and files over 10 MB', async () => {
    const user = await makeUser();
    const before = store.uploads.length;
    for (const bad of [
      { purpose: 'photo', contentType: 'text/html', size: 100 },
      { purpose: 'document', contentType: 'application/zip', size: 100 },
      { purpose: 'photo', contentType: 'application/pdf', size: 100 },
      { purpose: 'photo', contentType: 'image/svg+xml', size: 100 },
      { purpose: 'logo', contentType: 'image/gif', size: 100 },
      { purpose: 'document', contentType: 'application/pdf', size: 10 * MB + 1 },
      { purpose: 'photo', contentType: 'image/png', size: 0 },
      { purpose: 'photo', contentType: 'image/png' },
      { purpose: 'selfie', contentType: 'image/png', size: 100 },
    ]) {
      const res = await post(user.id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(store.uploads.length).toBe(before);
    expect((await post(null, { purpose: 'photo', contentType: 'image/png', size: 100 })).status).toBe(401);
  });
});

describe('routes', () => {
  test('start, pay, sign and submit over HTTP', async () => {
    const owner = await makeUser();
    const token = await createSession(owner.id, new Date());
    const headers = { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const res = await app.request(`/api/v1/vendor${path}`, {
        method,
        headers: { ...headers, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    const started = await call('POST', '/outlets', { brandName: 'Cafe One', branchName: 'Main', category: 'cafe' });
    expect(started.status).toBe(200);
    const outletId = started.json.outlet.id as string;
    const brandId = started.json.outlet.brandId as string;

    const pa = await call('POST', '/payout-accounts', { brandId, ...PAYOUT });
    expect(pa.status).toBe(200);
    expect(pa.json.payoutAccount).toMatchObject({ panLast4: '821K', accountLast4: '9012', ifsc: 'HDFC0001234' });
    expect(JSON.stringify(pa.json)).not.toMatch(/encrypted|AAJFB4821K|123456789012/i);

    const signed = await call('POST', `/payout-accounts/${pa.json.payoutAccount.id}/agreement`, { signedName: 'A Founder', version: 'v1' }, { 'x-forwarded-for': '10.0.0.1, 198.51.100.7' });
    expect(signed.status).toBe(200);
    const [ag] = await db.select().from(agreements);
    expect(ag!.ipAddress).toBe('198.51.100.7');

    const patched = await call('PATCH', `/outlets/${outletId}`, { step: 1, address: '12 Church Street', payoutAccountId: pa.json.payoutAccount.id });
    expect(patched.json.outlet).toMatchObject({ address: '12 Church Street', onboardingStep: 2 });
    expect((await call('PATCH', `/outlets/${outletId}`, { fssaiNumber: 'bad' })).json.error.code).toBe('invalid_request');

    const doc = await call('POST', `/outlets/${outletId}/documents`, { kind: 'pan', fileKey: docKey(owner.id) });
    expect(doc.status).toBe(200);
    expect(doc.json.document).toMatchObject({ kind: 'pan', payoutAccountId: pa.json.payoutAccount.id });

    const status = await call('GET', `/outlets/${outletId}/status`);
    expect(status.status).toBe(200);
    expect(status.json.status).toBe('draft');
    const fixCodes = (status.json.fixes as { code: string }[]).map((f) => f.code);
    expect(fixCodes).toContain('fssai_document_missing');
    expect(fixCodes).not.toContain('pan_document_missing');
    expect(fixCodes).not.toContain('agreement_missing');
  });
});
