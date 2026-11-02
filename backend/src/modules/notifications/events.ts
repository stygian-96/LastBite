import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { toIso as iso } from '../../lib/time.js';
import type { Tx } from '../../db/client.js';
import { areas, brands, drops, follows, memberships, orders, outlets, payments, refunds, users } from '../../db/schema.js';
import { env } from '../../lib/env.js';
import { enqueueMany, type NewNotification } from './enqueue.js';
import type { TemplateName, Vars } from './templates.js';

// What happens in the app becomes a queued message here. Each function runs inside the transaction
// that made the change, reads what the copy needs, and queues rows under a dedupe key.

export const origin = () => env().FRONTEND_ORIGIN.replace(/\/$/, '');
export const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || 'there';
const SHORT_ADDRESS = 40;

type Recipient = { userId: string; phone: string; name: string | null };
type OutletRef = { id: string; brandId: string };

export type OutletInfo = { vendor: string; business: string; area: string; address: string };

/** How an outlet is named in copy, and where it is. */
export async function outletInfo(tx: Tx, outletId: string): Promise<OutletInfo> {
  const [o] = await tx
    .select({ brandName: brands.name, branchName: outlets.branchName, address: outlets.address, area: areas.name })
    .from(outlets)
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .leftJoin(areas, eq(areas.id, outlets.areaId))
    .where(eq(outlets.id, outletId));
  if (!o) throw new Error(`Outlet ${outletId} not found`);
  const name = `${o.brandName} ${o.branchName}`;
  return {
    vendor: name,
    business: name,
    area: o.area ?? '',
    address: [o.address, o.area].filter(Boolean).join(', ').slice(0, SHORT_ADDRESS),
  };
}

/**
 * Active staff in the given roles. A membership with no outlet covers the whole brand, as in
 * requireOutlet. Deleted users are left out. A person with two memberships appears once.
 */
export async function staffOf(tx: Tx, list: OutletRef[], roles: ('owner' | 'manager')[]): Promise<Map<string, Recipient[]>> {
  const out = new Map<string, Recipient[]>();
  if (list.length === 0) return out;
  const rows = await tx
    .select({
      userId: users.id,
      phone: users.phone,
      name: users.name,
      brandId: memberships.brandId,
      outletId: memberships.outletId,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        inArray(memberships.brandId, [...new Set(list.map((o) => o.brandId))]),
        inArray(memberships.role, roles),
        isNull(memberships.removedAt),
        isNull(users.deletedAt),
      ),
    );
  for (const o of list) {
    const seen = new Set<string>();
    const mine: Recipient[] = [];
    for (const r of rows) {
      if (r.brandId !== o.brandId || (r.outletId !== null && r.outletId !== o.id) || seen.has(r.userId)) continue;
      seen.add(r.userId);
      mine.push({ userId: r.userId, phone: r.phone, name: r.name });
    }
    out.set(o.id, mine);
  }
  return out;
}

// ---------- Customer orders ----------

type OrderContext = {
  orderId: string;
  code: string | null;
  pricePaise: number;
  phone: string;
  name: string;
  item: string;
  startAt: string;
  endAt: string;
  vendor: string;
  address: string;
};

