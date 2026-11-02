import { verifyHexHmac } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import type { MessageSender, OutboundMessage } from './messaging.js';

const TIMEOUT_MS = 10_000;

export type WhatsAppSmsConfig = { url: string; key: string; webhookSecret: string };

/**
 * Sends through whichever WhatsApp and SMS provider the env points at, so it can be chosen without a
 * code change. The provider takes this JSON and answers `{ id }`. One whose API differs goes behind a
 * small relay, or gets its shape changed here, and the same for the events in handleWhatsAppWebhook.
 */
export class WhatsAppSmsSender implements MessageSender {
  constructor(private readonly config: WhatsAppSmsConfig) {
    for (const [name, value] of Object.entries(config)) {
      if (!value) throw new Error(`Messaging is missing ${name}`);
    }
  }

  async send(m: OutboundMessage): Promise<{ providerId: string }> {
    const res = await fetch(this.config.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: m.phone, channel: m.channel, template: m.template, variables: m.variables, text: m.text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Message provider answered ${res.status}`);
    const { id } = (await res.json()) as { id?: unknown };
    if (typeof id !== 'string' || !id) throw new Error('Message provider gave no message ID');
    return { providerId: id };
  }

  /** The signature is a hex HMAC-SHA256 of the raw body. */
  verifyWebhook(raw: string, signature: string): boolean {
    return verifyHexHmac(this.config.webhookSecret, raw, signature);
  }
}

export function whatsAppSmsFromEnv(): WhatsAppSmsSender {
  const e = env();
  return new WhatsAppSmsSender({
    url: e.MESSAGING_API_URL ?? '',
    key: e.MESSAGING_API_KEY ?? '',
    webhookSecret: e.MESSAGING_WEBHOOK_SECRET ?? '',
  });
}
