import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { db, withTx } from '../../db/client.js';
import { memberships, outlets, payoutAccounts, users } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { normalizePhone } from './otp.js';

export type Role = 'owner' | 'manager' | 'counter';
export type Membership = typeof memberships.$inferSelect;
export type Outlet = typeof outlets.$inferSelect;

const forbidden = () => new ApiError('forbidden', 403, 'Not allowed');

/** Live memberships only. Read on every request, so removal takes effect at once. */
const active = (userId: string, brandId: string) =>
  and(eq(memberships.userId, userId), eq(memberships.brandId, brandId), isNull(memberships.removedAt));

/**
 * The membership that lets the user act at an outlet with one of the given roles.
 * A membership with a null outlet covers the whole brand. A brand-wide owner
 * passes whatever roles are listed. Unknown outlets and non-members both get 403.
 */
export async function requireOutlet(userId: string, outletId: string, roles: Role[]): Promise<Membership> {
  const [outlet] = await db.select({ brandId: outlets.brandId }).from(outlets).where(eq(outlets.id, outletId));
  if (!outlet) throw forbidden();
  const rows = await db
    .select()
    .from(memberships)
    .where(and(active(userId, outlet.brandId), or(isNull(memberships.outletId), eq(memberships.outletId, outletId))));
  const hit = rows.find(
    (m) => roles.includes(m.role as Role) || (m.role === 'owner' && m.outletId === null),
  );
  if (!hit) throw forbidden();
  return hit;
}

/** Passes only for a brand-wide owner of the brand. */
export async function requireBrandOwner(userId: string, brandId: string): Promise<void> {
  const [m] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(active(userId, brandId), eq(memberships.role, 'owner'), isNull(memberships.outletId)));
  if (!m) throw forbidden();
}

/**
 * A member whose membership names the account may read it. Otherwise only a
 * brand owner may, and only while no one else's membership names it, which
 * keeps a franchisee's bank details from the brand owner.
 */
export async function requirePayoutAccount(userId: string, payoutAccountId: string): Promise<void> {
  const [account] = await db
    .select({ brandId: payoutAccounts.brandId })
    .from(payoutAccounts)
    .where(eq(payoutAccounts.id, payoutAccountId));
  if (!account) throw forbidden();

  const [named] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(active(userId, account.brandId), eq(memberships.payoutAccountId, payoutAccountId)));
  if (named) return;

  await requireBrandOwner(userId, account.brandId);
  const [other] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.brandId, account.brandId),
        eq(memberships.payoutAccountId, payoutAccountId),
        isNull(memberships.removedAt),
        ne(memberships.userId, userId),
      ),
    );
  if (other) throw forbidden();
}

/** Every outlet the user has a live membership for, brand-wide memberships included. */
export async function listAccessibleOutlets(userId: string): Promise<Outlet[]> {
  const rows = await db
    .select({ outlet: outlets })
    .from(outlets)
    .innerJoin(
      memberships,
      and(
        eq(memberships.brandId, outlets.brandId),
        or(isNull(memberships.outletId), eq(memberships.outletId, outlets.id)),
      ),
    )
    .where(and(eq(memberships.userId, userId), isNull(memberships.removedAt)));
  return [...new Map(rows.map((r) => [r.outlet.id, r.outlet])).values()];
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === '23505';

/** Owner-only. Finds the user by phone or creates them, then adds an outlet membership. */
export async function addStaff(
  actorId: string,
  outletId: string,
  input: { phone: string; name: string; role: Role },
): Promise<Membership> {
  const actor = await requireOutlet(actorId, outletId, ['owner']);
  if (input.role === 'owner') throw new ApiError('invalid_role', 400, 'Staff can be manager or counter');
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ApiError('invalid_phone', 400, 'Enter a valid mobile number');

  try {
    return await withTx(async (tx) => {
      await tx.insert(users).values({ phone, name: input.name }).onConflictDoNothing({ target: users.phone });
      const [user] = await tx.select().from(users).where(eq(users.phone, phone));
      if (!user || user.deletedAt) throw new ApiError('not_found', 404, 'User not found');

      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(active(user.id, actor.brandId), eq(memberships.outletId, outletId)));
      if (existing) throw new ApiError('already_member', 409, 'Already on this outlet');

      const [m] = await tx
        .insert(memberships)
        .values({ userId: user.id, brandId: actor.brandId, outletId, role: input.role })
        .returning();
      await audit(tx, {
        actorId,
        action: 'staff.add',
        entity: 'membership',
        entityId: m!.id,
        detail: { outletId, userId: user.id, role: input.role },
      });
      return m!;
    });
  } catch (e) {
    // A concurrent add of the same person trips the unique index.
    if (isUniqueViolation(e)) throw new ApiError('already_member', 409, 'Already on this outlet');
    throw e;
  }
}

/** Owner-only. Marks the membership removed; the next request from that person is refused. */
export async function removeStaff(
  actorId: string,
  membershipId: string,
  now: Date,
  outletId?: string,
): Promise<void> {
  const [target] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), isNull(memberships.removedAt)));
  // When called for a specific outlet, a membership from any other outlet does not exist as far as the caller can tell.
  if (!target || (outletId !== undefined && target.outletId !== outletId)) {
    throw new ApiError('not_found', 404, 'Staff member not found');
  }
  if (target.outletId === null) await requireBrandOwner(actorId, target.brandId);
  else await requireOutlet(actorId, target.outletId, ['owner']);
  if (target.role === 'owner') throw new ApiError('invalid_role', 400, 'Owners cannot be removed here');

  await withTx(async (tx) => {
    await tx
      .update(memberships)
      .set({ removedAt: now.toISOString() })
      .where(and(eq(memberships.id, membershipId), isNull(memberships.removedAt)));
    await audit(tx, {
      actorId,
      action: 'staff.remove',
      entity: 'membership',
      entityId: membershipId,
      detail: { outletId: target.outletId, userId: target.userId },
    });
  });
}
