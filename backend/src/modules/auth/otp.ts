import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { otpCodes, users } from '../../db/schema.js';
import { env } from '../../lib/env.js';
import { ApiError } from '../../lib/errors.js';
import { rateLimit } from '../../lib/rate-limit.js';
import { getMessenger } from '../../integrations/messaging.js';
import { createSession } from './session.js';

const OTP_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

const invalid = () => new ApiError('otp_invalid', 401, 'That code is not valid');

/** E.164 with +91. Accepts 10 digits, 0/91 prefixes and +91, ignoring spaces and dashes. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  const national = /^\d{10}$/.test(digits)
    ? digits
    : /^0\d{10}$/.test(digits)
      ? digits.slice(1)
      : /^91\d{10}$/.test(digits)
        ? digits.slice(2)
        : null;
  return national && /^[6-9]/.test(national) ? `+91${national}` : null;
}

function hashCode(phone: string, code: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(`${phone}:${code}`).digest('hex');
}

export async function sendOtp(phone: string, ip: string, now: Date): Promise<void> {
  const e164 = normalizePhone(phone);
  if (!e164) throw new ApiError('invalid_phone', 400, 'Enter a valid mobile number');

  await rateLimit(`otp:ip:${ip || 'unknown'}`, 20, 3600, now);
  await rateLimit(`otp:phone:${e164}`, 3, 600, now);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.insert(otpCodes).values({
    phone: e164,
    codeHash: hashCode(e164, code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  });
  // Sent directly, not through the queue: an OTP must not wait for a tick.
  await getMessenger().send({ phone: e164, channel: 'sms', template: 'otp', variables: { code } });
}

export async function verifyOtp(phone: string, code: string, now: Date) {
  const e164 = normalizePhone(phone);
  if (!e164) throw invalid();
  const nowIso = now.toISOString();

  // Only the newest code counts. Taking an attempt is one atomic statement,
  // so concurrent guesses cannot exceed the limit.
  const latest = db
    .select({ id: otpCodes.id })
    .from(otpCodes)
    .where(eq(otpCodes.phone, e164))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  const [attempt] = await db
    .update(otpCodes)
    .set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(
      and(
        sql`${otpCodes.id} = (${latest})`,
        isNull(otpCodes.usedAt),
        gt(otpCodes.expiresAt, nowIso),
        lt(otpCodes.attempts, MAX_ATTEMPTS),
      ),
    )
    .returning({ id: otpCodes.id, codeHash: otpCodes.codeHash });
  if (!attempt) throw invalid();

  const given = Buffer.from(hashCode(e164, code));
  const stored = Buffer.from(attempt.codeHash);
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw invalid();

  // Single use: only one concurrent request can flip used_at.
  const [used] = await db
    .update(otpCodes)
    .set({ usedAt: nowIso })
    .where(and(eq(otpCodes.id, attempt.id), isNull(otpCodes.usedAt)))
    .returning({ id: otpCodes.id });
  if (!used) throw invalid();

  await db.insert(users).values({ phone: e164 }).onConflictDoNothing({ target: users.phone });
  const [user] = await db.select().from(users).where(eq(users.phone, e164));
  if (!user || user.deletedAt) throw invalid();

  const token = await createSession(user.id, now);
  return { user, token };
}
