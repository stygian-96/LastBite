import { beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { auditLog, memberships, users } from '../../src/db/schema.js';
import { ApiError } from '../../src/lib/errors.js';
import { createSession } from '../../src/modules/auth/session.js';
import {
  addStaff,
  listAccessibleOutlets,
  removeStaff,
  requireBrandOwner,
  requireOutlet,
  requirePayoutAccount,
  type Role,
} from '../../src/modules/auth/access.js';
import { app } from '../../src/app.js';
import { env } from '../../src/lib/env.js';
import { makeBrand, makeLiveOutlet, makePayoutAccount, makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

beforeEach(resetDb);

const T0 = new Date('2026-11-01T10:00:00Z');
const ALL_ROLES: Role[] = ['owner', 'manager', 'counter'];

async function member(userId: string, brandId: string, role: Role, outletId: string | null, payoutAccountId?: string) {
  const [row] = await db
    .insert(memberships)
    .values({ userId, brandId, role, outletId, payoutAccountId: payoutAccountId ?? null })
    .returning();
  return row!;
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ApiError,
  );
const expectForbidden = async (p: Promise<unknown>) => {
  const err = await failure(p);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ code: 'forbidden', status: 403 });
};

/** A brand with two outlets, one payout account and an owner. */
async function setup() {
  const owner = await makeUser();
  const brand = await makeBrand({ createdBy: owner.id });
  const pa = await makePayoutAccount({ brandId: brand.id });
  const a = await makeLiveOutlet({ brandId: brand.id, payoutAccountId: pa.id });
  const b = await makeLiveOutlet({ brandId: brand.id, payoutAccountId: pa.id });
  await member(owner.id, brand.id, 'owner', null);
  return { owner, brand, pa, a, b };
}

