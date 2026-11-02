import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { brands, memberships, outlets } from '../../src/db/schema.js';
import { makeBrand, makePayoutAccount, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';
import { parseCsv, seedChain } from '../../scripts/seed-chain.js';

const NOW = new Date('2026-11-02T10:00:00Z');
const HEADER = 'brand,branch,area,city,address,pincode,maps_url,fssai_number,fssai_expires_on,gstin,payout_account_id';
const line = (o: { brand?: string; branch?: string; area?: string; city?: string; account?: string; fssai?: string } = {}) =>
  [
    o.brand ?? 'Sweet Crumbs',
    o.branch ?? 'Indiranagar',
    o.area ?? 'Indiranagar',
    o.city ?? 'bengaluru',
    '"12, Church Street"',
    '560001',
    'https://maps.app.goo.gl/abc',
    o.fssai ?? '12345678901234',
    '2027-06-30',
    '29AABCU9603R1ZM',
    o.account ?? '',
  ].join(',');

beforeEach(resetDb);

describe('parseCsv', () => {
  test('handles quotes, doubled quotes, commas and CRLF', () => {
    expect(parseCsv('a,b\r\n"1, 2","say ""hi"""\r\n')).toEqual([{ a: '1, 2', b: 'say "hi"' }]);
  });

  test('refuses a row with the wrong number of columns', () => {
    expect(() => parseCsv('a,b\n1\n')).toThrow('line 2');
  });
});

describe('seedChain', () => {
  test('creates the brand and its outlets in review, under the owner', async () => {
    const owner = await makeUser();
    const csv = [HEADER, line(), line({ branch: 'Jayanagar', area: 'Jayanagar' })].join('\n');

    expect(await seedChain(csv, owner.phone, NOW)).toEqual({ created: 2, skipped: 0 });

    const [brand] = await db.select().from(brands);
    expect(brand).toMatchObject({ name: 'Sweet Crumbs', slug: 'sweet-crumbs', createdBy: owner.id });
    expect(await db.select().from(memberships)).toMatchObject([{ userId: owner.id, brandId: brand!.id, role: 'owner', outletId: null }]);
    const rows = await db.select().from(outlets).where(eq(outlets.brandId, brand!.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.branchName === 'Indiranagar')).toMatchObject({
      status: 'in_review',
      slug: 'indiranagar',
      category: 'restaurant',
      address: '12, Church Street',
      pincode: '560001',
      fssaiNumber: '12345678901234',
      fssaiExpiresOn: '2027-06-30',
      gstin: '29AABCU9603R1ZM',
      payoutAccountId: null,
    });
    expect(rows[0]!.submittedAt).not.toBeNull();
  });

  test('a category column sets it per row, and an empty cell takes the argument', async () => {
    const owner = await makeUser();
    const csv = [`${HEADER},category`, `${line()},bakery`, `${line({ branch: 'Second' })},`].join('\n');
    await seedChain(csv, owner.phone, NOW, 'cafe');
    const rows = await db.select().from(outlets);
    expect(rows.find((r) => r.branchName === 'Indiranagar')!.category).toBe('bakery');
    expect(rows.find((r) => r.branchName === 'Second')!.category).toBe('cafe');
  });

  test('a category that does not exist is refused, with its line', async () => {
    const owner = await makeUser();
    await expect(seedChain([`${HEADER},category`, `${line()},pizza`].join('\n'), owner.phone, NOW)).rejects.toThrow('line 2');
  });

  test('running the same file again changes nothing', async () => {
    const owner = await makeUser();
    const csv = [HEADER, line()].join('\n');
    await seedChain(csv, owner.phone, NOW);
    expect(await seedChain(csv, owner.phone, NOW)).toEqual({ created: 0, skipped: 1 });
    expect(await db.select().from(outlets)).toHaveLength(1);
  });

  test('takes a payout account of the same brand, and refuses another brand\'s', async () => {
    const owner = await makeUser();
    const brand = await makeBrand({ name: 'Sweet Crumbs', slug: 'sweet-crumbs', createdBy: owner.id });
    await db.insert(memberships).values({ userId: owner.id, brandId: brand.id, role: 'owner', outletId: null });
    const own = await makePayoutAccount({ brandId: brand.id });
    const other = await makePayoutAccount();

    await seedChain([HEADER, line({ account: own.id })].join('\n'), owner.phone, NOW);
    expect((await db.select().from(outlets))[0]!.payoutAccountId).toBe(own.id);

    await expect(seedChain([HEADER, line({ branch: 'Second', account: other.id })].join('\n'), owner.phone, NOW)).rejects.toThrow('line 2');
  });

  test('an existing brand must be the owner\'s', async () => {
    const owner = await makeUser();
    await makeBrand({ name: 'Sweet Crumbs', slug: 'sweet-crumbs' });
    await expect(seedChain([HEADER, line()].join('\n'), owner.phone, NOW)).rejects.toThrow('not the owner');
  });

  test('one bad row leaves nothing behind', async () => {
    const owner = await makeUser();
    const csv = [HEADER, line(), line({ branch: 'Bad', fssai: '123' })].join('\n');
    await expect(seedChain(csv, owner.phone, NOW)).rejects.toThrow('line 3');
    expect(await db.select().from(outlets)).toEqual([]);
    expect(await db.select().from(brands)).toEqual([]);
  });

  test('an unknown area or owner is refused', async () => {
    const owner = await makeUser();
    await expect(seedChain([HEADER, line({ area: 'Nowhere' })].join('\n'), owner.phone, NOW)).rejects.toThrow('Nowhere');
    await expect(seedChain([HEADER, line()].join('\n'), '+919999999999', NOW)).rejects.toThrow('+919999999999');
  });
});
