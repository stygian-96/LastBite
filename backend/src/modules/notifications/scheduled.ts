import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTx } from '../../db/client.js';
import { drops, listings, orders, outlets, users } from '../../db/schema.js';
import { addDays, isoWeekday, istMinuteOfDay, serviceDate } from '../../lib/time.js';
import { enqueueMany, type NewNotification } from './enqueue.js';
import { firstName, origin, outletInfo, staffOf } from './events.js';

const REMINDER_LEAD_MS = 30 * 60_000;
/** The daily prompt goes out in the first 15 minutes of 5:00 pm IST. */
const PROMPT_FROM_MINUTE = 17 * 60;
const PROMPT_WINDOW_MINUTES = 15;
/** Days before expiry that a licence warning goes out. */
const LICENCE_WARNINGS = [30, 7];

const iso = (at: string) => new Date(at).toISOString();

/**
 * Queues a reminder for each paid order whose pickup opens within 30 minutes and has not opened.
 * Safe to run every minute: the dedupe key keeps it to one. Returns how many it queued.
 */
export function queuePickupReminders(now: Date): Promise<number> {
  const from = now.toISOString();
  const until = new Date(now.getTime() + REMINDER_LEAD_MS).toISOString();
  return withTx(async (tx) => {
    const rows = await tx
      .select({
        orderId: orders.id,
        code: orders.pickupCode,
        outletId: orders.outletId,
        startAt: drops.pickupStartAt,
        endAt: drops.pickupEndAt,
        phone: users.phone,
        userName: users.name,
      })
      .from(orders)
      .innerJoin(drops, eq(drops.id, orders.dropId))
      .innerJoin(users, eq(users.id, orders.userId))
      .where(and(eq(orders.status, 'paid'), gt(drops.pickupStartAt, from), lte(drops.pickupStartAt, until)));

    const infos = new Map<string, Awaited<ReturnType<typeof outletInfo>>>();
    const list: NewNotification[] = [];
    for (const r of rows) {
      let info = infos.get(r.outletId);
      if (!info) infos.set(r.outletId, (info = await outletInfo(tx, r.outletId)));
      list.push({
        dedupeKey: `reminder:${r.orderId}`,
        phone: r.phone,
        template: 'pickup_reminder',
        variables: {
          name: firstName(r.userName),
          vendor: info.vendor,
          address: info.address,
          code: r.code ?? '',
          pickupStartAt: iso(r.startAt),
          pickupEndAt: iso(r.endAt),
        },
      });
    }
    return enqueueMany(tx, list);
  });
}

/**
 * Asks the owners and managers of live, unpaused outlets how many bags tonight, if one of the
 * outlet's listings repeats today (1 = Monday). Only in the first 15 minutes of 5:00 pm IST, so a
 * late tick sends nothing. Returns how many it queued.
 */
export function queueDailyPrompts(now: Date): Promise<number> {
  const minute = istMinuteOfDay(now);
  if (minute < PROMPT_FROM_MINUTE || minute >= PROMPT_FROM_MINUTE + PROMPT_WINDOW_MINUTES) return Promise.resolve(0);
  const date = serviceDate(now);
  const weekday = isoWeekday(date);

  return withTx(async (tx) => {
    const rows = await tx
      .select({
        outletId: outlets.id,
        brandId: outlets.brandId,
        name: listings.name,
        defaultQuantity: listings.defaultQuantity,
      })
      .from(listings)
      .innerJoin(outlets, eq(outlets.id, listings.outletId))
      .where(
        and(
          eq(outlets.status, 'live'),
          or(isNull(outlets.pausedUntil), lte(outlets.pausedUntil, now.toISOString())),
          // As publishDrop has it: a licence that expires today is still valid today.
          or(isNull(outlets.fssaiExpiresOn), gte(outlets.fssaiExpiresOn, date)),
          isNull(listings.archivedAt),
          sql`${weekday}::smallint = ANY(${listings.repeatDays})`,
        ),
      )
      .orderBy(asc(listings.createdAt), asc(listings.id));

    const byOutlet = new Map<string, { id: string; brandId: string; lines: string[] }>();
    for (const r of rows) {
      const entry = byOutlet.get(r.outletId) ?? { id: r.outletId, brandId: r.brandId, lines: [] };
      entry.lines.push(`${r.name} (usual ${r.defaultQuantity})`);
      byOutlet.set(r.outletId, entry);
    }
    const found = [...byOutlet.values()];
    const staff = await staffOf(tx, found, ['owner', 'manager']);

    const list: NewNotification[] = [];
    for (const o of found) {
      const info = await outletInfo(tx, o.id);
      for (const person of staff.get(o.id) ?? []) {
        list.push({
          dedupeKey: `prompt:${o.id}:${person.phone}:${date}`,
          phone: person.phone,
          template: 'daily_prompt',
          variables: {
            owner: firstName(person.name),
            business: info.business,
            listings: o.lines.join('\n'),
            outletId: o.id,
            date,
            // The payload on the "Same as usual" button, as handleWhatsAppWebhook reads it.
            samePayload: `same_as_usual:${o.id}:${date}`,
            link: `${origin()}/p`,
          },
        });
      }
    }
    return enqueueMany(tx, list);
  });
}

/**
 * Warns the owners of live outlets whose FSSAI licence expires in exactly 30 or 7 days (IST).
 * The key carries the expiry date, so a renewed licence is warned about again next year, and each
 * owner has their own. Returns how many it queued.
 */
export function checkLicences(now: Date): Promise<number> {
  const today = serviceDate(now);
  const targets = LICENCE_WARNINGS.map((days) => ({ days, on: addDays(today, days) }));
  return withTx(async (tx) => {
    const due = await tx
      .select({ id: outlets.id, brandId: outlets.brandId, expiresOn: outlets.fssaiExpiresOn })
      .from(outlets)
      .where(
        and(
          eq(outlets.status, 'live'),
          inArray(
            outlets.fssaiExpiresOn,
            targets.map((t) => t.on),
          ),
        ),
      );
    if (due.length === 0) return 0;
    const owners = await staffOf(tx, due, ['owner']);

    const list: NewNotification[] = [];
    for (const o of due) {
      const days = targets.find((t) => t.on === o.expiresOn)!.days;
      const info = await outletInfo(tx, o.id);
      for (const owner of owners.get(o.id) ?? []) {
        list.push({
          dedupeKey: `licence:${o.id}:${days}:${o.expiresOn}:${owner.userId}`,
          phone: owner.phone,
          template: 'licence_expiring',
          variables: {
            owner: firstName(owner.name),
            business: info.business,
            days,
            expiresOn: o.expiresOn!,
            link: `${origin()}/p`,
          },
        });
      }
    }
    return enqueueMany(tx, list);
  });
}
