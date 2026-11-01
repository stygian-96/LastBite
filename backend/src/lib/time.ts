// India has no DST, so IST is a fixed +05:30 offset.
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const SALES_CUTOFF_MS = 15 * 60_000;

/** The IST calendar date (YYYY-MM-DD) of an instant. */
export function serviceDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+05:30`);
}

/**
 * Pickup window for a drop on an IST date. An end time at or before the start
 * means the window runs past midnight into the next day.
 */
export function pickupBounds(
  date: string,
  start: string,
  end: string,
): { startAt: Date; endAt: Date; salesEndAt: Date } {
  const startAt = istInstant(date, start);
  let endAt = istInstant(date, end);
  if (endAt.getTime() <= startAt.getTime()) endAt = new Date(endAt.getTime() + DAY_MS);
  return { startAt, endAt, salesEndAt: new Date(endAt.getTime() - SALES_CUTOFF_MS) };
}

/** Minutes since midnight IST. */
export function istMinuteOfDay(at: Date): number {
  return Math.floor((((at.getTime() + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
}

/** The date n days after an IST date (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 1 = Monday to 7 = Sunday, as listings.repeat_days counts. */
export function isoWeekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}
