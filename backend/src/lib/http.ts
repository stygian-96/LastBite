import type { Context, Handler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import type { ZodType } from 'zod';
import { getCookie } from 'hono/cookie';
import { ApiError } from './errors.js';
import { env } from './env.js';
import { getSessionUser, type SessionUser } from '../modules/auth/session.js';

export type { SessionUser };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type RouteCtx<B> = {
  c: Context;
  params: Record<string, string>;
  body: B;
  user: SessionUser | null;
  ip: string;
  now: Date;
};

type RouteOpts<B> = {
  // 'user' needs a signed-in user, 'admin' needs an admin.
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
    const now = new Date();
    const token = getCookie(c, 'session');

    // CSRF guard: a cookie-authenticated request that is not a plain read must
    // come from the frontend. Cookie-less requests (webhooks) are unaffected.
    if (token && !SAFE_METHODS.has(c.req.method) && c.req.header('origin') !== env().FRONTEND_ORIGIN) {
      throw new ApiError('bad_origin', 403, 'Request origin not allowed');
    }

    let user: SessionUser | null = null;
    if (opts.auth === 'user' || opts.auth === 'admin') {
      user = token ? await getSessionUser(token, now) : null;
      if (!user) throw new ApiError('unauthenticated', 401, 'Sign in to continue');
      if (opts.auth === 'admin' && !user.isAdmin) throw new ApiError('forbidden', 403, 'Not allowed');
    }

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
      user,
      ip,
      now,
    });
    if (result instanceof Response) return result;
    return c.json(result ?? null);
  };
}
