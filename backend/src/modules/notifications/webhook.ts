import { and, asc, eq, isNull, notLike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { drops, listings, notifications, users } from '../../db/schema.js';
import { getMessenger } from '../../integrations/messaging.js';
import { ApiError } from '../../lib/errors.js';
import { isoWeekday, serviceDate } from '../../lib/time.js';
import { normalizePhone } from '../auth/otp.js';
import { requireOutlet } from '../auth/access.js';
import { publishDrop } from '../catalogue/drops.js';

/**
 * The provider is not chosen yet, so this is the one place its payload is turned into one of two
 * events. The adapter for the provider chosen maps its body to this shape before it gets here.
 */
const replyEvent = z.object({ type: z.literal('reply'), phone: z.string().min(1), payload: z.string() });
const statusEvent = z.object({ type: z.literal('status'), providerId: z.string().min(1), status: z.string() });
const eventSchema = z.discriminatedUnion('type', [replyEvent, statusEvent]);
type Event = z.infer<typeof eventSchema>;

const SAME_AS_USUAL = /^same_as_usual:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

function parseEvent(raw: string): Event | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ApiError('invalid_event', 400, 'Unreadable webhook event');
  }
  const type = (body as { type?: unknown } | null)?.type;
  // Event kinds this does not act on are acknowledged, so the provider does not retry them.
  if (type !== 'reply' && type !== 'status') return null;
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) throw new ApiError('invalid_event', 400, 'Unreadable webhook event');
  return parsed.data;
}

/**
 * A message the provider could not deliver on WhatsApp goes out again on SMS, unless its account has
 * since been deleted. Anything else about delivery is of no use to the app and is ignored.
 */
async function handleStatus(providerId: string, status: string): Promise<void> {
  if (status !== 'failed') return;
  await db
    .update(notifications)
    .set({ status: 'pending', channel: 'sms', providerId: null, sendingAt: null })
    .where(
      and(
        eq(notifications.providerId, providerId),
        eq(notifications.status, 'sent'),
        eq(notifications.channel, 'whatsapp'),
        notLike(notifications.phone, 'deleted:%'),
      ),
    );
}

/**
 * "Same as usual" from an owner or manager publishes tonight's drop of each of the outlet's
 * listings that repeats today, at its default quantity. Replies from anyone else, for another
 * day, or for a listing that already has a drop tonight change nothing.
 */
async function handleSameAsUsual(phone: string, outletId: string, date: string, now: Date): Promise<void> {
  if (date !== serviceDate(now)) return;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, normalizePhone(phone) ?? phone), isNull(users.deletedAt)));
  if (!user) return;
  try {
    await requireOutlet(user.id, outletId, ['owner', 'manager']);
  } catch (e) {
    if (e instanceof ApiError) return;
    throw e;
  }

  const repeating = await db
    .select({ id: listings.id, defaultQuantity: listings.defaultQuantity })
    .from(listings)
    .where(
      and(
        eq(listings.outletId, outletId),
        isNull(listings.archivedAt),
        sql`${isoWeekday(date)}::smallint = ANY(${listings.repeatDays})`,
      ),
    )
    .orderBy(asc(listings.createdAt), asc(listings.id));
  for (const listing of repeating) {
    const [already] = await db
      .select({ id: drops.id })
      .from(drops)
      .where(and(eq(drops.listingId, listing.id), eq(drops.serviceDate, date)));
    if (already) continue;
    try {
      await publishDrop(null, listing.id, listing.defaultQuantity, now);
    } catch (e) {
      // One listing that cannot go on sale (outlet paused, window over) must not stop the rest.
      if (!(e instanceof ApiError)) throw e;
    }
  }
}

/** Delivery status and quick replies from the WhatsApp provider. */
export async function handleWhatsAppWebhook(raw: string, signature: string, now: Date): Promise<void> {
  if (!getMessenger().verifyWebhook(raw, signature)) {
    throw new ApiError('invalid_signature', 401, 'Invalid webhook signature');
  }
  const event = parseEvent(raw);
  if (!event) return;
  if (event.type === 'status') return handleStatus(event.providerId, event.status);
  const same = SAME_AS_USUAL.exec(event.payload);
  if (same && z.uuid().safeParse(same[1]).success) await handleSameAsUsual(event.phone, same[1]!, same[2]!, now);
}
