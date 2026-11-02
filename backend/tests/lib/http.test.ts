import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { route, handleError } from '../../src/lib/http';
import { env } from '../../src/lib/env';
import { ApiError } from '../../src/lib/errors';

// Importing route loads the db client, which caches env, so use the configured origin.
const ORIGIN = process.env.FRONTEND_ORIGIN!;

function harness() {
  return new Hono().onError(handleError);
}
const post = (body?: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('route', () => {
  test('ApiError becomes the error envelope', async () => {
    const t = harness();
    t.post('/x', route({}, async () => {
      throw new ApiError('sold_out', 409, 'Sold out');
    }));
    const res = await t.request('/x', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'sold_out', message: 'Sold out' } });
  });

  test('unknown errors return 500 without leaking detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = harness();
    t.get('/x', route({}, async () => {
      throw new Error('secret db password');
    }));
    const res = await t.request('/x');
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: { code: 'internal_error', message: 'Something went wrong' } });
    expect(JSON.stringify(json)).not.toContain('secret');
    spy.mockRestore();
  });

  test('invalid body returns 400 invalid_request', async () => {
    const t = harness();
    t.post('/x', route({ body: z.object({ n: z.number() }) }, async () => ({})));
    const res = await t.request('/x', post({ n: 'x' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  test('passes parsed body, params and the trusted forwarded ip to the handler', async () => {
    const t = harness();
    t.post('/x/:id', route({ body: z.object({ n: z.number() }) }, async (c) => ({
      n: c.body.n,
      id: c.params.id,
      ip: c.ip,
    })));
    const res = await t.request('/x/abc', post({ n: 3 }, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 3, id: 'abc', ip: '5.6.7.8' });
  });
});

describe('client address', () => {
  const seen = async (headers: Record<string, string>) => {
    const t = harness();
    t.get('/x', route({}, async (c) => ({ ip: c.ip })));
    return ((await (await t.request('/x', { headers })).json()) as { ip: string }).ip;
  };

  test('takes the entry the trusted proxy added, not what the client sent', async () => {
    expect(await seen({ 'x-forwarded-for': ' 6.6.6.6 , 1.2.3.4 ' })).toBe('1.2.3.4');
  });

  test('counts TRUSTED_PROXY_HOPS from the right', async () => {
    env().TRUSTED_PROXY_HOPS = 2;
    try {
      expect(await seen({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.1' })).toBe('1.2.3.4');
    } finally {
      env().TRUSTED_PROXY_HOPS = 1;
    }
  });

  test('a header shorter than the hops leaves the socket address, here none', async () => {
    env().TRUSTED_PROXY_HOPS = 2;
    try {
      expect(await seen({ 'x-forwarded-for': '1.2.3.4' })).toBe('');
    } finally {
      env().TRUSTED_PROXY_HOPS = 1;
    }
  });

  test('ignores the header when the proxy is not trusted', async () => {
    env().TRUST_PROXY = false;
    try {
      expect(await seen({ 'x-forwarded-for': '1.2.3.4' })).toBe('');
    } finally {
      env().TRUST_PROXY = true;
    }
  });

  test('a trusted proxy that sent nothing leaves the socket address, here none', async () => {
    expect(await seen({})).toBe('');
  });
});

describe('handleError', () => {
  test('HTTPException maps to the envelope with its status', async () => {
    const t = harness();
    t.get('/x', () => {
      throw new HTTPException(413, { message: 'Too big' });
    });
    const res = await t.request('/x');
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'http_error', message: 'Too big' } });
  });
});

describe('app', () => {
  test('CORS allows FRONTEND_ORIGIN with credentials and refuses other origins', async () => {
    const { app } = await import('../../src/app');
    const ok = await app.request('/api/v1/health', { headers: { origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');

    const bad = await app.request('/api/v1/health', { headers: { origin: 'https://evil.test' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('unknown paths return the not_found envelope', async () => {
    const { app } = await import('../../src/app');
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  test('app wires handleError as its error handler', async () => {
    const { app } = await import('../../src/app');
    expect((app as unknown as { errorHandler: unknown }).errorHandler).toBe(handleError);
  });

  test('GET /api/v1/health returns 200', async () => {
    const { app } = await import('../../src/app');
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
