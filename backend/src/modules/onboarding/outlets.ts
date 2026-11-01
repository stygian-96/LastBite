import { and, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { agreements, brands, documents, listings, memberships, outlets, payoutAccounts } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { requireBrandOwner, requireOutlet, requirePayoutAccount, type Outlet } from '../auth/access.js';
import { normalizePhone } from '../auth/otp.js';

export type { Outlet };

const CATEGORIES = ['bakery', 'cafe', 'restaurant', 'sweets', 'kitchen'] as const;
const LAST_STEP = 5;
const EDITABLE = ['draft', 'changes_needed'];
const PHOTO_LIMIT = 8;

// ---------- Formats ----------

const upper = z.string().trim().toUpperCase();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const openingHours = z.partialRecord(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z.array(z.array(time).length(2)).max(4),
);

/** https, on a Google Maps host: maps.google.com, www.google.com/maps, maps.app.goo.gl or goo.gl/maps. */
export function isMapsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const underMaps = u.pathname === '/maps' || u.pathname.startsWith('/maps/');
  switch (u.hostname) {
    case 'maps.google.com':
    case 'maps.app.goo.gl':
      return true;
    case 'www.google.com':
    case 'goo.gl':
      return underMaps;
    default:
      return false;
  }
}

const patchSchema = z
  .strictObject({
    step: z.number().int().min(1).max(LAST_STEP),
    branchName: z.string().trim().min(1).max(100),
    category: z.enum(CATEGORIES),
    address: z.string().trim().min(1).max(300),
    pincode: z.string().regex(/^\d{6}$/),
    areaId: z.uuid(),
    mapsUrl: z.string().trim().max(500).refine(isMapsUrl),
    contactPhone: z.string().trim().min(1).max(20),
    pickupInstructions: z.string().trim().max(500),
    openingHours,
    photoKeys: z.array(z.string().min(1).max(300)).max(PHOTO_LIMIT),
    logoKey: z.string().min(1).max(300),
    fssaiNumber: z.string().regex(/^\d{14}$/),
    fssaiExpiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((v) => !Number.isNaN(Date.parse(v))),
    gstin: upper.regex(/^[0-9A-Z]{15}$/),
    payoutAccountId: z.uuid(),
  })
  .partial();
export type OutletPatch = z.input<typeof patchSchema>;

// ---------- Slugs ----------

function slugify(name: string, fallback: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || fallback;
}

/** The base slug, or base-2, base-3 and so on, whichever is free. */
function firstFree(base: string, taken: string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---------- Starting an outlet ----------

const startSchema = z.object({
  brandName: z.string().trim().min(1).max(100).optional(),
  brandId: z.uuid().optional(),
  branchName: z.string().trim().min(1).max(100),
  category: z.enum(CATEGORIES),
});

/**
 * With `brandName`, creates the brand and makes the caller its owner. With `brandId`, adds a
 * branch to an existing brand, which only the brand owner may do.
 */
export async function startOutlet(
  userId: string,
  raw: { brandName?: string; brandId?: string; branchName: string; category: string },
): Promise<Outlet> {
  const input = parseInput(startSchema, raw);
  if (!input.brandId && !input.brandName) {
    throw new ApiError('invalid_request', 400, 'Give a brand name or an existing brand');
  }
  if (input.brandId) await requireBrandOwner(userId, input.brandId);

  // Two people choosing the same name at once trip a unique slug; the loser retries with the next free one.
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTx((tx) => createOutlet(tx, userId, input));
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 3) throw e;
    }
  }
}

async function createOutlet(tx: Tx, userId: string, input: z.output<typeof startSchema>): Promise<Outlet> {
  let brandId = input.brandId;
  if (!brandId) {
    const base = slugify(input.brandName!, 'brand');
    const taken = await tx
      .select({ slug: brands.slug })
      .from(brands)
      .where(or(eq(brands.slug, base), like(brands.slug, `${base}-%`)));
    const [brand] = await tx
      .insert(brands)
      .values({ name: input.brandName!, slug: firstFree(base, taken.map((t) => t.slug)), createdBy: userId })
      .returning();
    brandId = brand!.id;
    await tx.insert(memberships).values({ userId, brandId, role: 'owner', outletId: null });
    await audit(tx, { actorId: userId, action: 'brand.create', entity: 'brand', entityId: brandId });
  }

  const base = slugify(input.branchName, 'outlet');
  const taken = await tx
    .select({ slug: outlets.slug })
    .from(outlets)
    .where(and(eq(outlets.brandId, brandId), or(eq(outlets.slug, base), like(outlets.slug, `${base}-%`))));
  const [outlet] = await tx
    .insert(outlets)
    .values({
      brandId,
      branchName: input.branchName,
      category: input.category,
      slug: firstFree(base, taken.map((t) => t.slug)),
    })
    .returning();
  await audit(tx, {
    actorId: userId,
    action: 'outlet.start',
    entity: 'outlet',
    entityId: outlet!.id,
    detail: { brandId },
  });
  return outlet!;
}

