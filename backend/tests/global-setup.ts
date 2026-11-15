import pg from 'pg';
import { migrate } from '../scripts/migrate.js';
import { seedAreas } from '../scripts/seed-areas.js';

export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  await migrate(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // The tests are written around these two cities.
    await seedAreas(client, ['bengaluru', 'hyderabad']);
  } finally {
    await client.end();
  }
}
