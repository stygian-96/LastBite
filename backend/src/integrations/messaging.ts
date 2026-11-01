export type OutboundMessage = {
  phone: string;
  channel: 'whatsapp' | 'sms';
  template: string;
  variables: object;
};

export interface MessageSender {
  send(m: OutboundMessage): Promise<{ providerId: string }>;
}

/** Records messages instead of sending them. Used by tests. */
export class FakeMessenger implements MessageSender {
  readonly sent: OutboundMessage[] = [];

  async send(m: OutboundMessage): Promise<{ providerId: string }> {
    this.sent.push(m);
    return { providerId: `fake_${this.sent.length}` };
  }
}

/** Stand-in until a real provider is wired: logs outside production, refuses in production. */
class UnconfiguredMessenger implements MessageSender {
  async send(m: OutboundMessage): Promise<{ providerId: string }> {
    if (process.env.NODE_ENV === 'production') throw new Error('No message provider configured');
    console.log(`[messaging] ${m.channel} to ${m.phone}: ${m.template}`, m.variables);
    return { providerId: 'dev_log' };
  }
}

let messenger: MessageSender = new UnconfiguredMessenger();

export function getMessenger(): MessageSender {
  return messenger;
}

export function setMessenger(m: MessageSender): void {
  messenger = m;
}
