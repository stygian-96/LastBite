import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    /** Extra fields surfaced inside the error envelope, such as a list of fixes. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Parses input with a schema, throwing a 400 `invalid_request` that names the first bad field. */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const field = r.error.issues[0]?.path.join('.');
  throw new ApiError('invalid_request', 400, field ? `Invalid value for ${field}` : 'Invalid request');
}
