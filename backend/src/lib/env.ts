import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  FRONTEND_ORIGIN: z.string().min(1),
  // Leave empty or unset for localhost: cookies then carry no Domain attribute.
  COOKIE_DOMAIN: z.string().optional(),
  ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(4000),
  // Optional until the real gateway arrives, then required in production.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validates process.env on first use, then returns the cached result. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