/** The order with what its messages need. Null for an order with no signed-in customer, who has no phone on file. */
async function orderContext(tx: Tx, orderId: string): Promise<OrderContext | null> {
  const [r] = await tx
    .select({
      orderId: orders.id,
      code: orders.pickupCode,
      pricePaise: orders.pricePaise,
      phone: users.phone,
      userName: users.name,
      item: drops.name,
      startAt: drops.pickupStartAt,
      endAt: drops.pickupEndAt,
      outletId: orders.outletId,
    })
    .from(orders)
    .innerJoin(drops, eq(drops.id, orders.dropId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!r) return null;
  const outlet = await outletInfo(tx, r.outletId);
  return {
    orderId: r.orderId,
    code: r.code,
    pricePaise: r.pricePaise,
    phone: r.phone,
    name: firstName(r.userName),
    item: r.item,
    startAt: iso(r.startAt),
    endAt: iso(r.endAt),
    vendor: outlet.vendor,
    address: outlet.address,
  };
}

/** The order is paid and has its pickup code. */
export async function queueOrderConfirmed(tx: Tx, orderId: string): Promise<void> {
  const o = await orderContext(tx, orderId);
  if (!o) return;
  await enqueueMany(tx, [
    {
      dedupeKey: `confirm:${o.orderId}`,
      phone: o.phone,
      template: 'order_confirmed',
      variables: {
        name: o.name,
        item: o.item,
        vendor: o.vendor,
        pickupStartAt: o.startAt,
        pickupEndAt: o.endAt,
        code: o.code ?? '',
        link: `${origin()}/o/${o.orderId}`,
      },
    },
  ]);
}

/** A payment arrived after its bag was gone and is being refunded. */
export async function queueLatePaymentRefunded(tx: Tx, orderId: string, paymentId: string, amountPaise: number): Promise<void> {
  const o = await orderContext(tx, orderId);
  if (!o) return;
  await enqueueMany(tx, [
    {
      dedupeKey: `late:${paymentId}`,
      phone: o.phone,
      template: 'late_payment_refunded',
      variables: { name: o.name, vendor: o.vendor, amountPaise },
    },
  ]);
}

const CANCEL_REASONS: Record<string, string> = {
  ran_out: 'they ran out',
  quality: 'a quality problem',
  closing_early: 'they are closing early',
};

/** `refundPaise` is what is still to be refunded: nothing if an admin already refunded it all. */
export async function queueVendorCancelled(tx: Tx, orderId: string, reason: string, refundPaise: number): Promise<void> {
  const o = await orderContext(tx, orderId);
  if (!o) return;
  await enqueueMany(tx, [
    {
      dedupeKey: `cancel:${o.orderId}`,
      phone: o.phone,
      template: 'vendor_cancelled',
      variables: {
        name: o.name,
        vendor: o.vendor,
        reason: CANCEL_REASONS[reason] ?? 'a problem at their end',
        amountPaise: Math.max(refundPaise, 0),
      },
    },
  ]);
}

/** The refund has reached processed. */
export async function queueRefundIssued(tx: Tx, refundId: string): Promise<void> {
  const [r] = await tx
    .select({
      id: refunds.id,
      amountPaise: refunds.amountPaise,
      method: payments.method,
      phone: users.phone,
      userName: users.name,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(refunds.id, refundId));
  if (!r) return;
  await enqueueMany(tx, [
    {
      dedupeKey: `refund:${r.id}`,
      phone: r.phone,
      template: 'refund_issued',
      variables: {
        name: firstName(r.userName),
        amountPaise: r.amountPaise,
        method: r.method ?? '',
        ref: `RF-${r.id.slice(0, 8).toUpperCase()}`,
      },
    },
  ]);
}

// ---------- Vendors ----------

/**
 * Tells an outlet's owners their application was approved or sent back. `eventKey` tells one
 * decision from another, since an outlet can be sent back more than once.
 */
export async function queueApplicationNotice(
  tx: Tx,
  outletId: string,
  template: 'application_approved' | 'changes_needed',
  eventKey: string,
  reason?: string,
): Promise<void> {
  const [outlet] = await tx.select({ id: outlets.id, brandId: outlets.brandId }).from(outlets).where(eq(outlets.id, outletId));
  if (!outlet) return;
  const info = await outletInfo(tx, outletId);
  const owners = (await staffOf(tx, [outlet], ['owner'])).get(outletId) ?? [];
  const prefix = template === 'application_approved' ? 'approved' : 'changes';
  await enqueueMany(
    tx,
    owners.map((owner) => ({
      dedupeKey: `${prefix}:${outletId}:${eventKey}:${owner.userId}`,
      phone: owner.phone,
      template,
      variables: {
        owner: firstName(owner.name),
        business: info.business,
        area: info.area,
        reason: reason ?? '',
        link: `${origin()}/p`,
      },
    })),
  );
}

// ---------- Followers ----------

/** Followers of an outlet who are still users, with the phone each can be reached on. */
async function followersOf(tx: Tx, outletId: string): Promise<Recipient[]> {
  return tx
    .select({ userId: users.id, phone: users.phone, name: users.name })
    .from(follows)
    .innerJoin(users, eq(users.id, follows.userId))
    .where(and(eq(follows.outletId, outletId), isNull(users.deletedAt)));
}

/** The outlet is closed for good. One message to each follower. */
export async function queueOutletClosed(tx: Tx, outletId: string): Promise<void> {
  const info = await outletInfo(tx, outletId);
  const followers = await followersOf(tx, outletId);
  await enqueueMany(
    tx,
    followers.map((f) => ({
      dedupeKey: `closed:${f.userId}:${outletId}`,
      phone: f.phone,
      template: 'outlet_closed',
      variables: { name: firstName(f.name), vendor: info.vendor },
    })),
  );
}

type NewDrop = Pick<
  typeof drops.$inferSelect,
  'id' | 'outletId' | 'serviceDate' | 'pricePaise' | 'pickupStartAt' | 'pickupEndAt'
>;

/**
 * A drop was just created. If it is the outlet's first of that service date, followers who accept
 * hear of it: they asked for it by following. A second drop that night finds the first and does nothing; two first drops
 * racing each other meet at the dedupe key, so a follower gets one message a night either way.
 */
export async function queueFollowerAlert(tx: Tx, drop: NewDrop): Promise<void> {
  const [earlier] = await tx
    .select({ id: drops.id })
    .from(drops)
    .where(and(eq(drops.outletId, drop.outletId), eq(drops.serviceDate, drop.serviceDate), ne(drops.id, drop.id)))
    .limit(1);
  if (earlier) return;

  const followers = await followersOf(tx, drop.outletId);
  if (followers.length === 0) return;
  const info = await outletInfo(tx, drop.outletId);
  const [page] = await tx
    .select({ city: areas.city, brand: brands.slug, outlet: outlets.slug })
    .from(outlets)
    .innerJoin(brands, eq(brands.id, outlets.brandId))
    .innerJoin(areas, eq(areas.id, outlets.areaId))
    .where(eq(outlets.id, drop.outletId));
  // Only an outlet with no area, which cannot go live, has no page to link to.
  if (!page) return;
  const link = `${origin()}/${page.city}/${page.brand}/${page.outlet}`;
  const vars: Vars = {
    vendor: info.vendor,
    pickupStartAt: iso(drop.pickupStartAt),
    pickupEndAt: iso(drop.pickupEndAt),
    fromPaise: drop.pricePaise,
    link,
  };
  await enqueueMany(
    tx,
    followers.map((f) => ({
      dedupeKey: `follow:${f.userId}:${drop.outletId}:${drop.serviceDate}`,
      phone: f.phone,
      template: 'followed_outlet_listed' as TemplateName,
      variables: { ...vars, name: firstName(f.name) },
    })) satisfies NewNotification[],
  );
}
