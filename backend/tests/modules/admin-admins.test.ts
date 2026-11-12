import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { auditLog, users } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { app } from '../../src/app.js';
import { addAdmin, listAdmins, removeAdmin } from '../../src/modules/admin/admins.js';
import { changeUserPhone } from '../../src/modules/admin/support.js';
import { createSession } from '../../src/modules/auth/session.js';
import { makeUser } from '../helpers/factories.js';
import { resetDb } from '../helpers/db.js';

beforeEach(resetDb);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code: string; status: number },
  );
const userRow = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!;

async function headersFor(o: Parameters<typeof makeUser>[0]) {
  const user = await makeUser(o);
  const token = await createSession(user.id, new Date());
  return { user, headers: { cookie: `session=${token}`, origin: env().FRONTEND_ORIGIN, 'content-type': 'application/json' } };
}
const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe('routes', () => {
  test('only a super admin manages admins; any admin can read their own profile', async () => {
    const admin = await headersFor({ isAdmin: true });
    const customer = await headersFor({});
    const id = randomUUID();
    for (const h of [admin.headers, customer.headers]) {
      expect((await call(h, 'GET', '/admins')).status).toBe(403);
      expect((await call(h, 'POST', '/admins', { phone: '9876543210' })).status).toBe(403);
      expect((await call(h, 'DELETE', `/admins/${id}`)).status).toBe(403);
    }
    expect((await call({ 'content-type': 'application/json' }, 'GET', '/admins')).status).toBe(401);
    expect((await call(customer.headers, 'GET', '/me')).status).toBe(403);
    const me = await call(admin.headers, 'GET', '/me');
    expect(await me.json()).toEqual({ me: { id: admin.user.id, phone: admin.user.phone, name: admin.user.name, isSuperAdmin: false } });
  });

  test('a super admin adds, lists and removes an admin over HTTP', async () => {
    const boss = await headersFor({ isAdmin: true, isSuperAdmin: true });
    const added = await call(boss.headers, 'POST', '/admins', { phone: '98765 43210', name: 'Asha' });
    expect(added.status).toBe(200);
    const { admin } = (await added.json()) as { admin: { id: string } };
    const list = (await (await call(boss.headers, 'GET', '/admins')).json()) as { admins: { id: string; isSuperAdmin: boolean }[] };
    expect(list.admins.map((a) => [a.id, a.isSuperAdmin])).toEqual([
      [boss.user.id, true],
      [admin.id, false],
    ]);
    expect((await call(boss.headers, 'DELETE', `/admins/${admin.id}`)).status).toBe(200);
    expect((await userRow(admin.id)).isAdmin).toBe(false);
  });

  test('a removed admin is refused on their very next request', async () => {
    const boss = await makeUser({ isAdmin: true, isSuperAdmin: true });
    const admin = await headersFor({ isAdmin: true });
    expect((await call(admin.headers, 'GET', '/vendors')).status).toBe(200);
    await removeAdmin(boss.id, admin.user.id);
    expect((await call(admin.headers, 'GET', '/vendors')).status).toBe(403);
  });
});

describe('addAdmin', () => {
  test('makes an account for a number that never signed in, and audits without the full number', async () => {
    const boss = await makeUser({ isAdmin: true, isSuperAdmin: true });
    const added = await addAdmin(boss.id, { phone: '+91 98765 43210', name: 'Asha' });
    expect(added).toMatchObject({ phone: '+919876543210', name: 'Asha', isSuperAdmin: false });
    expect((await userRow(added.id)).isAdmin).toBe(true);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.add'));
    expect(row).toMatchObject({ actorId: boss.id, entityId: added.id, detail: { phoneLast4: '3210' } });
  });

  test("an existing customer keeps their account and their own name", async () => {
    const boss = await makeUser({ isAdmin: true, isSuperAdmin: true });
    const customer = await makeUser({ phone: '+919876543211', name: 'Ravi' });
    const added = await addAdmin(boss.id, { phone: '9876543211', name: 'Someone else' });
    expect(added).toMatchObject({ id: customer.id, name: 'Ravi' });
  });

  test('refuses a bad number and an existing admin', async () => {
    const boss = await makeUser({ isAdmin: true, isSuperAdmin: true });
    expect(await failure(addAdmin(boss.id, { phone: '12345' }))).toMatchObject({ code: 'invalid_phone', status: 400 });
    await makeUser({ phone: '+919876543212', isAdmin: true });
    expect(await failure(addAdmin(boss.id, { phone: '9876543212' }))).toMatchObject({ code: 'already_admin', status: 409 });
  });
});

describe('removeAdmin and listAdmins', () => {
  test('a super admin cannot be removed, and non-admins are not found', async () => {
    const boss = await makeUser({ isAdmin: true, isSuperAdmin: true });
    const other = await makeUser({ isAdmin: true, isSuperAdmin: true });
    const customer = await makeUser();
    expect(await failure(removeAdmin(boss.id, other.id))).toMatchObject({ code: 'super_admin', status: 409 });
    expect(await failure(removeAdmin(boss.id, boss.id))).toMatchObject({ code: 'super_admin', status: 409 });
    expect(await failure(removeAdmin(boss.id, customer.id))).toMatchObject({ status: 404 });
    expect(await failure(removeAdmin(boss.id, 'nope'))).toMatchObject({ status: 404 });
  });

  test('lists admins only, super admins first, deleted accounts left out', async () => {
    const plain = await makeUser({ isAdmin: true });
    const boss = await makeUser({ isAdmin: true, isSuperAdmin: true });
    await makeUser();
    await makeUser({ isAdmin: true, deletedAt: new Date().toISOString() });
    expect((await listAdmins()).map((a) => a.id)).toEqual([boss.id, plain.id]);
  });

  test('the database refuses a super admin who is not an admin', async () => {
    await expect(makeUser({ isAdmin: false, isSuperAdmin: true })).rejects.toThrow();
  });
});

describe("changing an admin's number", () => {
  test('only a super admin can, so an admin cannot take over another admin', async () => {
    const admin = await makeUser({ isAdmin: true });
    const boss = await makeUser({ isAdmin: true, isSuperAdmin: true });
    expect(await failure(changeUserPhone(admin.id, boss.id, '9876500001'))).toMatchObject({ status: 403 });
    expect((await userRow(boss.id)).phone).toBe(boss.phone);
    await changeUserPhone(boss.id, admin.id, '9876500002', true);
    expect((await userRow(admin.id)).phone).toBe('+919876500002');
  });

  test('over HTTP the route passes the caller', async () => {
    const admin = await headersFor({ isAdmin: true });
    const other = await makeUser({ isAdmin: true });
    expect((await call(admin.headers, 'POST', `/users/${other.id}/phone`, { phone: '9876500003' })).status).toBe(403);
  });
});
