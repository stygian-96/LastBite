import { isIP } from 'node:net';
import { z } from 'zod';
import { withTx } from '../../db/client.js';
import { agreements, payoutAccounts } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { encrypt } from '../../lib/crypto.js';
import { parseInput } from '../../lib/errors.js';
import { requireBrandOwner, requirePayoutAccount } from '../auth/access.js';

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

/** Brand-owner only. PAN and account number are stored encrypted, with the last 4 in clear for display. */
export async function createPayoutAccount(
  userId: string,
  brandId: string,
  raw: PayoutAccountInput,
): Promise<PayoutAccount> {
  await requireBrandOwner(userId, brandId);
  const input = parseInput(payoutInput, raw);
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
      detail: { brandId },
    });
    return row!;
  });
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
