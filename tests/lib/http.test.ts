import { describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { route } from '@/lib/http';
import { ApiError } from '@/lib/errors';
import { GET as health } from '@/app/api/v1/health/route';

function fakeRequest(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/v1/test', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({}) };

describe('route', () => {
  test('ApiError becomes the error envelope', async () => {
    const h = route({}, async () => {
      throw new ApiError('sold_out', 409, 'Sold out');
    });
    const res = await h(fakeRequest('POST'), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'sold_out', message: 'Sold out' } });
  });

  test('unknown errors return 500 without leaking detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = route({}, async () => {
      throw new Error('secret db password');
    });
    const res = await h(fakeRequest('GET'), ctx);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: { code: 'internal_error', message: 'Something went wrong' } });
    expect(JSON.stringify(json)).not.toContain('secret');
    spy.mockRestore();
  });

  test('invalid body returns 400 invalid_request', async () => {
    const h = route({ body: z.object({ n: z.number() }) }, async () => ({}));
    const res = await h(fakeRequest('POST', { n: 'x' }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_request');
  });

  test('passes parsed body, params and first forwarded ip to the handler', async () => {
    const h = route({ body: z.object({ n: z.number() }) }, async (c) => ({
      n: c.body.n,
      id: c.params.id,
      ip: c.ip,
    }));
    const res = await h(fakeRequest('POST', { n: 3 }, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 3, id: 'abc', ip: '1.2.3.4' });
  });
});

describe('GET /api/v1/health', () => {
  test('returns ok', async () => {
    const res = await health(fakeRequest('GET'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
