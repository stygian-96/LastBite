import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WhatsAppSmsSender } from '../../src/integrations/whatsapp-sms.js';

const CONFIG = { url: 'https://messages.example.com/v1/send', key: 'api-key', webhookSecret: 'hook-secret' };
const MESSAGE = { phone: '+919876543210', channel: 'sms', template: 'otp', variables: { code: '123456' } } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WhatsAppSmsSender', () => {
  test('posts the message with the key and a timeout, and returns the provider ID', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetched = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: 'msg_1' })));
    vi.stubGlobal('fetch', fetched);

    expect(await new WhatsAppSmsSender(CONFIG).send({ ...MESSAGE, text: 'Your code' })).toEqual({ providerId: 'msg_1' });

    const [url, init] = fetched.mock.calls[0]!;
    expect(url).toBe(CONFIG.url);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer api-key');
    expect(JSON.parse(init.body as string)).toEqual({
      to: MESSAGE.phone,
      channel: 'sms',
      template: 'otp',
      variables: { code: '123456' },
      text: 'Your code',
    });
    expect(timeout.mock.calls[0]![0]).toBeLessThan(30_000);
    timeout.mockRestore();
  });

  test('throws on a refusal, so the queue tries again or falls back to SMS', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
    await expect(new WhatsAppSmsSender(CONFIG).send(MESSAGE)).rejects.toThrow('500');
  });

  test('throws on an answer with no ID', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    await expect(new WhatsAppSmsSender(CONFIG).send(MESSAGE)).rejects.toThrow('no message ID');
  });

  test('verifyWebhook checks an HMAC of the raw body and refuses anything else', () => {
    const sender = new WhatsAppSmsSender(CONFIG);
    const raw = '{"type":"status"}';
    const good = createHmac('sha256', CONFIG.webhookSecret).update(raw).digest('hex');
    expect(sender.verifyWebhook(raw, good)).toBe(true);
    expect(sender.verifyWebhook(`${raw} `, good)).toBe(false);
    expect(sender.verifyWebhook(raw, 'abc')).toBe(false);
    expect(sender.verifyWebhook(raw, '')).toBe(false);
  });

  test.each(['url', 'key', 'webhookSecret'] as const)('refuses to start without %s', (name) => {
    expect(() => new WhatsAppSmsSender({ ...CONFIG, [name]: '' })).toThrow(name);
  });
});
