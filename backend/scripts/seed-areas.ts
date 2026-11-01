import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const AREAS: Record<'bengaluru' | 'hyderabad', string[]> = {
  bengaluru: ['Indiranagar', 'Koramangala', 'Jayanagar', 'Whitefield', 'HSR Layout', 'Malleshwaram'],
  hyderabad: ['Madhapur', 'Kondapur', 'Banjara Hills', 'Kukatpally', 'Secunderabad'],
};

/** Inserts the launch areas. Safe to run repeatedly. */
export async function seedAreas(client: Pick<pg.Client, 'query'>): Promise<void> {
  for (const [city, names] of Object.entries(AREAS)) {
    for (const name of names) {
      await client.query('INSERT INTO areas (city, name) VALUES ($1, $2) ON CONFLICT (city, name) DO NOTHING', [
        city,
        name,
      ]);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await seedAreas(client);
    console.log('Areas seeded');
  } finally {
    await client.end();
  }
}
