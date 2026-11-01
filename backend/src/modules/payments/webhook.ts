import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { payments, refunds, webhookEvents } from '../../db/schema.js';
import { getGateway, type GatewayPayment } from '../../integrations/payments.js';
import { ApiError } from '../../lib/errors.js';
import { applyCaptureInTx } from './capture.js';

const PAYMENT_EVENTS = new Set(['payment.captured', 'payment.failed']);
const REFUND_STATUS: Record<string, string> = { 'refund.processed': 'processed', 'refund.failed': 'failed' };

const entity = z.object({ entity: z.object({ id: z.string().min(1) }) });
const eventSchema = z.object({
  event: z.string().min(1),
  payload: z.object({ payment: entity.optional(), refund: entity.optional() }).optional(),
});
type Event = z.infer<typeof eventSchema>;

const badEvent = () => new ApiError('invalid_event', 400, 'Unreadable webhook event');

/** The ID this event is about, for the event types acted on. */
function subjectId(e: Event): string | undefined {
  const subject = PAYMENT_EVENTS.has(e.event)
    ? e.payload?.payment
    : e.event in REFUND_STATUS
      ? e.payload?.refund
      : undefined;
  return subject?.entity.id;
}

function parseEvent(raw: string): { event: Event; payload: unknown } {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw badEvent();
  }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) throw badEvent();
  const handled = PAYMENT_EVENTS.has(parsed.data.event) || parsed.data.event in REFUND_STATUS;
  if (handled && !subjectId(parsed.data)) throw badEvent();
  return { event: parsed.data, payload };
}

/** The gateway's status decides, not the event's name. A captured payment is never marked failed. */
async function applyPayment(tx: Tx, eventType: string, gp: GatewayPayment, now: Date): Promise<void> {
  if (gp.status === 'captured') {
    await applyCaptureInTx(tx, gp, now);
  } else if (gp.status === 'failed') {
    await tx
      .update(payments)
      .set({ status: 'failed' })
      .where(and(eq(payments.razorpayOrderId, gp.orderId), ne(payments.status, 'captured')));
  } else if (eventType === 'payment.captured' && gp.status === 'authorized') {
    // Dropping this could lose a real capture, so it fails and Razorpay delivers it again.
    throw new Error(`Gateway has not captured payment ${gp.id} yet`);
  }
  // Anything else is a payment since refunded, or a failure event with nothing to record.
}

async function applyRefund(tx: Tx, eventType: string, razorpayRefundId: string): Promise<void> {
  await tx
    .update(refunds)
    .set({ status: REFUND_STATUS[eventType]! })
    .where(and(eq(refunds.razorpayRefundId, razorpayRefundId), ne(refunds.status, 'processed')));
}

/**
 * Handles one verified Razorpay event. The event row and its effect commit together, so a failure
 * leaves nothing recorded and Razorpay's retry does the work. The gateway is read before the
 * transaction opens, because provider calls never run inside one.
 */
export async function handleWebhook(raw: string, signature: string, eventId: string, now: Date): Promise<void> {
  const gateway = getGateway();
  if (!gateway.verifyWebhook(raw, signature)) throw new ApiError('invalid_signature', 401, 'Invalid signature');
  if (!eventId) throw badEvent();
  const { event, payload } = parseEvent(raw);

  const [seen] = await db
    .select({ eventId: webhookEvents.eventId })
    .from(webhookEvents)
    .where(eq(webhookEvents.eventId, eventId));
  if (seen) return;

  const subject = subjectId(event);
  const gp = subject && PAYMENT_EVENTS.has(event.event) ? await gateway.fetchPayment(subject) : undefined;

  await withTx(async (tx) => {
    const [fresh] = await tx
      .insert(webhookEvents)
      .values({ eventId, eventType: event.event, payload, receivedAt: now.toISOString() })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId });
    if (!fresh) return;

    if (gp) await applyPayment(tx, event.event, gp, now);
    else if (subject) await applyRefund(tx, event.event, subject);
  });
}
