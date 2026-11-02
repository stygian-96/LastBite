import { and, eq, inArray, isNotNull, isNull, ne, or, like } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { brands, documents, memberships, outlets, payoutAccounts } from '../../db/schema.js';
import { getStore } from '../../integrations/storage.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { queueApplicationNotice, queueOutletClosed } from '../notifications/events.js';

export type Document = typeof documents.$inferSelect;
export type Outlet = typeof outlets.$inferSelect;

export type ReviewedDocument = Pick<
  Document,
  'id' | 'outletId' | 'payoutAccountId' | 'kind' | 'status' | 'rejectionReason' | 'createdAt'
> & { url: string };

export type Application = {
  outlet: Outlet;
  brand: { id: string; name: string };
  payoutAccount: {
    id: string;
    legalName: string;
    panLast4: string;
    holderName: string;
    accountLast4: string;
    ifsc: string;
    status: string;
  } | null;
  documents: ReviewedDocument[];
  warnings: { code: string; message: string; outletIds: string[] }[];
};

const invalidState = () => new ApiError('invalid_state', 409, 'That change is not allowed from the current status');

// ---------- The review queue ----------

/**
 * Outlets waiting for a decision, oldest submission first: those in review, plus any outlet with a
 * document still pending (a licence renewal on a live outlet). Documents carry short-lived read links.
 */
export async function listApplications(): Promise<Application[]> {
  const pendingForOutlet = db
    .select({ id: documents.outletId })
    .from(documents)
    .where(and(eq(documents.status, 'pending'), isNotNull(documents.outletId)));
  const pendingForAccount = db
    .select({ id: documents.payoutAccountId })
    .from(documents)
    .where(and(eq(documents.status, 'pending'), isNotNull(documents.payoutAccountId)));

  const rows = await db
    .select()
    .from(outlets)
    .where(
      or(
        eq(outlets.status, 'in_review'),
        inArray(outlets.id, pendingForOutlet),
        inArray(outlets.payoutAccountId, pendingForAccount),
      ),
    );
  rows.sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
  if (rows.length === 0) return [];

  const outletIds = rows.map((o) => o.id);
  const accountIds = [...new Set(rows.flatMap((o) => (o.payoutAccountId ? [o.payoutAccountId] : [])))];
  const brandIds = [...new Set(rows.map((o) => o.brandId))];
  const numbers = [...new Set(rows.flatMap((o) => (o.fssaiNumber ? [o.fssaiNumber] : [])))];

  const [brandRows, accountRows, docRows, sameNumber] = await Promise.all([
    db.select({ id: brands.id, name: brands.name }).from(brands).where(inArray(brands.id, brandIds)),
    accountIds.length
      ? db.select().from(payoutAccounts).where(inArray(payoutAccounts.id, accountIds))
      : Promise.resolve([]),
    db
      .select()
      .from(documents)
      .where(
        and(
          ne(documents.status, 'replaced'),
          or(
            inArray(documents.outletId, outletIds),
            accountIds.length ? inArray(documents.payoutAccountId, accountIds) : undefined,
          ),
        ),
      ),
    numbers.length
      ? db.select({ id: outlets.id, fssaiNumber: outlets.fssaiNumber }).from(outlets).where(inArray(outlets.fssaiNumber, numbers))
      : Promise.resolve([]),
  ]);

  const store = getStore();
  const urls = new Map(await Promise.all(docRows.map(async (d) => [d.id, await store.signedRead(d.fileKey)] as const)));
  const brandById = new Map(brandRows.map((b) => [b.id, b]));
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  return rows.map((o) => {
    const a = o.payoutAccountId ? accountById.get(o.payoutAccountId) : undefined;
    const docs = docRows
      .filter((d) => d.outletId === o.id || (a && d.payoutAccountId === a.id))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      .map((d) => ({
        id: d.id,
        outletId: d.outletId,
        payoutAccountId: d.payoutAccountId,
        kind: d.kind,
        status: d.status,
        rejectionReason: d.rejectionReason,
        createdAt: d.createdAt,
        url: urls.get(d.id)!,
      }));
    const others = o.fssaiNumber
      ? sameNumber.filter((s) => s.fssaiNumber === o.fssaiNumber && s.id !== o.id).map((s) => s.id)
      : [];
    return {
      outlet: o,
      brand: brandById.get(o.brandId)!,
      payoutAccount: a
        ? {
            id: a.id,
            legalName: a.legalName,
            panLast4: a.panLast4,
            holderName: a.holderName,
            accountLast4: a.accountLast4,
            ifsc: a.ifsc,
            status: a.status,
          }
        : null,
      documents: docs,
      warnings: others.length
        ? [{ code: 'duplicate_fssai', message: 'Another outlet uses the same FSSAI number', outletIds: others }]
        : [],
    };
  });
}

