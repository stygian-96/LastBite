import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { pool, withTx, type Tx } from '../src/db/client.js';
import { areas, brands, memberships, outlets, payoutAccounts, users } from '../src/db/schema.js';
import { audit } from '../src/lib/audit.js';
import { firstFree, slugify } from '../src/modules/onboarding/outlets.js';

const COLUMNS = [
  'brand',
  'branch',
  'area',
  'city',
  'address',
  'pincode',
  'maps_url',
  'fssai_number',
  'fssai_expires_on',
  'gstin',
  'payout_account_id',
] as const;

const rowSchema = z.object({
  brand: z.string().trim().min(1).max(100),
  branch: z.string().trim().min(1).max(100),
  area: z.string().trim().min(1),
  city: z.string().trim().toLowerCase().min(1),
  address: z.string().trim().min(1),
  pincode: z.string().trim().regex(/^\d{6}$/),
  maps_url: z.url(),
  fssai_number: z.string().trim().regex(/^\d{14}$/),
  fssai_expires_on: z.iso.date(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/),
  payout_account_id: z.union([z.literal(''), z.uuid()]),
});
type Row = z.output<typeof rowSchema>;

/** Splits CSV text into lines of fields: commas and line breaks count unless inside double quotes. */
function parseLines(text: string): string[][] {
  const lines: string[][] = [];
  let line: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      line.push(field);
      field = '';
    } else if (ch === '\n') {
      lines.push([...line, field.replace(/\r$/, '')]);
      line = [];
      field = '';
    } else field += ch;
  }
  if (field || line.length > 0) lines.push([...line, field]);
  return lines;
}

/** The rows of a CSV as objects, by its header line. */
export function parseCsv(text: string): Record<string, string>[] {
  const [header, ...rows] = parseLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!header) return [];
  return rows.map((fields, i) => {
    if (fields.length !== header.length) throw new Error(`CSV line ${i + 2} has ${fields.length} columns, not ${header.length}`);
    return Object.fromEntries(header.map((name, c) => [name.trim(), fields[c]!]));
  });
}

async function brandFor(tx: Tx, ownerId: string, name: string): Promise<string> {
  const base = slugify(name, 'brand');
  const [existing] = await tx.select({ id: brands.id }).from(brands).where(eq(brands.slug, base));
  if (existing) {
    const [owned] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.brandId, existing.id),
          eq(memberships.userId, ownerId),
          eq(memberships.role, 'owner'),
          isNull(memberships.removedAt),
        ),
      );
    if (!owned) throw new Error(`The user given is not the owner of brand ${name}`);
    return existing.id;
  }
  const [brand] = await tx.insert(brands).values({ name, slug: base, createdBy: ownerId }).returning({ id: brands.id });
  await tx.insert(memberships).values({ userId: ownerId, brandId: brand!.id, role: 'owner', outletId: null });
  await audit(tx, { actorId: ownerId, action: 'brand.create', entity: 'brand', entityId: brand!.id });
  return brand!.id;
}

/** Adds one outlet, unless the brand already has this branch. Returns whether it did. */
async function seedRow(tx: Tx, ownerId: string, row: Row, category: string, nowIso: string): Promise<boolean> {
  const [area] = await tx
    .select({ id: areas.id })
    .from(areas)
    .where(and(eq(areas.name, row.area), eq(areas.city, row.city)));
  if (!area) throw new Error(`Unknown area ${row.area} in ${row.city}`);

  const brandId = await brandFor(tx, ownerId, row.brand);
  const accountId = row.payout_account_id || null;
  if (accountId) {
    const [account] = await tx
      .select({ id: payoutAccounts.id })
      .from(payoutAccounts)
      .where(and(eq(payoutAccounts.id, accountId), eq(payoutAccounts.brandId, brandId)));
    if (!account) throw new Error(`Payout account ${accountId} is not one of ${row.brand}`);
  }

  const siblings = await tx.select({ slug: outlets.slug, branch: outlets.branchName }).from(outlets).where(eq(outlets.brandId, brandId));
  if (siblings.some((s) => s.branch === row.branch)) return false;

  const [outlet] = await tx
    .insert(outlets)
    .values({
      brandId,
      areaId: area.id,
      payoutAccountId: accountId,
      branchName: row.branch,
      slug: firstFree(slugify(row.branch, 'outlet'), siblings.map((s) => s.slug)),
      category,
      address: row.address,
      pincode: row.pincode,
      mapsUrl: row.maps_url,
      fssaiNumber: row.fssai_number,
      fssaiExpiresOn: row.fssai_expires_on,
      gstin: row.gstin,
      status: 'in_review',
      submittedAt: nowIso,
    })
    .returning({ id: outlets.id });
  await audit(tx, { actorId: ownerId, action: 'outlet.seed', entity: 'outlet', entityId: outlet!.id, detail: { brandId } });
  return true;
}

/**
 * Creates a chain's outlets in review, under an owner who has signed up. All or nothing, and safe to
 * run again: a branch the brand already has is left as it is. The file has no category column, so one
 * applies to the whole file.
 */
export async function seedChain(
  csv: string,
  ownerPhone: string,
  now: Date,
  category = 'restaurant',
): Promise<{ created: number; skipped: number }> {
  const rows = parseCsv(csv);
  const missing = rows[0] ? COLUMNS.filter((c) => !(c in rows[0]!)) : [];
  if (missing.length > 0) throw new Error(`CSV is missing columns: ${missing.join(', ')}`);

  return withTx(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, ownerPhone), isNull(users.deletedAt)));
    if (!owner) throw new Error(`No user with phone ${ownerPhone}`);

    let created = 0;
    for (const [i, raw] of rows.entries()) {
      const where = `CSV line ${i + 2}`;
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues.map((e) => e.path.join('.')).join(', ')} invalid`);
      try {
        if (await seedRow(tx, owner.id, parsed.data, category, now.toISOString())) created++;
      } catch (e) {
        throw new Error(`${where}: ${(e as Error).message}`, { cause: e });
      }
    }
    return { created, skipped: rows.length - created };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ownerPhone, category] = process.argv.slice(2);
  if (!file || !ownerPhone) throw new Error('Usage: seed-chain.ts <file.csv> <owner phone, +91...> [category]');
  try {
    const { created, skipped } = await seedChain(await readFile(file, 'utf8'), ownerPhone, new Date(), category);
    console.log(`Outlets created: ${created}, already there: ${skipped}`);
  } finally {
    await pool.end();
  }
}