describe('outlet access', () => {
  test('owner reaches every outlet in the brand', async () => {
    const { owner, a, b } = await setup();
    expect((await requireOutlet(owner.id, a.id, ['manager'])).role).toBe('owner');
    expect((await requireOutlet(owner.id, b.id, ['counter'])).role).toBe('owner');
    expect((await listAccessibleOutlets(owner.id)).map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('counter at outlet A gets 403 at outlet B', async () => {
    const { brand, a, b } = await setup();
    const staff = await makeUser();
    await member(staff.id, brand.id, 'counter', a.id);
    expect((await requireOutlet(staff.id, a.id, ['counter'])).outletId).toBe(a.id);
    await expectForbidden(requireOutlet(staff.id, b.id, ['counter']));
  });

  test('owner of brand A gets 403 at brand B', async () => {
    const { owner } = await setup();
    const other = await setup();
    await expectForbidden(requireOutlet(owner.id, other.a.id, ALL_ROLES));
    await expectForbidden(requireBrandOwner(owner.id, other.brand.id));
  });

  test('counter is rejected for a manager-only action', async () => {
    const { brand, a } = await setup();
    const staff = await makeUser();
    await member(staff.id, brand.id, 'counter', a.id);
    await expectForbidden(requireOutlet(staff.id, a.id, ['manager']));
  });

  test('removed staff get 403 straight away', async () => {
    const { owner, brand, a } = await setup();
    const staff = await makeUser();
    const m = await member(staff.id, brand.id, 'manager', a.id);
    await requireOutlet(staff.id, a.id, ['manager']);
    await removeStaff(owner.id, m.id, T0);
    await expectForbidden(requireOutlet(staff.id, a.id, ['manager']));
    expect(await listAccessibleOutlets(staff.id)).toEqual([]);
  });

  test('a user with no membership gets 403', async () => {
    const { a } = await setup();
    await expectForbidden(requireOutlet((await makeUser()).id, a.id, ALL_ROLES));
  });

  test('an unknown outlet gets 403', async () => {
    const { owner } = await setup();
    await expectForbidden(requireOutlet(owner.id, '00000000-0000-4000-8000-000000000000', ALL_ROLES));
  });

  test('staff at two outlets reach both', async () => {
    const { brand, a, b } = await setup();
    const staff = await makeUser();
    await member(staff.id, brand.id, 'counter', a.id);
    await member(staff.id, brand.id, 'manager', b.id);
    await requireOutlet(staff.id, a.id, ['counter']);
    await requireOutlet(staff.id, b.id, ['manager']);
    expect((await listAccessibleOutlets(staff.id)).map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('payout account access', () => {
  async function franchise() {
    const s = await setup();
    const franchisee = await makeUser();
    const fpa = await makePayoutAccount({ brandId: s.brand.id });
    const fOutlet = await makeLiveOutlet({ brandId: s.brand.id, payoutAccountId: fpa.id });
    await member(franchisee.id, s.brand.id, 'manager', fOutlet.id, fpa.id);
    return { ...s, franchisee, fpa, fOutlet };
  }

  test('franchisee cannot read another payout account in the same brand', async () => {
    const { franchisee, fpa, pa } = await franchise();
    await requirePayoutAccount(franchisee.id, fpa.id);
    await expectForbidden(requirePayoutAccount(franchisee.id, pa.id));
  });

  test('brand owner cannot read a franchisee payout account', async () => {
    const { owner, fpa, pa } = await franchise();
    await expectForbidden(requirePayoutAccount(owner.id, fpa.id));
    await requirePayoutAccount(owner.id, pa.id);
  });

  test('owner can read an account once the franchisee is removed', async () => {
    const { owner, fpa, franchisee } = await franchise();
    await db.update(memberships).set({ removedAt: T0.toISOString() }).where(eq(memberships.userId, franchisee.id));
    await requirePayoutAccount(owner.id, fpa.id);
    await expectForbidden(requirePayoutAccount(franchisee.id, fpa.id));
  });

  test('another brand owner is rejected', async () => {
    const { pa } = await franchise();
    const other = await setup();
    await expectForbidden(requirePayoutAccount(other.owner.id, pa.id));
  });
});

describe('staff management', () => {
  test('owner adds a new user by phone and an existing one', async () => {
    const { owner, brand, a } = await setup();
    const m = await addStaff(owner.id, a.id, { phone: '98765 43210', name: 'Asha', role: 'counter' });
    expect(m).toMatchObject({ brandId: brand.id, outletId: a.id, role: 'counter' });
    const [u] = await db.select().from(users).where(eq(users.phone, '+919876543210'));
    expect(u).toMatchObject({ id: m.userId, name: 'Asha' });
    await requireOutlet(m.userId, a.id, ['counter']);

    const existing = await makeUser();
    const m2 = await addStaff(owner.id, a.id, { phone: existing.phone, name: 'Ignored', role: 'manager' });
    expect(m2.userId).toBe(existing.id);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'staff.add'));
    expect(audits).toHaveLength(2);
  });

  test('only an owner can add or remove staff', async () => {
    const { brand, a } = await setup();
    const mgr = await makeUser();
    const mm = await member(mgr.id, brand.id, 'manager', a.id);
    await expectForbidden(addStaff(mgr.id, a.id, { phone: '9876543210', name: 'X', role: 'counter' }));
    await expectForbidden(removeStaff(mgr.id, mm.id, T0));
  });

  test('adding the same person twice is a conflict, and owner role is refused', async () => {
    const { owner, a } = await setup();
    await addStaff(owner.id, a.id, { phone: '9876543210', name: 'X', role: 'counter' });
    expect(await failure(addStaff(owner.id, a.id, { phone: '9876543210', name: 'X', role: 'manager' }))).toMatchObject({
      code: 'already_member',
      status: 409,
    });
    expect(await failure(addStaff(owner.id, a.id, { phone: '9123456780', name: 'Y', role: 'owner' }))).toMatchObject({
      status: 400,
    });
    expect(await failure(addStaff(owner.id, a.id, { phone: '123', name: 'Y', role: 'counter' }))).toMatchObject({
      code: 'invalid_phone',
    });
  });

  test('removal sets removed_at, audits, and a person can be re-added', async () => {
    const { owner, a } = await setup();
    const m = await addStaff(owner.id, a.id, { phone: '9876543210', name: 'X', role: 'counter' });
    await removeStaff(owner.id, m.id, T0);
    const [row] = await db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(new Date(row!.removedAt!).getTime()).toBe(T0.getTime());
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'staff.remove'), eq(auditLog.entityId, m.id)));
    expect(audits).toHaveLength(1);
    expect(await failure(removeStaff(owner.id, m.id, T0))).toMatchObject({ code: 'not_found', status: 404 });
    await addStaff(owner.id, a.id, { phone: '9876543210', name: 'X', role: 'counter' });
  });

  test('owner memberships cannot be removed through staff removal', async () => {
    const { owner } = await setup();
    const [om] = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
    expect(await failure(removeStaff(owner.id, om!.id, T0))).toMatchObject({ status: 400 });
  });

  test('POST and DELETE /vendor/outlets/:id/staff', async () => {
    const { owner, a } = await setup();
    const token = await createSession(owner.id, new Date());
    const headers = { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN, 'content-type': 'application/json' };
    const post = await app.request(`/api/v1/vendor/outlets/${a.id}/staff`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: '9876543210', name: 'Asha', role: 'counter' }),
    });
    expect(post.status).toBe(200);
    const { membership } = (await post.json()) as { membership: { id: string; role: string } };
    expect(membership.role).toBe('counter');
    const del = await app.request(`/api/v1/vendor/outlets/${a.id}/staff`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ membershipId: membership.id }),
    });
    expect(del.status).toBe(200);
    const anon = await app.request(`/api/v1/vendor/outlets/${a.id}/staff`, { method: 'POST', body: '{}' });
    expect(anon.status).toBe(401);
  });
});
