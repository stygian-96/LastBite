import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx } from '../../db/client.js';
import { documents, outlets, payoutAccounts } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { requireOutlet, requirePayoutAccount } from '../auth/access.js';

export type Document = typeof documents.$inferSelect;

const OUTLET_KINDS = ['fssai', 'gst'] as const;
const ACCOUNT_KINDS = ['pan', 'bank_proof'] as const;

const documentInput = z.object({
  outletId: z.uuid(),
  kind: z.enum([...OUTLET_KINDS, ...ACCOUNT_KINDS]),
  fileKey: z.string().min(1).max(300),
  payoutAccountId: z.uuid().optional(),
});
export type DocumentInput = z.input<typeof documentInput>;

/**
 * Records an uploaded file. FSSAI and GST belong to the outlet, PAN and bank proof to the payout
 * account (the outlet's own unless one is named). A newer file marks the older ones replaced.
 */
export async function addDocument(userId: string, raw: DocumentInput): Promise<Document> {
  const input = parseInput(documentInput, raw);
  await requireOutlet(userId, input.outletId, ['owner', 'manager']);
  if (!input.fileKey.startsWith(`documents/${userId}/`)) {
    throw new ApiError('invalid_request', 400, 'Upload the file first, then record it');
  }
  const [outlet] = await db.select().from(outlets).where(eq(outlets.id, input.outletId));
  if (!outlet) throw new ApiError('not_found', 404, 'Outlet not found');

  // Under review nothing changes. A live outlet may add a renewal, which sits beside the approved file.
  const live = outlet.status === 'live';
  if (!live && outlet.status !== 'draft' && outlet.status !== 'changes_needed') {
    throw new ApiError('not_editable', 409, 'This outlet can no longer be edited');
  }

  const forOutlet = (OUTLET_KINDS as readonly string[]).includes(input.kind);
  let payoutAccountId: string | null = null;
  if (forOutlet) {
    if (input.payoutAccountId) throw new ApiError('invalid_request', 400, `${input.kind} belongs to the outlet`);
  } else {
    payoutAccountId = input.payoutAccountId ?? outlet.payoutAccountId;
    if (!payoutAccountId) throw new ApiError('invalid_request', 400, 'Add a payout account first');
    const [account] = await db
      .select({ brandId: payoutAccounts.brandId })
      .from(payoutAccounts)
      .where(eq(payoutAccounts.id, payoutAccountId));
    if (!account || account.brandId !== outlet.brandId) {
      throw new ApiError('invalid_request', 400, 'That payout account belongs to another brand');
    }
    await requirePayoutAccount(userId, payoutAccountId);
  }

  const owner = forOutlet
    ? and(eq(documents.outletId, outlet.id), isNull(documents.payoutAccountId))
    : and(eq(documents.payoutAccountId, payoutAccountId!), isNull(documents.outletId));

  return withTx(async (tx) => {
    await tx
      .update(documents)
      .set({ status: 'replaced' })
      .where(
        and(
          owner,
          eq(documents.kind, input.kind),
          // On a live outlet the approved file stays in force until an admin approves the new one.
          inArray(documents.status, live ? ['pending', 'rejected'] : ['pending', 'approved', 'rejected']),
        ),
      );
    const [row] = await tx
      .insert(documents)
      .values({
        outletId: forOutlet ? outlet.id : null,
        payoutAccountId,
        kind: input.kind,
        fileKey: input.fileKey,
      })
      .returning();
    await audit(tx, {
      actorId: userId,
      action: 'document.add',
      entity: 'document',
      entityId: row!.id,
      detail: { outletId: outlet.id, payoutAccountId, kind: input.kind },
    });
    return row!;
  });
}

