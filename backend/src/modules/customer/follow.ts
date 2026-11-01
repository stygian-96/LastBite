import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { brands, follows, outlets } from '../../db/schema.js';
import { ApiError } from '../../lib/errors.js';

export type FollowedOutlet = {
  outletId: string;
  brandName: string;
  brandSlug: string;
  branchName: string;
  outletSlug: string;
  category: string;
  /** A followed outlet stays listed if it later suspends or closes. */
  status: string;
};

const notFound = () => new ApiError('not_found', 404, 'Outlet not found');
const requireId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound();
};

/** Follows a live outlet. Following it again changes nothing. */
export async function follow(userId: string, outletId: string): Promise<void> {
  requireId(outletId);
  const [outlet] = await db
    .select({ id: outlets.id })
    .from(outlets)
    .where(and(eq(outlets.id, outletId), eq(outlets.status, 'live')));
  if (!outlet) throw notFound();
  await db.insert(follows).values({ userId, outletId }).onConflictDoNothing();
}

export async function unfollow(userId: string, outletId: string): Promise<void> {
  requireId(outletId);
  await db.delete(follows).where(and(eq(follows.userId, userId), eq(follows.outletId, outletId)));
}

/** Followed outlets, the latest first. */
export function listFollowing(userId: string): Promise<FollowedOutlet[]> {
  return db
    .select({
      outletId: outlets.id,
      brandName: brands.name,
      brandSlug: brands.slug,
      branchName: outlets.branchName,
      outletSlug: outlets.slug,
      category: outlets.category,
      status: outlets.status,
    })
    .from(follows)
    .innerJoin(outlets, eq(outlets.id, follows.outletId))
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .where(eq(follows.userId, userId))
    .orderBy(desc(follows.createdAt));
}
