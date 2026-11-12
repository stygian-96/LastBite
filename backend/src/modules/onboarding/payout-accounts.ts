import { isIP } from 'node:net';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx } from '../../db/client.js';
import { agreements, documents, outlets, payoutAccounts, users } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { encrypt } from '../../lib/crypto.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { readablePayoutAccounts, requireBrandOwner, requirePayoutAccount } from '../auth/access.js';

export type PayoutAccount = typeof payoutAccounts.$inferSelect;

const upper = z.string().trim().toUpperCase();

const payoutInput = z.object({
  legalName: z.string().trim().min(1).max(150),
  pan: upper.regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
  holderName: z.string().trim().min(1).max(150),
  accountNumber: z.string().trim().regex(/^\d{9,18}$/),
  ifsc: upper.regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
});
export type PayoutAccountInput = z.input<typeof payoutInput>;

/** The brand's accounts this user may read. */
export async function listPayoutAccounts(userId: string, brandId: string): Promise<PayoutAccount[]> {
  const readable = await readablePayoutAccounts(userId, brandId);
  if (readable.size === 0) return [];
  return db
    .select()
    .from(payoutAccounts)
    .where(and(eq(payoutAccounts.brandId, brandId), inArray(payoutAccounts.id, [...readable])))
    .orderBy(asc(payoutAccounts.createdAt), asc(payoutAccounts.id));
}

const sameName = (a: string, b: string | null) => {
  const plain = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  return b !== null && plain(a) === plain(b);
};

/**
 * Brand-owner only. PAN and account number are stored encrypted, with the last 4 in clear for display.
 * nameWarning says the bank holder is neither the legal name nor the owner. It stops nothing.
 */
export async function createPayoutAccount(
  userId: string,
  brandId: string,
  raw: PayoutAccountInput,
): Promise<PayoutAccount & { nameWarning: boolean }> {
  await requireBrandOwner(userId, brandId);
  const input = parseInput(payoutInput, raw);
  const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const nameWarning = !sameName(input.holderName, input.legalName) && !sameName(input.holderName, owner!.name);
  return withTx(async (tx) => {
    const [row] = await tx
      .insert(payoutAccounts)
      .values({
        brandId,
        legalName: input.legalName,
        panEncrypted: encrypt(input.pan),
        panLast4: input.pan.slice(-4),
        holderName: input.holderName,
        accountEncrypted: encrypt(input.accountNumber),
        accountLast4: input.accountNumber.slice(-4),
        ifsc: input.ifsc,
      })
      .returning();
    await audit(tx, {
      actorId: userId,
      action: 'payout_account.create',
      entity: 'payout_account',
      entityId: row!.id,
      detail: { brandId, nameWarning },
    });
    return { ...row!, nameWarning };
  });
}

/**
 * Replaces the legal and bank details, and pauses payouts until an admin verifies them again, which
 * guards against account takeover. The linked account stays until then. The audit keeps the last 4
 * digits only.
 */
export async function updatePayoutAccount(
  userId: string,
  id: string,
  raw: PayoutAccountInput,
  now: Date,
): Promise<PayoutAccount> {
  await requirePayoutAccount(userId, id);
  const input = parseInput(payoutInput, raw);
  return withTx(async (tx) => {
    const [account] = await tx.select().from(payoutAccounts).where(eq(payoutAccounts.id, id)).for('update');
    const [row] = await tx
      .update(payoutAccounts)
      .set({
        legalName: input.legalName,
        panEncrypted: encrypt(input.pan),
        panLast4: input.pan.slice(-4),
        holderName: input.holderName,
        accountEncrypted: encrypt(input.accountNumber),
        accountLast4: input.accountNumber.slice(-4),
        ifsc: input.ifsc,
        status: 'on_hold',
        linkedClaimedAt: null,
      })
      .where(eq(payoutAccounts.id, id))
      .returning();
    await audit(tx, {
      actorId: userId,
      action: 'payout_account.update',
      entity: 'payout_account',
      entityId: id,
      detail: { from: account!.status, accountLast4: input.accountNumber.slice(-4), at: now.toISOString() },
    });
    return row!;
  });
}

// ---------- Fixing an application's PAN or bank details ----------

