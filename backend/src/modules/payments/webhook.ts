import { randomUUID } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withTx, type Tx } from '../../db/client.js';
import { auditLog, payments, refunds, webhookEvents } from '../../db/schema.js';
import { getGateway, type GatewayPayment } from '../../integrations/payments.js';
import { audit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { settleRefund } from '../refunds/create.js';
import { applyCaptureInTx } from './capture.js';

const PAYMENT_EVENTS = new Set(['payment.captured', 'payment.failed']);
const REFUND_EVENTS = new Set(['refund.processed', 'refund.failed']);
/** Razorpay's documented name for a failed transfer. Not yet seen in test mode, so confirm it there. */
const TRANSFER_FAILED_EVENTS = new Set(['transfer.failed']);

const entity = z.object({ entity: z.object({ id: z.string().min(1) }) });
const refundEntity = z.object({ entity: z.object({ id: z.string().min(1), payment_id: z.string().nullish() }) });
const eventSchema = z.object({
  event: z.string().min(1),
  payload: z.object({ payment: entity.optional(), refund: refundEntity.optional(), transfer: entity.optional() }).optional(),
});
type Event = z.infer<typeof eventSchema>;

const badEvent = () => new ApiError('invalid_event', 400, 'Unreadable webhook event');

/** The ID this event is about, for the event types acted on. */
function subjectId(e: Event): string | undefined {
  const subject = PAYMENT_EVENTS.has(e.event)
    ? e.payload?.payment
    : REFUND_EVENTS.has(e.event)
      ? e.payload?.refund
      : TRANSFER_FAILED_EVENTS.has(e.event)
        ? e.payload?.transfer
        : undefined;
  return subject?.entity.id;
}

function parseEvent(raw: string): Event {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw badEvent();
  }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) throw badEvent();
  const { event } = parsed.data;
  const handled = PAYMENT_EVENTS.has(event) || REFUND_EVENTS.has(event) || TRANSFER_FAILED_EVENTS.has(event);
  if (handled && !subjectId(parsed.data)) throw badEvent();
  return parsed.data;
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

/** Whether a refund on this payment has gone to the gateway with its ID not saved yet. */
async function refundBeingSaved(tx: Tx, razorpayPaymentId: string): Promise<boolean> {
  const [unsaved] = await tx
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        eq(payments.razorpayPaymentId, razorpayPaymentId),
        eq(refunds.status, 'pending'),
        isNull(refunds.razorpayRefundId),
      ),
    );
  return unsaved !== undefined;
}

/** Flags a refund we did not make, such as one from the dashboard, once however often it is reported. */
async function flagUnknownRefund(tx: Tx, razorpayRefundId: string, razorpayPaymentId?: string | null): Promise<void> {
  const [flagged] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'refund.unknown'), sql`${auditLog.detail}->>'razorpayRefundId' = ${razorpayRefundId}`));
  if (flagged) return;
  // audit_log.entity_id is required, and this refund has no row of ours to point at.
  await audit(tx, {
    actorId: null,
    action: 'refund.unknown',
    entity: 'refund',
    entityId: randomUUID(),
    detail: { razorpayRefundId, razorpayPaymentId: razorpayPaymentId ?? null },
  });
}

/**
 * A refund ID with no row is one of three things. Already counted as failed: dealt with, as its
 * resend has a new ID. Our own save still in flight: this throws so Razorpay delivers it again, as
 * with a capture. Anything else is not ours, and failing it would only get the webhook disabled.
 */
async function applyRefund(
  tx: Tx,
  eventType: string,
  razorpayRefundId: string,
  razorpayPaymentId: string | null | undefined,
  now: Date,
): Promise<void> {
  const [refund] = await tx
    .select({
      id: refunds.id,
      attempts: refunds.attempts,
      status: refunds.status,
      paymentId: refunds.paymentId,
      reverseTransfer: refunds.reverseTransfer,
      amountPaise: refunds.amountPaise,
    })
    .from(refunds)
    .where(eq(refunds.razorpayRefundId, razorpayRefundId))
    .for('update');
  if (refund) {
    await settleRefund(tx, refund, razorpayRefundId, eventType === 'refund.failed' ? 'failed' : 'processed', now);
    return;
  }

  const [counted] = await tx
    .select({ id: refunds.id })
    .from(refunds)
    .where(sql`${razorpayRefundId}::text = ANY(${refunds.failedRazorpayIds})`);
  if (counted) return;
  if (razorpayPaymentId && (await refundBeingSaved(tx, razorpayPaymentId))) {
    throw new Error(`No refund has ID ${razorpayRefundId} yet`);
  }
  await flagUnknownRefund(tx, razorpayRefundId, razorpayPaymentId);
}

/**
 * Tells an admin a transfer failed, once however often it is reported. The status stays as it is for
 * them to look into. A transfer we hold no row for is flagged as well, with a new ID for the same
 * reason as an unknown refund.
 */
async function flagFailedTransfer(tx: Tx, razorpayTransferId: string): Promise<void> {
  const [flagged] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'transfer.failed'), sql`${auditLog.detail}->>'razorpayTransferId' = ${razorpayTransferId}`));
  if (flagged) return;
  const [payment] = await tx
    .select({ id: payments.id, orderId: payments.orderId, transferStatus: payments.transferStatus })
    .from(payments)
    .where(eq(payments.razorpayTransferId, razorpayTransferId));
  await audit(tx, {
    actorId: null,
    action: 'transfer.failed',
    entity: 'payment',
    entityId: payment?.id ?? randomUUID(),
    detail: { razorpayTransferId, orderId: payment?.orderId ?? null, transferStatus: payment?.transferStatus ?? null },
  });
}

/**
 * Handles one verified Razorpay event. The event row and its effect commit together, so a failure
 * leaves nothing recorded and Razorpay's retry does the work. The row keeps IDs only, as the body
 * holds customer details and a replay comes from Razorpay. The gateway is read before the
 * transaction opens, because provider calls never run inside one.
 */
export async function handleWebhook(raw: string, signature: string, eventId: string, now: Date): Promise<void> {
  const gateway = getGateway();
  if (!gateway.verifyWebhook(raw, signature)) throw new ApiError('invalid_signature', 401, 'Invalid signature');
  if (!eventId) throw badEvent();
  const event = parseEvent(raw);

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
      .values({ eventId, eventType: event.event, subjectId: subject, receivedAt: now.toISOString() })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId });
    if (!fresh) return;

    if (gp) await applyPayment(tx, event.event, gp, now);
    else if (subject && TRANSFER_FAILED_EVENTS.has(event.event)) await flagFailedTransfer(tx, subject);
    else if (subject) await applyRefund(tx, event.event, subject, event.payload?.refund?.entity.payment_id, now);
  });
}
