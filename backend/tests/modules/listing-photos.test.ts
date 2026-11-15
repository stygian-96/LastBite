import { beforeEach, describe, expect, test } from 'vitest';
import { app } from '../../src/app.js';
import { db } from '../../src/db/client.js';
import { memberships } from '../../src/db/schema.js';
import { FakeStore, setStore } from '../../src/integrations/storage.js';
import { env } from '../../src/lib/env.js';
import { createSession } from '../../src/modules/auth/session.js';
import { resetDb } from '../helpers/db.js';
import { makeListing, makeLiveOutlet, makeUser } from '../helpers/factories.js';

beforeEach(async () => {
  await resetDb();
  setStore(new FakeStore());
});

describe('vendor listings carry a link to their photo', () => {
  test('so the edit form can show the photo already there', async () => {
    const outlet = await makeLiveOutlet();
    const owner = await makeUser();
    await db.insert(memberships).values({ userId: owner.id, brandId: outlet.brandId, role: 'owner' });
    const withPhoto = await makeListing({ outletId: outlet.id, photoKey: `photos/${owner.id}/a.jpg` });
    const without = await makeListing({ outletId: outlet.id });

    const res = await app.request(`/api/v1/vendor/outlets/${outlet.id}/listings`, {
      headers: { cookie: `session=${await createSession(owner.id, new Date())}`, origin: env().FRONTEND_ORIGIN },
    });
    expect(res.status).toBe(200);
    const { listings } = (await res.json()) as { listings: { id: string; photoUrl: string | null }[] };

    expect(listings.find((l) => l.id === withPhoto.id)?.photoUrl).toBe(`https://fake-storage.test/public/photos/${owner.id}/a.jpg`);
    expect(listings.find((l) => l.id === without.id)?.photoUrl).toBeNull();
  });
});
