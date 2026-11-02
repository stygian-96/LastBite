import { describe, expect, test } from 'vitest';
import { parseEnv } from '../../src/lib/env.js';

const BASE = {
  DATABASE_URL: 'postgres://x',
  FRONTEND_ORIGIN: 'https://www.example.com',
  ENCRYPTION_KEY: 'key',
  SESSION_SECRET: 'a-long-enough-secret',
};
const PRODUCTION = {
  ...BASE,
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

describe('parseEnv', () => {
  test('production with everything set passes', () => {
    expect(parseEnv(PRODUCTION).CRON_SECRET).toBe('cron');
  });

  test('production names every variable that is missing or empty', () => {
    expect(() => parseEnv({ ...PRODUCTION, RAZORPAY_KEY_SECRET: undefined, CRON_SECRET: '' })).toThrow(
      'Missing environment variables for production: RAZORPAY_KEY_SECRET, CRON_SECRET',
    );
  });

  test('production refuses DEV_FAKE_PROVIDERS', () => {
    expect(() => parseEnv({ ...PRODUCTION, DEV_FAKE_PROVIDERS: 'true' })).toThrow('DEV_FAKE_PROVIDERS');
  });

  test('DEV_FAKE_PROVIDERS is on only for the word true', () => {
    expect(parseEnv({ ...BASE, DEV_FAKE_PROVIDERS: 'true' }).DEV_FAKE_PROVIDERS).toBe(true);
    expect(parseEnv({ ...BASE, DEV_FAKE_PROVIDERS: '1' }).DEV_FAKE_PROVIDERS).toBe(false);
    expect(parseEnv(BASE).DEV_FAKE_PROVIDERS).toBe(false);
  });

  test('outside production they may all be absent', () => {
    expect(parseEnv(BASE).RAZORPAY_KEY_ID).toBeUndefined();
  });

  test('TRUST_PROXY is on only for the word true', () => {
    expect(parseEnv({ ...BASE, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(parseEnv({ ...BASE, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(false);
    expect(parseEnv(BASE).TRUST_PROXY).toBe(false);
  });

  test('the webhook signature header has a default', () => {
    expect(parseEnv(BASE).MESSAGING_WEBHOOK_SIGNATURE_HEADER).toBe('x-webhook-signature');
    expect(parseEnv({ ...BASE, MESSAGING_WEBHOOK_SIGNATURE_HEADER: 'x-hub-signature' }).MESSAGING_WEBHOOK_SIGNATURE_HEADER).toBe('x-hub-signature');
  });
});