// ---------- Reviewing a document ----------

const reviewInput = z.object({
  approve: z.boolean(),
  reason: z.string().trim().max(500).optional(),
  fssaiNumber: z.string().regex(/^\d{14}$/).optional(),
  fssaiExpiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(v)))
    .optional(),
});
export type ReviewInput = z.input<typeof reviewInput>;

const uuid = z.uuid();
const notFound = (what: string) => new ApiError('not_found', 404, `${what} not found`);

/**
 * Approves or rejects one pending document. A rejection needs a reason and sends any outlet in
 * review that depends on the file back to the vendor. Approving a file on a live outlet, or on a
 * payout account, retires the older approved file of that kind. A renewed FSSAI may carry the new
 * number and expiry, which are written to the live outlet.
 */
export async function reviewDocument(adminId: string, docId: string, raw: ReviewInput, now: Date): Promise<void> {
  const input = parseInput(reviewInput, raw);
  if (!uuid.safeParse(docId).success) throw notFound('Document');
  const licence = input.fssaiNumber !== undefined || input.fssaiExpiresOn !== undefined;
  if (!input.approve && !input.reason) {
    throw new ApiError('invalid_request', 400, 'Say why the document was rejected');
  }
  if (licence && (!input.approve || input.fssaiNumber === undefined || input.fssaiExpiresOn === undefined)) {
    throw new ApiError('invalid_request', 400, 'Give the FSSAI number and expiry together, when approving');
  }

  await withTx(async (tx) => {
    const [doc] = await tx.select().from(documents).where(eq(documents.id, docId)).for('update');
    if (!doc) throw notFound('Document');
    if (doc.status !== 'pending') throw invalidState();

    const owner = doc.outletId
      ? and(eq(documents.outletId, doc.outletId), isNull(documents.payoutAccountId))
      : and(eq(documents.payoutAccountId, doc.payoutAccountId!), isNull(documents.outletId));
    const dependants = doc.outletId
      ? eq(outlets.id, doc.outletId)
      : eq(outlets.payoutAccountId, doc.payoutAccountId!);
    const affected = await tx.select().from(outlets).where(dependants).for('update');

    if (licence && !(doc.kind === 'fssai' && doc.outletId && affected[0]?.status === 'live')) {
      throw new ApiError('invalid_request', 400, 'The FSSAI number and expiry can be set only when renewing a live outlet');
    }

    await tx
      .update(documents)
      .set({
        status: input.approve ? 'approved' : 'rejected',
        rejectionReason: input.approve ? null : input.reason,
        reviewedBy: adminId,
        reviewedAt: now.toISOString(),
      })
      .where(eq(documents.id, docId));

    const sentBack: string[] = [];
    if (input.approve) {
      if (doc.payoutAccountId || affected[0]?.status === 'live') {
        await tx
          .update(documents)
          .set({ status: 'replaced' })
          .where(and(owner, eq(documents.kind, doc.kind), eq(documents.status, 'approved'), ne(documents.id, docId)));
      }
      if (licence) {
        await tx
          .update(outlets)
          .set({ fssaiNumber: input.fssaiNumber, fssaiExpiresOn: input.fssaiExpiresOn })
          .where(eq(outlets.id, doc.outletId!));
      }
    } else {
      const back = await tx
        .update(outlets)
        .set({ status: 'changes_needed' })
        .where(and(dependants, eq(outlets.status, 'in_review')))
        .returning({ id: outlets.id });
      sentBack.push(...back.map((b) => b.id));
      for (const id of sentBack) await queueApplicationNotice(tx, id, 'changes_needed', docId, input.reason);
    }

    await audit(tx, {
      actorId: adminId,
      action: input.approve ? 'document.approve' : 'document.reject',
      entity: 'document',
      entityId: docId,
      detail: {
        kind: doc.kind,
        outletId: doc.outletId,
        payoutAccountId: doc.payoutAccountId,
        ...(input.approve ? {} : { reason: input.reason, changesNeeded: sentBack }),
        ...(licence ? { fssaiNumber: input.fssaiNumber, fssaiExpiresOn: input.fssaiExpiresOn } : {}),
      },
    });
  });
}

// ---------- Deciding an outlet ----------

