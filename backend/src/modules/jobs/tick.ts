import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db, pool } from '../../db/client.js';
import { jobRuns, notifications, otpCodes, rateLimits, sessions } from '../../db/schema.js';
import { addDays, istMinuteOfDay, isoWeekday, serviceDate } from '../../lib/time.js';
import { checkLicences, queueDailyPrompts, queuePickupReminders } from '../notifications/scheduled.js';
import { sendPending } from '../notifications/send.js';
import { expireHolds } from '../orders/expire.js';
import { reconcilePayments } from '../payments/reconcile.js';
import { buildPayouts } from '../payouts/build.js';
import { createTransfers, syncLinkedAccounts } from '../payouts/transfers.js';
import { autoMarkNoShows } from '../pickup/no-show.js';
import { processRefunds } from '../refunds/process.js';

/** The advisory lock one tick holds. The migrations use 727001. */
export const TICK_LOCK = 727002;

const DAY_MS = 86_400_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const PROMPT_FROM_MINUTE = 17 * 60;
const LICENCE_FROM_MINUTE = 10 * 60;
const WINDOW_MINUTES = 15;
// Late enough that Sunday's pickups running past midnight are over and marked.
const PAYOUT_BUILD_TIME = '06:00:00';
const NOTIFICATION_KEEP_DAYS = 90;

export type TickResult = {
  /** Another tick held the lock, so this one did nothing. */
  skipped: boolean;
  /** What each job that ran reported, in the order they ran. */
  ran: Record<string, number>;
  failed: { job: string; error: string }[];
};

/** Removes what only ever needed to live a while. Returns how many rows went. */
export async function cleanup(now: Date): Promise<number> {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const removed = await Promise.all([
    db
      .delete(otpCodes)
      .where(and(lt(otpCodes.createdAt, dayAgo), or(isNotNull(otpCodes.usedAt), lt(otpCodes.expiresAt, nowIso))))
      .returning({ id: otpCodes.id }),
    db.delete(sessions).where(lt(sessions.expiresAt, nowIso)).returning({ id: sessions.id }),
    db.delete(rateLimits).where(lt(rateLimits.windowStart, dayAgo)).returning({ key: rateLimits.key }),
    db
      .delete(notifications)
      .where(
        and(
          eq(notifications.status, 'sent'),
          lt(notifications.createdAt, new Date(now.getTime() - NOTIFICATION_KEEP_DAYS * DAY_MS).toISOString()),
        ),
      )
      .returning({ id: notifications.id }),
  ]);
  return removed.reduce((total, rows) => total + rows.length, 0);
}

type Due = (lastRun: Date | null, now: Date) => boolean;

const everyMinute: Due = () => true;

/** By five-minute slots of the clock, so ticks a few seconds apart do not push a run back a minute. */
const everyFiveMinutes: Due = (lastRun, now) =>
  !lastRun || Math.floor(lastRun.getTime() / FIVE_MINUTES_MS) < Math.floor(now.getTime() / FIVE_MINUTES_MS);

const daily: Due = (lastRun, now) => !lastRun || serviceDate(lastRun) < serviceDate(now);

/** Once a day, in the 15 minutes from this time of day (IST), so a late tick does nothing. */
const dailyFrom =
  (fromMinute: number): Due =>
  (lastRun, now) => {
    const minute = istMinuteOfDay(now);
    return minute >= fromMinute && minute < fromMinute + WINDOW_MINUTES && daily(lastRun, now);
  };

/** The IST date of the Monday of the week an instant falls in. */
function mondayOf(now: Date): string {
  const today = serviceDate(now);
  return addDays(today, 1 - isoWeekday(today));
}

/** Once a week from Monday morning. A tick that only comes later in the week still builds it. */
const weeklyFromMondayMorning: Due = (lastRun, now) => {
  const opens = new Date(`${mondayOf(now)}T${PAYOUT_BUILD_TIME}+05:30`);
  return now >= opens && (!lastRun || lastRun < opens);
};

type Job = { name: string; due: Due; run: (now: Date) => Promise<number> };

const JOBS: Job[] = [
  // First, so a hold whose payment came through is settled before it can expire.
  { name: 'reconcilePayments', due: everyMinute, run: reconcilePayments },
  { name: 'expireHolds', due: everyMinute, run: expireHolds },
  { name: 'sendPending', due: everyMinute, run: sendPending },
  { name: 'processRefunds', due: everyMinute, run: processRefunds },
  { name: 'queuePickupReminders', due: everyMinute, run: queuePickupReminders },
  { name: 'createTransfers', due: everyMinute, run: createTransfers },
  { name: 'syncLinkedAccounts', due: everyMinute, run: syncLinkedAccounts },
  { name: 'autoMarkNoShows', due: everyFiveMinutes, run: autoMarkNoShows },
  { name: 'queueDailyPrompts', due: dailyFrom(PROMPT_FROM_MINUTE), run: queueDailyPrompts },
  { name: 'checkLicences', due: dailyFrom(LICENCE_FROM_MINUTE), run: checkLicences },
  { name: 'cleanup', due: daily, run: cleanup },
  {
    name: 'buildPayouts',
    due: weeklyFromMondayMorning,
    run: async (now) => (await buildPayouts(addDays(mondayOf(now), -7), now)).length,
  },
];

async function runDueJobs(now: Date): Promise<TickResult> {
  const rows = await db.select().from(jobRuns);
  const lastRuns = new Map(rows.map((r) => [r.name, new Date(r.lastRunAt)]));
  const result: TickResult = { skipped: false, ran: {}, failed: [] };

  for (const job of JOBS) {
    if (!job.due(lastRuns.get(job.name) ?? null, now)) continue;
    try {
      const count = await job.run(now);
      const lastRunAt = now.toISOString();
      await db
        .insert(jobRuns)
        .values({ name: job.name, lastRunAt })
        .onConflictDoUpdate({ target: jobRuns.name, set: { lastRunAt: sql`excluded.last_run_at` } });
      result.ran[job.name] = count;
    } catch (e) {
      console.error(`Job ${job.name} failed`, e);
      result.failed.push({ job: job.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * One run of everything due. Only one tick runs at a time, across every process: the lock belongs to
 * a database session, so this one connection holds it from start to finish, which a transaction
 * pooler would not allow. A job that fails is left unstamped, for the next tick, and does not stop
 * the rest. The connection is closed at the end, which frees the lock even if the unlock failed.
 */
export async function runTick(now: Date): Promise<TickResult> {
  const client = await pool.connect();
  // A connection lost mid-tick emits this, and with no listener it would take the process down.
  const onError = (e: Error) => console.error('The tick lost its database connection', e);
  client.on('error', onError);
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [TICK_LOCK]);
    if (!rows[0]?.locked) return { skipped: true, ran: {}, failed: [] };
    try {
      return await runDueJobs(now);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [TICK_LOCK])
        .catch((e: unknown) => console.error('Could not release the tick lock', e));
    }
  } finally {
    client.removeListener('error', onError);
    client.release(true);
  }
}
