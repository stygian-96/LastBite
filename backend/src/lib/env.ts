import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  FRONTEND_ORIGIN: z.string().min(1),
  COOKIE_DOMAIN: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validates process.env on first use, then returns the cached result. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
