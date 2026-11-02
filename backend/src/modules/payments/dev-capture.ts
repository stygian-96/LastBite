import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { orders, payments } from '../../db/schema.js';
import { FakeGateway, getGateway, type GatewayPayment } from '../../integrations/payments.js';
import { ApiError } from '../../lib/errors.js';
import { applyCapture } from './capture.js';

/** Roughly what Razorpay charges, so payouts show a fee in local development. */
const FEE_BPS = 200;

const notFound = () => new ApiError('not_found', 404, 'Order not found');

/**
 * Local development only: stands in for the customer paying. There is no Razorpay checkout to finish,
 * so this makes the captured payment the webhook would have reported, and applies it the same way.
 * The order must have started paying. The payment ID comes from the row, so a repeat changes nothing.
 */
export async function devCapture(orderId: string, now: Date): Promise<boolean> {
  const gateway = getGateway();
  if (!(gateway instanceof FakeGateway) || !z.uuid().safeParse(orderId).success) throw notFound();

  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound();
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(asc(payments.createdAt)).limit(1);
  if (!payment) throw new ApiError('payment_not_started', 409, 'Start the payment first');

  const captured: GatewayPayment = {
    id: payment.razorpayPaymentId ?? `pay_dev_${payment.id}`,
    orderId: payment.razorpayOrderId,
    status: 'captured',
    amountPaise: payment.amountPaise,
    feePaise: Math.round((payment.amountPaise * FEE_BPS) / 10000),
    method: 'upi',
  };
  // Later jobs may ask the gateway about this payment.
  gateway.addPayment(captured);
  return applyCapture(captured, now);
}
