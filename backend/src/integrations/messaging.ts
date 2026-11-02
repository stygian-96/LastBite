import { whatsAppSmsFromEnv } from './whatsapp-sms.js';

export type OutboundMessage = {
  phone: string;
  channel: 'whatsapp' | 'sms';
  template: string;
  variables: object;
  /** The message as rendered for the channel. Absent for messages sent outside the queue, such as an OTP. */
  text?: string;
};

export interface MessageSender {
  send(m: OutboundMessage): Promise<{ providerId: string }>;
  /** Whether a webhook body was signed by the provider. */
  verifyWebhook(raw: string, signature: string): boolean;
}

/** Records messages instead of sending them. Used by tests. */
export class FakeMessenger implements MessageSender {
  readonly sent: OutboundMessage[] = [];

  async send(m: OutboundMessage): Promise<{ providerId: string }> {
    this.sent.push(m);
    return { providerId: `fake_${this.sent.length}` };
  }

  verifyWebhook(_raw: string, signature: string): boolean {
    return signature === 'valid';
  }
}

/** Local development: logs what would be sent, which is how an OTP is read there. Trusts no webhook. */
class ConsoleMessenger implements MessageSender {
  async send(m: OutboundMessage): Promise<{ providerId: string }> {
    console.log(`[messaging] ${m.channel} to ${m.phone}: ${m.template}`, m.variables);
    return { providerId: 'dev_log' };
  }

  verifyWebhook(): boolean {
    return false;
  }
}

function defaultMessenger(): MessageSender {
  if (process.env.NODE_ENV === 'production') return whatsAppSmsFromEnv();
  if (process.env.NODE_ENV === 'test') return new FakeMessenger();
  // Only by name: a server left with NODE_ENV unset must not log OTPs.
  if (process.env.NODE_ENV === 'development') return new ConsoleMessenger();
  throw new Error('No message provider: NODE_ENV is not set');
}

let messenger: MessageSender | undefined;

export function getMessenger(): MessageSender {
  messenger ??= defaultMessenger();
  return messenger;
}

export function setMessenger(m: MessageSender): void {
  messenger = m;
}
