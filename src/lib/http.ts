import { NextRequest, NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { ApiError } from './errors';

export type SessionUser = { id: string; role: 'user' | 'admin' };

export type RouteCtx<B> = {
  req: NextRequest;
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

type NextCtx = { params: Promise<Record<string, string>> };

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function route<B = undefined>(
  opts: RouteOpts<B>,
  handler: (ctx: RouteCtx<B>) => Promise<unknown>,
) {
  return async (req: NextRequest, ctx: NextCtx): Promise<Response> => {
    try {
      const params = (await ctx?.params) ?? {};
      let body = undefined as B;
      if (opts.body) {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          throw new ApiError('invalid_request', 400, 'Invalid request');
        }
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) {
          throw new ApiError('invalid_request', 400, 'Invalid request');
        }
        body = parsed.data;
      }
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
      const result = await handler({ req, params, body, user: null, ip, now: new Date() });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? null);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message);
      console.error(err);
      return errorResponse(500, 'internal_error', 'Something went wrong');
    }
  };
}