const decisionInput = z.object({
  decision: z.enum(['approve', 'request_changes', 'suspend', 'reinstate', 'close']),
  reason: z.string().trim().max(500).optional(),
});
export type Decision = z.input<typeof decisionInput>['decision'];

// Where each decision may start, and where it ends.
const TRANSITIONS: Record<Decision, { from: string[]; to: string }> = {
  approve: { from: ['in_review'], to: 'live' },
  request_changes: { from: ['in_review'], to: 'changes_needed' },
  suspend: { from: ['live'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'live' },
  close: { from: ['live', 'suspended'], to: 'closed' },
};

type Fix = { code: string; message: string };

/** Fixes that stop an approval: every required file must be approved and none still pending. */
function approvalFixes(o: Outlet, docs: Document[]): Fix[] {
  const fixes: Fix[] = [];
  if (!o.payoutAccountId) fixes.push({ code: 'payout_account_missing', message: 'The outlet has no payout account' });
  const required: [string, string, (d: Document) => boolean][] = [
    ['fssai', 'FSSAI licence', (d) => d.outletId === o.id],
    ['pan', 'PAN card', (d) => d.payoutAccountId === o.payoutAccountId],
    ['bank_proof', 'bank proof', (d) => d.payoutAccountId === o.payoutAccountId],
  ];
  for (const [kind, label, mine] of required) {
    const rows = docs.filter((d) => d.kind === kind && d.status !== 'replaced' && mine(d));
    if (rows.some((d) => d.status === 'pending')) {
      fixes.push({ code: `${kind}_document_pending`, message: `The ${label} has not been reviewed` });
    } else if (!rows.some((d) => d.status === 'approved')) {
      fixes.push({ code: `${kind}_document_missing`, message: `The ${label} is missing or was rejected` });
    }
  }
  return fixes;
}

/**
 * Moves an outlet along its state machine. Approving also verifies its payout account.
 * Any other move is a 409 `invalid_state`.
 */
export async function decideOutlet(
  adminId: string,
  outletId: string,
  raw: { decision: Decision; reason?: string },
  now: Date,
): Promise<void> {
  const input = parseInput(decisionInput, raw);
  if (!uuid.safeParse(outletId).success) throw notFound('Outlet');
  const move = TRANSITIONS[input.decision];

  await withTx(async (tx) => {
    const [o] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).for('update');
    if (!o) throw notFound('Outlet');
    if (!move.from.includes(o.status)) throw invalidState();
    if (input.decision === 'request_changes' && !input.reason) {
      throw new ApiError('invalid_request', 400, 'Say what needs to change');
    }

    let verified = false;
    if (input.decision === 'approve') {
      const docs = await tx
        .select()
        .from(documents)
        .where(or(eq(documents.outletId, o.id), o.payoutAccountId ? eq(documents.payoutAccountId, o.payoutAccountId) : undefined));
      const fixes = approvalFixes(o, docs);
      if (fixes.length > 0) {
        throw new ApiError('documents_pending', 409, 'Some required documents are not approved yet', { fixes });
      }
      const [account] = await tx.select().from(payoutAccounts).where(eq(payoutAccounts.id, o.payoutAccountId!)).for('update');
      if (!account || (account.status !== 'pending' && account.status !== 'verified')) {
        throw new ApiError('payout_account_unavailable', 409, 'The payout account cannot be verified from its current status');
      }
      if (account.status === 'pending') {
        await tx.update(payoutAccounts).set({ status: 'verified' }).where(eq(payoutAccounts.id, account.id));
        verified = true;
      }
    }

    const asked = input.decision === 'request_changes' ? { changesReason: input.reason } : {};
    await tx.update(outlets).set({ status: move.to, ...asked }).where(eq(outlets.id, outletId));
    if (input.decision === 'approve') await queueApplicationNotice(tx, outletId, 'application_approved', 'live');
    if (input.decision === 'request_changes') {
      await queueApplicationNotice(tx, outletId, 'changes_needed', now.toISOString(), input.reason);
    }
    if (input.decision === 'close') await queueOutletClosed(tx, outletId);
    await audit(tx, {
      actorId: adminId,
      action: `outlet.${input.decision}`,
      entity: 'outlet',
      entityId: outletId,
      detail: {
        from: o.status,
        to: move.to,
        at: now.toISOString(),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(verified ? { payoutAccountVerified: o.payoutAccountId } : {}),
      },
    });
  });
}

// ---------- Admin edits ----------

const adminUpdateInput = z.object({
  brandId: z.uuid().optional(),
  commissionBps: z.number().int().min(0).max(10000).optional(),
  payoutAccountId: z.uuid().optional(),
});
export type AdminUpdate = z.input<typeof adminUpdateInput>;

