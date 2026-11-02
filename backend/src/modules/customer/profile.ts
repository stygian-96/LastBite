import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx } from '../../db/client.js';
import { drops, follows, orders, otpCodes, sessions, users } from '../../db/schema.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { cancelPendingFor, scrubPhone } from '../notifications/enqueue.js';

export type Profile = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  whatsappOptIn: boolean;
  marketingOptIn: boolean;
  impact: { bagsCollected: number; moneySavedPaise: number };
};

const ACTIVE_STATUSES = ['held', 'paid'];

const profileInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(254).optional(),
  whatsappOptIn: z.boolean().optional(),
  marketingOptIn: z.boolean().optional(),
});

const notFound = () => new ApiError('not_found', 404, 'User not found');

/** The customer's profile, with what their collected bags saved them. */
export async function getProfile(userId: string): Promise<Profile> {
  const [user] = await db
    .select({
      id: users.id,
      phone: users.phone,
      name: users.name,
      email: users.email,
      whatsappOptIn: users.whatsappOptIn,
      marketingOptIn: users.marketingOptIn,
    })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user) throw notFound();

  const [impact] = await db
    .select({
      bagsCollected: sql<number>`count(*)::int`,
      moneySavedPaise: sql<number>`coalesce(sum(${drops.valuePaise} - ${orders.pricePaise}), 0)::int`,
    })
    .from(orders)
    .innerJoin(drops, eq(drops.id, orders.dropId))
    .where(and(eq(orders.userId, userId), eq(orders.status, 'collected')));
  return { ...user, impact: impact! };
}

/** Changes the fields given. Anything else in the input is ignored. */
export async function updateProfile(userId: string, raw: unknown): Promise<Profile> {
  const input = parseInput(profileInput, raw);
  if (Object.keys(input).length > 0) {
    await db
      .update(users)
      .set(input)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  }
  return getProfile(userId);
}

/**
 * Anonymises the account and keeps its orders, which are financial records. FOR UPDATE conflicts
 * with the key lock a new order takes on its user, so a reserve in flight is either seen here or
 * waits until this commits.
 */
export async function deleteAccount(userId: string, now: Date): Promise<void> {
  await withTx(async (tx) => {
    const [user] = await tx
      .select({ phone: users.phone })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('update');
    if (!user) throw notFound();

    const [active] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.userId, userId), inArray(orders.status, ACTIVE_STATUSES)))
      .limit(1);
    if (active) throw new ApiError('active_order', 409, 'Finish or cancel your active order first');

    const deletedPhone = `deleted:${userId}`;
    await cancelPendingFor(tx, user.phone);
    await scrubPhone(tx, user.phone, deletedPhone);
    await tx.delete(otpCodes).where(eq(otpCodes.phone, user.phone));
    await tx.delete(follows).where(eq(follows.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx
      .update(users)
      .set({ phone: deletedPhone, name: null, email: null, deletedAt: now.toISOString() })
      .where(eq(users.id, userId));
  });
}
