import type { Context, Handler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import type { ZodType } from 'zod';
import { ApiError } from './errors.js';

export type SessionUser = { id: string; role: 'user' | 'admin' };

export type RouteCtx<B> = {
  c: Context;
  params: Record<string, string>;
  body: B;
  user: SessionUser | null;
  ip: string;
  now: Date;
};

type RouteOpts<B> = {
  // Only 'none' is supported until auth is wired in Task 4.
  auth?: 'none' | 'user' | 'admin';
  body?: ZodType<B>;
};

function envelope(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as ContentfulStatusCode);
}

/** Hono onError handler: writes the error envelope, never leaking internals. */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return envelope(c, err.status, err.code, err.message);
  if (err instanceof HTTPException) return envelope(c, err.status, 'http_error', err.message);
  console.error(err);
  return envelope(c, 500, 'internal_error', 'Something went wrong');
}

export function route<B = undefined>(
  opts: RouteOpts<B>,
  handler: (ctx: RouteCtx<B>) => Promise<unknown>,
): Handler {
  return async (c) => {
    let body = undefined as B;
    if (opts.body) {
      const raw: unknown = await c.req.json().catch(() => undefined);
      const parsed = opts.body.safeParse(raw);
      if (!parsed.success) throw new ApiError('invalid_request', 400, 'Invalid request');
      body = parsed.data;
    }
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
    const result = await handler({
      c,
      params: c.req.param() as Record<string, string>,
      body,
      user: null,
      ip,
      now: new Date(),
    });
    if (result instanceof Response) return result;
    return c.json(result ?? null);
  };
}
