// Adds a city's areas: `tsx scripts/seed-areas.ts delhi`. With no city named, adds them all.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DELHI_AREAS } from './delhi-areas.js';

export const AREAS = {
  bengaluru: ['Indiranagar', 'Koramangala', 'Jayanagar', 'Whitefield', 'HSR Layout', 'Malleshwaram'],
  hyderabad: ['Madhapur', 'Kondapur', 'Banjara Hills', 'Kukatpally', 'Secunderabad'],
  delhi: DELHI_AREAS,
};

export type City = keyof typeof AREAS;

const isCity = (s: string): s is City => Object.hasOwn(AREAS, s);

/** Inserts the areas of the given cities. Safe to run repeatedly. */
export async function seedAreas(client: Pick<pg.Client, 'query'>, cities: City[]): Promise<void> {
  for (const city of cities) {
    await client.query(
      'INSERT INTO areas (city, name) SELECT $1, unnest($2::text[]) ON CONFLICT (city, name) DO NOTHING',
      [city, AREAS[city]],
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const asked = process.argv.slice(2);
  const unknown = asked.filter((c) => !isCity(c));
  if (unknown.length) {
    console.error(`Unknown city: ${unknown.join(', ')}. Known: ${Object.keys(AREAS).join(', ')}`);
    process.exit(1);
  }
  const cities = asked.length ? (asked as City[]) : (Object.keys(AREAS) as City[]);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await seedAreas(client, cities);
    console.log(`Areas seeded: ${cities.map((c) => `${c} (${AREAS[c].length})`).join(', ')}`);
  } finally {
    await client.end();
  }
}