/** The base slug, or base-2, base-3 and so on, whichever the brand does not have. */
async function freeSlug(tx: Tx, brandId: string, base: string): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ slug: outlets.slug })
        .from(outlets)
        .where(and(eq(outlets.brandId, brandId), or(eq(outlets.slug, base), like(outlets.slug, `${base}-%`))))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Sets commission, moves the outlet to another brand, and/or moves it to another payout account. A
 * brand move takes the outlet's own staff along. The payout account must belong to the new brand: if
 * it belongs to the old one and no other outlet uses it, it moves too; if another outlet uses it, the
 * move is refused. A franchise switch names a verified account of the brand instead, which then
 * stays behind with its brand. Orders keep the account they were sold under.
 */
export async function updateOutletAdmin(adminId: string, outletId: string, raw: AdminUpdate): Promise<void> {
  const input = parseInput(adminUpdateInput, raw);
  if (!uuid.safeParse(outletId).success) throw notFound('Outlet');

  try {
    await withTx(async (tx) => {
      const [o] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).for('update');
      if (!o) throw notFound('Outlet');
      const set: Partial<typeof outlets.$inferInsert> = {};
      const detail: Record<string, unknown> = {};

      if (input.commissionBps !== undefined && input.commissionBps !== o.commissionBps) {
        set.commissionBps = input.commissionBps;
        detail.commissionBps = { from: o.commissionBps, to: input.commissionBps };
      }

      if (input.brandId !== undefined && input.brandId !== o.brandId) {
        const [brand] = await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, input.brandId));
        if (!brand) throw notFound('Brand');

        let movedAccount: string | null = null;
        if (o.payoutAccountId && !input.payoutAccountId) {
          const [account] = await tx
            .select()
            .from(payoutAccounts)
            .where(eq(payoutAccounts.id, o.payoutAccountId))
            .for('update');
          if (account && account.brandId !== input.brandId) {
            const [other] = await tx
              .select({ id: outlets.id })
              .from(outlets)
              .where(and(eq(outlets.payoutAccountId, account.id), ne(outlets.id, o.id)))
              .limit(1);
            if (other) {
              throw new ApiError(
                'payout_account_shared',
                409,
                'Another outlet uses this outlet\'s payout account, so it cannot move to a different brand',
              );
            }
            await tx.update(payoutAccounts).set({ brandId: input.brandId }).where(eq(payoutAccounts.id, account.id));
            movedAccount = account.id;
          }
        }

        // The outlet's own staff follow it. Anyone else who named the moved account stays with the
        // old brand and no longer names it, so no membership points at another brand's account.
        await tx
          .update(memberships)
          .set({ brandId: input.brandId })
          .where(and(eq(memberships.outletId, o.id), eq(memberships.brandId, o.brandId)));
        if (movedAccount) {
          await tx
            .update(memberships)
            .set({ payoutAccountId: null })
            .where(
              and(
                eq(memberships.payoutAccountId, movedAccount),
                ne(memberships.brandId, input.brandId),
              ),
            );
        }
        set.brandId = input.brandId;
        set.slug = await freeSlug(tx, input.brandId, o.slug);
        detail.brandId = { from: o.brandId, to: input.brandId };
        if (movedAccount) detail.payoutAccountMoved = movedAccount;
      }

      if (input.payoutAccountId !== undefined && input.payoutAccountId !== o.payoutAccountId) {
        const [account] = await tx
          .select({ brandId: payoutAccounts.brandId, status: payoutAccounts.status })
          .from(payoutAccounts)
          .where(eq(payoutAccounts.id, input.payoutAccountId))
          .for('share');
        if (!account) throw notFound('Payout account');
        if (account.brandId !== (input.brandId ?? o.brandId)) {
          throw new ApiError('invalid_request', 400, 'That payout account belongs to another brand');
        }
        if (account.status !== 'verified') {
          throw new ApiError('payout_account_unverified', 409, 'That payout account is not verified');
        }
        set.payoutAccountId = input.payoutAccountId;
        detail.payoutAccountId = { from: o.payoutAccountId, to: input.payoutAccountId };
      }

      if (Object.keys(set).length === 0) return;
      await tx.update(outlets).set(set).where(eq(outlets.id, outletId));
      await audit(tx, { actorId: adminId, action: 'outlet.admin_update', entity: 'outlet', entityId: outletId, detail });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError('conflict', 409, 'That change clashes with an existing record');
    throw e;
  }
}
