import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  RAZORPAY_KEY_ID: 'rzp_live_key',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'hook',
  RAZORPAY_LINKED_EMAIL_DOMAIN: 'payouts.example.com',
  MESSAGING_API_URL: 'https://messages.example.com/send',
  MESSAGING_API_KEY: 'key',
  MESSAGING_WEBHOOK_SECRET: 'hook',
  AWS_REGION: 'ap-south-1',
  S3_PUBLIC_BUCKET: 'pub',
  S3_PRIVATE_BUCKET: 'priv',
  CRON_SECRET: 'cron',
};

// Each provider module keeps its choice in a variable, so every test takes fresh copies.
const load = async () => ({
  payments: await import('../../src/integrations/payments.js'),
  messaging: await import('../../src/integrations/messaging.js'),
  storage: await import('../../src/integrations/storage.js'),
  razorpay: await import('../../src/integrations/razorpay.js'),
  whatsapp: await import('../../src/integrations/whatsapp-sms.js'),
  s3: await import('../../src/integrations/s3.js'),
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provider selection', () => {
  test('production gets the real adapters', async () => {
    for (const [k, v] of Object.entries(PRODUCTION_ENV)) vi.stubEnv(k, v);
    const m = await load();
    expect(m.payments.getGateway()).toBeInstanceOf(m.razorpay.RazorpayGateway);
    expect(m.messaging.getMessenger()).toBeInstanceOf(m.whatsapp.WhatsAppSmsSender);
    expect(m.storage.getStore()).toBeInstanceOf(m.s3.S3Store);
  });

  test('test gets the fakes', async () => {
    const m = await load();
    expect(m.payments.getGateway()).toBeInstanceOf(m.payments.FakeGateway);
    expect(m.messaging.getMessenger()).toBeInstanceOf(m.messaging.FakeMessenger);
    expect(m.storage.getStore()).toBeInstanceOf(m.storage.FakeStore);
  });

  test.each(['development', ''])('NODE_ENV "%s" never gets a fake', async (nodeEnv) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = await load();
    expect(() => m.payments.getGateway()).toThrow('No payment gateway');
    expect(() => m.storage.getStore()).toThrow('No file store');

    // The console messenger stays for local sign-in, and it trusts no webhook.
    const messenger = m.messaging.getMessenger();
    expect(messenger).not.toBeInstanceOf(m.messaging.FakeMessenger);
    expect(await messenger.send({ phone: '+919876543210', channel: 'sms', template: 'otp', variables: {} })).toEqual({ providerId: 'dev_log' });
    expect(log).toHaveBeenCalled();
    expect(messenger.verifyWebhook('{}', 'valid')).toBe(false);
    log.mockRestore();
  });
});