const panPart = payoutInput.pick({ legalName: true, pan: true });
const bankPart = payoutInput.pick({ holderName: true, accountNumber: true, ifsc: true });
export type PanDetails = z.input<typeof panPart>;
export type BankDetails = z.input<typeof bankPart>;

/**
 * Corrects the PAN or the bank half of an account that is not verified yet, during an application.
 * The matching file (PAN card, or bank proof) goes back to waiting for review with the new details,
 * whether it was approved or flagged: an admin often flags a file because the details typed did not
 * match it. A new photo is optional. While an application using the account is under review it is
 * locked, as the rest of the application is. A verified account changes through updatePayoutAccount.
 */
async function fixAccountPart(
  userId: string,
  id: string,
  part: 'pan' | 'bank',
  set: Partial<typeof payoutAccounts.$inferInsert>,
  detail: Record<string, unknown>,
): Promise<PayoutAccount> {
  await requirePayoutAccount(userId, id);
  return withTx(async (tx) => {
    const [account] = await tx.select().from(payoutAccounts).where(eq(payoutAccounts.id, id)).for('update');
    if (account!.status !== 'pending') {
      throw new ApiError('not_editable', 409, 'This account is already verified. Change it from your payout settings');
    }
    const using = await tx.select({ status: outlets.status }).from(outlets).where(eq(outlets.payoutAccountId, id));
    if (using.some((o) => o.status === 'in_review')) {
      throw new ApiError('not_editable', 409, 'Your application is under review. Withdraw it to make changes');
    }
    const [row] = await tx.update(payoutAccounts).set(set).where(eq(payoutAccounts.id, id)).returning();
    const kind = part === 'pan' ? 'pan' : 'bank_proof';
    await tx
      .update(documents)
      .set({ status: 'pending', rejectionReason: null, reviewedBy: null, reviewedAt: null })
      .where(
        and(
          eq(documents.payoutAccountId, id),
          isNull(documents.outletId),
          eq(documents.kind, kind),
          inArray(documents.status, ['approved', 'rejected']),
        ),
      );
    await audit(tx, { actorId: userId, action: `payout_account.fix_${part}`, entity: 'payout_account', entityId: id, detail });
    return row!;
  });
}

export function fixPanDetails(userId: string, id: string, raw: PanDetails): Promise<PayoutAccount> {
  const input = parseInput(panPart, raw);
  return fixAccountPart(
    userId,
    id,
    'pan',
    { legalName: input.legalName, panEncrypted: encrypt(input.pan), panLast4: input.pan.slice(-4) },
    { panLast4: input.pan.slice(-4) },
  );
}

export function fixBankDetails(userId: string, id: string, raw: BankDetails): Promise<PayoutAccount> {
  const input = parseInput(bankPart, raw);
  return fixAccountPart(
    userId,
    id,
    'bank',
    {
      holderName: input.holderName,
      accountEncrypted: encrypt(input.accountNumber),
      accountLast4: input.accountNumber.slice(-4),
      ifsc: input.ifsc,
    },
    { accountLast4: input.accountNumber.slice(-4) },
  );
}

const agreementInput = z.object({
  signedName: z.string().trim().min(1).max(150),
  ip: z.string().trim().refine((v) => isIP(v) !== 0),
  version: z.string().trim().min(1).max(20),
});

/** Records who accepted which agreement version, from where, and when. Signing the same version twice changes nothing. */
export async function signAgreement(
  userId: string,
  payoutAccountId: string,
  raw: { signedName: string; ip: string; version: string },
  now: Date,
): Promise<void> {
  await requirePayoutAccount(userId, payoutAccountId);
  const input = parseInput(agreementInput, raw);
  await withTx(async (tx) => {
    const inserted = await tx
      .insert(agreements)
      .values({
        payoutAccountId,
        version: input.version,
        signedName: input.signedName,
        signedBy: userId,
        ipAddress: input.ip,
        signedAt: now.toISOString(),
      })
      .onConflictDoNothing({ target: [agreements.payoutAccountId, agreements.version] })
      .returning({ id: agreements.id });
    if (!inserted[0]) return;
    await audit(tx, {
      actorId: userId,
      action: 'agreement.sign',
      entity: 'agreement',
      entityId: inserted[0].id,
      detail: { payoutAccountId, version: input.version },
    });
  });
}
