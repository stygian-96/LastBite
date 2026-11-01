import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions, users } from '../../db/schema.js';
import { hashToken } from '../../lib/crypto.js';

export const SESSION_MAX_AGE_SECONDS = 30 * 86_400;

export type SessionUser = { id: string; phone: string; name: string | null; isAdmin: boolean };

/** Creates a session and returns the raw token. Only its hash is stored. */
export async function createSession(userId: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
  });
  return token;
}

/** The signed-in user for a session token, or null when it is unknown, expired or the user was deleted. */
export async function getSessionUser(token: string, now: Date): Promise<SessionUser | null> {
  const [row] = await db
    .select({ id: users.id, phone: users.phone, name: users.name, isAdmin: users.isAdmin })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, now.toISOString()),
        isNull(users.deletedAt),
      ),
    );
  return row ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