// ---------- Saving a step ----------

const badKey = () => new ApiError('invalid_request', 400, 'Upload the file first, then record it');

/**
 * Saves some fields of a draft outlet. `step` is the step the user just finished; the outlet's
 * onboarding_step moves to the next one and never backwards.
 */
export async function saveOutletStep(userId: string, outletId: string, raw: OutletPatch): Promise<Outlet> {
  const member = await requireOutlet(userId, outletId, ['owner', 'manager']);
  const patch = parseInput(patchSchema, raw);

  if (patch.logoKey !== undefined) {
    await requireBrandOwner(userId, member.brandId);
    if (!patch.logoKey.startsWith(`logos/${userId}/`)) throw badKey();
  }
  if (patch.payoutAccountId !== undefined) {
    const [account] = await db
      .select({ brandId: payoutAccounts.brandId })
      .from(payoutAccounts)
      .where(eq(payoutAccounts.id, patch.payoutAccountId));
    if (!account || account.brandId !== member.brandId) {
      throw new ApiError('invalid_request', 400, 'That payout account belongs to another brand');
    }
    await requirePayoutAccount(userId, patch.payoutAccountId);
  }
  let contactPhone: string | undefined;
  if (patch.contactPhone !== undefined) {
    const phone = normalizePhone(patch.contactPhone);
    if (!phone) throw new ApiError('invalid_request', 400, 'Invalid value for contactPhone');
    contactPhone = phone;
  }

  return withTx(async (tx) => {
    const [current] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).for('update');
    if (!current) throw new ApiError('not_found', 404, 'Outlet not found');
    if (!EDITABLE.includes(current.status)) {
      throw new ApiError('not_editable', 409, 'This outlet can no longer be edited');
    }
    if (patch.photoKeys) {
      // Keys already on the outlet stay valid; new ones must be this user's own uploads.
      const fresh = patch.photoKeys.filter((k) => !current.photoKeys.includes(k));
      if (fresh.some((k) => !k.startsWith(`photos/${userId}/`))) throw badKey();
    }

    const { step, logoKey, ...fields } = patch;
    const set: Partial<typeof outlets.$inferInsert> = { ...fields, ...(contactPhone ? { contactPhone } : {}) };
    if (step !== undefined) set.onboardingStep = Math.max(current.onboardingStep, Math.min(step + 1, LAST_STEP));
    if (Object.keys(set).length > 0) await tx.update(outlets).set(set).where(eq(outlets.id, outletId));
    if (logoKey !== undefined) await tx.update(brands).set({ logoKey }).where(eq(brands.id, current.brandId));
    await audit(tx, {
      actorId: userId,
      action: 'outlet.update',
      entity: 'outlet',
      entityId: outletId,
      detail: { fields: Object.keys(patch) },
    });
    const [row] = await tx.select().from(outlets).where(eq(outlets.id, outletId));
    return row!;
  });
}

// ---------- Status and submission ----------

export type Fix = { code: string; message: string };
type Step = 'details' | 'licence' | 'payout' | 'agreement' | 'listing';
type Check = Fix & { step: Step };
const STEPS: Step[] = ['details', 'licence', 'payout', 'agreement', 'listing'];

type DocRow = Pick<typeof documents.$inferSelect, 'kind' | 'status' | 'rejectionReason'>;

/** ok when a pending or approved file exists; rejected when only rejected ones remain. */
function docState(rows: DocRow[], kind: string): { state: 'ok' | 'rejected' | 'missing'; reason?: string } {
  const live = rows.filter((r) => r.kind === kind && r.status !== 'replaced');
  if (live.some((r) => r.status === 'pending' || r.status === 'approved')) return { state: 'ok' };
  const rejected = live.find((r) => r.status === 'rejected');
  return rejected ? { state: 'rejected', reason: rejected.rejectionReason ?? undefined } : { state: 'missing' };
}

const hasHours = (h: unknown) =>
  !!h && typeof h === 'object' && Object.values(h).some((v) => Array.isArray(v) && v.length > 0);

