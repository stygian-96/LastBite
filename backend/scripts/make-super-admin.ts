// Makes the person with this number a super admin, creating their account if they have never signed
// in. The only way to make one: `npm run admin:super -- 98765 43210`.
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { normalizePhone } from '../src/modules/auth/otp.js';

const phone = normalizePhone(process.argv.slice(2).join(''));
if (!phone) {
  console.error('Usage: npm run admin:super -- <10-digit mobile number>');
  process.exit(1);
}
await db.insert(users).values({ phone }).onConflictDoNothing({ target: users.phone });
await db.update(users).set({ isAdmin: true, isSuperAdmin: true }).where(eq(users.phone, phone));
console.log(`${phone} is now a super admin. Sign in with that number to open /admin.`);
await pool.end();
