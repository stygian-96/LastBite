import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { drops, orders, users } from '../../db/schema.js';
import { parseInput } from '../../lib/errors.js';
import { serviceDate } from '../../lib/time.js';
import { NO_SHOW_GRACE_MINUTES, requirePickupStaff } from './collect.js';

/** What staff see of an order. The customer is a first name and a last initial, never a phone number. */
export type VendorOrderRow = {
  id: string;
  number: string;
  status: string;
  customerLabel: string;
  dropName: string;
  pricePaise: number;
  pickupStartAt: string;
  pickupEndAt: string;
  collectedAt: string | null;
};

const querySchema = z.object({
  date: z.iso.date().optional(),
  q: z.string().max(100).optional(),
});

/** "Asha Devi Kumar" becomes "Asha K."; a single name stands alone, and no name becomes "Customer". */
export function customerLabel(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Customer';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]!} ${[...parts[parts.length - 1]!][0]!.toUpperCase()}.`;
}

/**
 * An outlet's orders for one IST date. Without a date it is today, plus any drop still inside pickup
 * end + 30 minutes, so a window past midnight stays on the list. `q` matches the customer's name.
 */
export async function listOutletOrders(
  userId: string,
  outletId: string,
  query: { date?: string; q?: string },
  now: Date,
): Promise<VendorOrderRow[]> {
  const { date, q } = parseInput(querySchema, query);
  await requirePickupStaff(userId, outletId);

  const day: SQL = date
    ? eq(orders.serviceDate, date)
    : or(
        eq(orders.serviceDate, serviceDate(now)),
        sql`${drops.pickupEndAt} + make_interval(mins => ${NO_SHOW_GRACE_MINUTES}) > ${now.toISOString()}::timestamptz`,
      )!;
  const filters = [eq(orders.outletId, outletId), inArray(orders.status, ['paid', 'collected', 'no_show']), day];
  const needle = q?.trim();
  if (needle) {
    const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
    filters.push(sql`${users.name} ilike ${`%${escaped}%`}`);
  }

  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      name: users.name,
      dropName: drops.name,
      pricePaise: orders.pricePaise,
      pickupStartAt: drops.pickupStartAt,
      pickupEndAt: drops.pickupEndAt,
      collectedAt: orders.collectedAt,
    })
    .from(orders)
    .innerJoin(drops, eq(drops.id, orders.dropId))
    .leftJoin(users, eq(users.id, orders.userId))
    .where(and(...filters))
    .orderBy(asc(drops.pickupEndAt), asc(orders.number));
  return rows.map(({ name, number, ...r }) => ({
    ...r,
    number: `SJ-${number.toString()}`,
    customerLabel: customerLabel(name),
  }));
}
