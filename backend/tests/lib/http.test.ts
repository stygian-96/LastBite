import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { route, handleError } from '../../src/lib/http';
import { ApiError } from '../../src/lib/errors';

const ORIGIN = 'https://www.lastbite.test';

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://x';
  process.env.FRONTEND_ORIGIN = ORIGIN;
  process.env.COOKIE_DOMAIN = 'lastbite.test';
});

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

  test('passes parsed body, params and first forwarded ip to the handler', async () => {
    const t = harness();
    t.post('/x/:id', route({ body: z.object({ n: z.number() }) }, async (c) => ({
      n: c.body.n,
      id: c.params.id,
      ip: c.ip,
    })));
    const res = await t.request('/x/abc', post({ n: 3 }, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 3, id: 'abc', ip: '1.2.3.4' });
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

  test('GET /api/v1/health returns 200', async () => {
    const { app } = await import('../../src/app');
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
