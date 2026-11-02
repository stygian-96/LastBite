import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  FRONTEND_ORIGIN: z.string().min(1),
  // The product name in message copy.
  BRAND_NAME: z.string().min(1).default('LastBite'),
  // Leave empty or unset for localhost: cookies then carry no Domain attribute.
  COOKIE_DOMAIN: z.string().optional(),
  ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(4000),
  // Only when a proxy in front sets x-forwarded-for. Anyone can send that header to a bare server.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // How many proxies in front add to x-forwarded-for. The address is that many entries from the right.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().positive().default(1),
  CRON_SECRET: z.string().optional(),
  // Local development with no keys: the fake gateway and store. Counts only with NODE_ENV=development.
  DEV_FAKE_PROVIDERS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // A domain of ours. Linked accounts each need an email Razorpay has not seen, and take one on this.
  RAZORPAY_LINKED_EMAIL_DOMAIN: z.string().optional(),
  MESSAGING_API_URL: z.string().optional(),
  MESSAGING_API_KEY: z.string().optional(),
  MESSAGING_WEBHOOK_SECRET: z.string().optional(),
  MESSAGING_WEBHOOK_SIGNATURE_HEADER: z.string().min(1).default('x-webhook-signature'),
  AWS_REGION: z.string().optional(),
  S3_PUBLIC_BUCKET: z.string().optional(),
  S3_PRIVATE_BUCKET: z.string().optional(),
  // A CDN or custom domain in front of the public bucket. Without one, links go to S3 itself.
  S3_PUBLIC_BASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** Optional in development and tests, where the adapters that use them are not selected. */
const REQUIRED_IN_PRODUCTION = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAY_LINKED_EMAIL_DOMAIN',
  'MESSAGING_API_URL',
  'MESSAGING_API_KEY',
  'MESSAGING_WEBHOOK_SECRET',
  'AWS_REGION',
  'S3_PUBLIC_BUCKET',
  'S3_PRIVATE_BUCKET',
  'CRON_SECRET',
] as const;

/** Validates a set of variables. Production also refuses to start with any adapter unconfigured. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = schema.parse(source);
  if (source.NODE_ENV === 'production') {
    if (parsed.DEV_FAKE_PROVIDERS) throw new Error('DEV_FAKE_PROVIDERS must not be set in production');
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => !parsed[name]);
    if (missing.length > 0) throw new Error(`Missing environment variables for production: ${missing.join(', ')}`);
  }
  return parsed;
}

let cached: Env | undefined;

/** Validates process.env on first use, then returns the cached result. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Whether local development has asked for the fakes. Only NODE_ENV=development can. */
export function devFakeProviders(): boolean {
  return process.env.NODE_ENV === 'development' && env().DEV_FAKE_PROVIDERS;
}