const rejectedMessage = (label: string, reason?: string) =>
  reason ? `The ${label} was rejected: ${reason}. Upload it again` : `The ${label} was rejected. Upload it again`;

async function runChecks(o: Outlet): Promise<Check[]> {
  const fixes: Check[] = [];
  const need = (step: Step, code: string, message: string) => fixes.push({ step, code, message });

  if (!o.address) need('details', 'address_missing', 'Add the outlet address');
  if (!o.areaId) need('details', 'area_missing', 'Choose the area');
  if (!hasHours(o.openingHours)) need('details', 'hours_missing', 'Add opening hours');
  if (!o.mapsUrl) need('details', 'maps_url_missing', 'Add the Google Maps link');

  if (!o.fssaiNumber || !o.fssaiExpiresOn) {
    need('licence', 'fssai_details_missing', 'Add the FSSAI number and expiry date');
  }
  const outletDocs = await db.select().from(documents).where(eq(documents.outletId, o.id));
  const fssai = docState(outletDocs, 'fssai');
  if (fssai.state === 'missing') need('licence', 'fssai_document_missing', 'Upload the FSSAI licence');
  if (fssai.state === 'rejected') {
    need('licence', 'fssai_document_rejected', rejectedMessage('FSSAI licence', fssai.reason));
  }

  if (!o.payoutAccountId) {
    need('payout', 'payout_account_missing', 'Add the payout account');
    need('payout', 'pan_document_missing', 'Upload the PAN card');
    need('payout', 'bank_proof_document_missing', 'Upload the bank proof');
    need('agreement', 'agreement_missing', 'Sign the vendor agreement');
  } else {
    const accountDocs = await db.select().from(documents).where(eq(documents.payoutAccountId, o.payoutAccountId));
    for (const [kind, label] of [
      ['pan', 'PAN card'],
      ['bank_proof', 'bank proof'],
    ] as const) {
      const d = docState(accountDocs, kind);
      if (d.state === 'missing') need('payout', `${kind}_document_missing`, `Upload the ${label}`);
      if (d.state === 'rejected') need('payout', `${kind}_document_rejected`, rejectedMessage(label, d.reason));
    }
    const [signed] = await db
      .select({ id: agreements.id })
      .from(agreements)
      .where(eq(agreements.payoutAccountId, o.payoutAccountId))
      .limit(1);
    if (!signed) need('agreement', 'agreement_missing', 'Sign the vendor agreement');
  }

  const [listing] = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.outletId, o.id), isNull(listings.archivedAt)))
    .limit(1);
  if (!listing) need('listing', 'listing_missing', 'Add at least one listing');
  return fixes;
}

const toFix = ({ code, message }: Check): Fix => ({ code, message });

async function loadOutlet(outletId: string): Promise<Outlet> {
  const [o] = await db.select().from(outlets).where(eq(outlets.id, outletId));
  if (!o) throw new ApiError('not_found', 404, 'Outlet not found');
  return o;
}

/** Where the outlet stands and what is still missing or was rejected. */
export async function getOutletStatus(
  userId: string,
  outletId: string,
): Promise<{ status: string; steps: { key: string; done: boolean }[]; fixes: Fix[] }> {
  await requireOutlet(userId, outletId, ['owner', 'manager']);
  const o = await loadOutlet(outletId);
  const checks = await runChecks(o);
  return {
    status: o.status,
    steps: STEPS.map((key) => ({ key, done: !checks.some((c) => c.step === key) })),
    fixes: checks.map(toFix),
  };
}

const notSubmittable = () => new ApiError('not_submittable', 409, 'This outlet was already submitted');

/** Moves a complete draft to review. Anything missing comes back as a 422 listing every fix. */
export async function submitOutlet(userId: string, outletId: string, now: Date): Promise<Outlet> {
  await requireOutlet(userId, outletId, ['owner', 'manager']);
  const o = await loadOutlet(outletId);
  if (!EDITABLE.includes(o.status)) throw notSubmittable();
  const fixes = (await runChecks(o)).map(toFix);
  if (fixes.length > 0) throw new ApiError('incomplete', 422, 'Some details are still missing', { fixes });

  return withTx(async (tx) => {
    const [row] = await tx
      .update(outlets)
      .set({ status: 'in_review', submittedAt: now.toISOString() })
      .where(and(eq(outlets.id, outletId), inArray(outlets.status, EDITABLE)))
      .returning();
    if (!row) throw notSubmittable();
    await audit(tx, { actorId: userId, action: 'outlet.submit', entity: 'outlet', entityId: outletId });
    return row;
  });
}
