import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues, orders } from '../../db/schema.js';
import { ApiError, parseInput } from '../../lib/errors.js';
import { ownedOrder } from '../orders/views.js';

export type Issue = Pick<
  typeof issues.$inferSelect,
  'id' | 'orderId' | 'reason' | 'description' | 'photoKey' | 'status' | 'createdAt'
>;

/** Where a customer's issue photos go: the private bucket, under their own ID. */
export const ISSUE_PHOTO_FOLDER = 'issues';

const REPORTABLE_STATUSES = ['paid', 'collected', 'no_show'];

const starsInput = z.number().int().min(1).max(5);
const issueInput = z.object({
  reason: z.enum(['bag_not_ready', 'quality', 'allergen', 'code_rejected', 'other']),
  description: z.string().trim().min(1).max(1000).optional(),
  photoKey: z.string().min(1).max(300).optional(),
});

const notFound = () => new ApiError('not_found', 404, 'Order not found');

/** Rates a collected order, once. The update itself decides, so a double tap cannot rate twice. */
export async function rateOrder(userId: string, orderId: string, stars: number): Promise<void> {
  const rating = parseInput(starsInput, stars);
  const mine = ownedOrder({ userId }, orderId);
  const [rated] = await db
    .update(orders)
    .set({ rating })
    .where(and(mine, eq(orders.status, 'collected'), isNull(orders.rating)))
    .returning({ id: orders.id });
  if (rated) return;

  const [order] = await db.select({ status: orders.status }).from(orders).where(mine);
  if (!order) throw notFound();
  if (order.status !== 'collected') throw new ApiError('not_collected', 409, 'Only a collected order can be rated');
  throw new ApiError('already_rated', 409, 'This order has already been rated');
}

/**
 * Records a problem with the customer's order. A photo goes up through /me/uploads first, and must
 * be one of the caller's own. Admins read it through a signed link.
 */
export async function reportIssue(userId: string, orderId: string, raw: unknown): Promise<Issue> {
  const input = parseInput(issueInput, raw);
  const { photoKey } = input;
  if (photoKey && (!photoKey.startsWith(`${ISSUE_PHOTO_FOLDER}/${userId}/`) || photoKey.includes('..'))) {
    throw new ApiError('invalid_request', 400, 'Upload the photo first, then report the problem');
  }

  const [order] = await db.select({ status: orders.status }).from(orders).where(ownedOrder({ userId }, orderId));
  if (!order) throw notFound();
  if (!REPORTABLE_STATUSES.includes(order.status)) {
    throw new ApiError('not_reportable', 409, 'A problem can be reported only on a paid or finished order');
  }

  const [issue] = await db
    .insert(issues)
    .values({ orderId, userId, ...input })
    .returning({
      id: issues.id,
      orderId: issues.orderId,
      reason: issues.reason,
      description: issues.description,
      photoKey: issues.photoKey,
      status: issues.status,
      createdAt: issues.createdAt,
    });
  return issue!;
}
