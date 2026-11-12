import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { normalizePhone } from '../auth/otp.js';

export type AdminUser = { id: string; phone: string; name: string | null; isSuperAdmin: boolean; createdAt: string };

const columns = { id: users.id, phone: users.phone, name: users.name, isSuperAdmin: users.isSuperAdmin, createdAt: users.createdAt };
const notFound = () => new ApiError('not_found', 404, 'Admin not found');

/** Every admin, super admins first. */
export function listAdmins(): Promise<AdminUser[]> {
  return db
    .select(columns)
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.deletedAt)))
    .orderBy(desc(users.isSuperAdmin), asc(users.createdAt));
}

const addInput = z.object({ phone: z.string().min(1).max(20), name: z.string().trim().max(80).optional() });

/**
 * Makes the person with this number an admin. Someone who has never signed in gets an account now,
 * and their first OTP sign-in lands on it. A name is kept only where the account has none.
 */
export async function addAdmin(superAdminId: string, raw: { phone: string; name?: string }): Promise<AdminUser> {
  const input = parseInput(addInput, raw);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ApiError('invalid_phone', 400, 'Enter a valid mobile number');

  return withTx(async (tx) => {
    await tx.insert(users).values({ phone, name: input.name || null }).onConflictDoNothing({ target: users.phone });
    const [user] = await tx.select().from(users).where(eq(users.phone, phone)).for('update');
    if (user!.isAdmin) throw new ApiError('already_admin', 409, 'That number is already an admin');
    const [row] = await tx
      .update(users)
      .set({ isAdmin: true, ...(user!.name ? {} : { name: input.name || null }) })
      .where(eq(users.id, user!.id))
      .returning(columns);
    await audit(tx, { actorId: superAdminId, action: 'admin.add', entity: 'user', entityId: user!.id, detail: { phoneLast4: phone.slice(-4) } });
    return row!;
  });
}

/** Takes admin access away. It ends at their next request. A super admin can't be removed here. */
export async function removeAdmin(superAdminId: string, userId: string): Promise<void> {
  if (!z.uuid().safeParse(userId).success) throw notFound();
  await withTx(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user || !user.isAdmin || user.deletedAt) throw notFound();
    if (user.isSuperAdmin) throw new ApiError('super_admin', 409, 'A super admin can only be removed from the database');
    await tx.update(users).set({ isAdmin: false }).where(eq(users.id, userId));
    await audit(tx, { actorId: superAdminId, action: 'admin.remove', entity: 'user', entityId: userId, detail: { phoneLast4: user.phone.slice(-4) } });
  });
}
