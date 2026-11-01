import { Hono } from 'hono';
import { handleWebhook } from '../modules/payments/webhook.js';

// Not built on route(): the signature covers the raw body, and Razorpay sends no cookies.
export const webhooks = new Hono().post('/webhooks/razorpay', async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header('x-razorpay-signature') ?? '';
  const eventId = c.req.header('x-razorpay-event-id') ?? '';
  await handleWebhook(raw, signature, eventId, new Date());
  return c.json({ ok: true });
});
