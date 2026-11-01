import { serve } from '@hono/node-server';
import { app } from './app.js';
import { env } from './lib/env.js';

const port = env().PORT;
serve({ fetch: app.fetch, port }, () => {
  console.log(`API listening on http://localhost:${port}`);
});
