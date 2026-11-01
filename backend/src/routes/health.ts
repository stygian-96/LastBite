import { Hono } from 'hono';
import { route } from '../lib/http.js';

export const health = new Hono().get('/', route({}, async () => ({ status: 'ok' })));
