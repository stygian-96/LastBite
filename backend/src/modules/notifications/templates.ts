import { env } from '../../lib/env.js';

export type TemplateName =
  | 'order_confirmed'
  | 'pickup_reminder'
  | 'vendor_cancelled'
  | 'refund_issued'
  | 'late_payment_refunded'
  | 'application_approved'
  | 'changes_needed'
  | 'daily_prompt'
  | 'followed_outlet_listed'
  | 'licence_expiring'
  | 'outlet_closed';

/** What a message needs, stored with it. Times are ISO instants and money is paise: copy is made at send time. */
export type Vars = Record<string, string | number>;

type Template = {
  /** Vendor messages go to staff, who have no WhatsApp opt-out. */
  audience: 'customer' | 'vendor';
  /** Marketing needs `users.marketing_opt_in`. */
  marketing: boolean;
  /** Skips WhatsApp. */
  smsOnly?: boolean;
  whatsapp: (v: Vars) => string;
  /** ASCII only and under 160 characters, so it goes as one plain SMS. */
  sms: (v: Vars) => string;
};

const IST_OFFSET_MS = 330 * 60_000;

// ---------- Formatting ----------

const brand = () => env().BRAND_NAME;

/** Hour, minute and am/pm of an instant, in IST. */
function clock(iso: unknown): { h: number; m: number; ap: 'am' | 'pm' } {
  const d = new Date(new Date(String(iso)).getTime() + IST_OFFSET_MS);
  const hours = d.getUTCHours();
  return { h: hours % 12 || 12, m: d.getUTCMinutes(), ap: hours < 12 ? 'am' : 'pm' };
}

const hm = (c: { h: number; m: number }) => (c.m === 0 ? `${c.h}` : `${c.h}:${String(c.m).padStart(2, '0')}`);

/** "8:30pm" for SMS, "8:30 pm" for WhatsApp. */
const time = (iso: unknown, space: boolean) => {
  const c = clock(iso);
  return `${hm(c)}${space ? ' ' : ''}${c.ap}`;
};

/** "8:30-9:30pm" for SMS, "8:30–9:30 pm" for WhatsApp. The am/pm is said once when both ends share it. */
function window(v: Vars, space: boolean): string {
  const a = clock(v.pickupStartAt);
  const b = clock(v.pickupEndAt);
  const sp = space ? ' ' : '';
  const dash = space ? '–' : '-';
  return a.ap === b.ap ? `${hm(a)}${dash}${hm(b)}${sp}${b.ap}` : `${hm(a)}${sp}${a.ap}${dash}${hm(b)}${sp}${b.ap}`;
}

/** Whole rupees, or rupees and paise. */
function rupees(paise: unknown): string {
  const p = Number(paise);
  return p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "28 Nov 2026" from YYYY-MM-DD. */
function day(ymd: unknown): string {
  const [y, m, d] = String(ymd).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const METHODS: Record<string, string> = { upi: 'UPI account', card: 'card', netbanking: 'bank account', wallet: 'wallet' };
const methodTo = (method: unknown) => {
  const label = METHODS[String(method)];
  return label ? ` to your ${label}` : '';
};

const s = (x: unknown) => String(x);

// ---------- Copy ----------

export const TEMPLATES: Record<TemplateName, Template> = {
  order_confirmed: {
    audience: 'customer',
    marketing: false,
    whatsapp: (v) =>
      `Hi ${s(v.name)}, you’re all set!\n\n${s(v.item)} from ${s(v.vendor)}\nPickup today, ${window(v, true)}\nYour code: *${s(v.code)}*\n\nShow this code at the counter. No delivery.`,
    sms: (v) =>
      `${brand()}: Order confirmed. ${s(v.vendor)}, today ${window(v, false)}. Pickup code ${s(v.code)}. Show it at the counter. ${s(v.link)}`,
  },
  pickup_reminder: {
    audience: 'customer',
    marketing: false,
    whatsapp: (v) =>
      `${s(v.name)}, your pickup opens at ${time(v.pickupStartAt, true)}.\n\n${s(v.vendor)}, ${s(v.address)}\nCode: *${s(v.code)}*\n\nMissed pickups can’t be refunded, so please go before ${time(v.pickupEndAt, true)}.`,
    sms: (v) =>
      `${brand()}: Pickup opens ${time(v.pickupStartAt, false)} at ${s(v.vendor)}, ${s(v.address)}. Code ${s(v.code)}. Collect by ${time(v.pickupEndAt, false)}; missed pickups are not refunded.`,
  },
  vendor_cancelled: {
    audience: 'customer',
    marketing: false,
    whatsapp: (v) =>
      `Sorry ${s(v.name)}, ${s(v.vendor)} had to cancel tonight’s order (${s(v.reason)}).\n\n` +
      (Number(v.amountPaise) > 0
        ? `Your refund of *₹${rupees(v.amountPaise)}* has started automatically. It usually reaches you in 5–7 working days. Nothing for you to do.`
        : 'Your payment has already been refunded. Nothing for you to do.'),
    sms: (v) =>
      `${brand()}: ${s(v.vendor)} cancelled your order. ` +
      (Number(v.amountPaise) > 0
        ? `Refund of Rs${rupees(v.amountPaise)} started automatically, usually 5-7 working days. Sorry about this.`
        : 'Your payment was already refunded. Sorry about this.'),
  },
  refund_issued: {
    audience: 'customer',
    marketing: false,
    whatsapp: (v) =>
      `${s(v.name)}, your refund of *₹${rupees(v.amountPaise)}* has been sent${methodTo(v.method)}.\n\nRefund ID: ${s(v.ref)}\nIf you don’t see it in 2 days, reply to this message.`,
    sms: (v) =>
      `${brand()}: Refund of Rs${rupees(v.amountPaise)} sent${methodTo(v.method)}. Ref ${s(v.ref)}. Not received in 2 days? Reply to this message.`,
  },
  late_payment_refunded: {
    audience: 'customer',
    marketing: false,
    whatsapp: (v) =>
      `${s(v.name)}, your payment of *₹${rupees(v.amountPaise)}* for ${s(v.vendor)} reached us after the bag was no longer available to you.\n\nA full refund has started automatically. It usually reaches you in 5–7 working days. Nothing for you to do.`,
    sms: (v) =>
      `${brand()}: Your Rs${rupees(v.amountPaise)} payment to ${s(v.vendor)} came in after the bag was gone. Full refund started, usually 5-7 working days.`,
  },
  application_approved: {
    audience: 'vendor',
    marketing: false,
    whatsapp: (v) =>
      `Congratulations ${s(v.owner)}! *${s(v.business)}* is now live on ${brand()}.\n\nCustomers near ${s(v.area)} can see you. Set tonight’s quantity to start selling.`,
    sms: (v) => `${brand()}: ${s(v.business)} is approved and live! Set tonight's quantity to start selling: ${s(v.link)}`,
  },
  changes_needed: {
    audience: 'vendor',
    marketing: false,
    whatsapp: (v) =>
      `Hi ${s(v.owner)}, we need a few changes before *${s(v.business)}* can go live on ${brand()}.\n\n` +
      (v.reason ? `${s(v.reason)}\n\n` : '') +
      'Open your application to fix them and send it back.',
    sms: (v) => `${brand()}: Changes needed before ${s(v.business)} can go live. See what to fix: ${s(v.link)}`,
  },
  daily_prompt: {
    audience: 'vendor',
    marketing: false,
    whatsapp: (v) =>
      `Good evening ${s(v.owner)}! How many tonight?\n\n${s(v.listings)}\n\nTap a button, or open the dashboard to set exact numbers.`,
    sms: (v) => `${brand()}: How many bags tonight? Set tonight's numbers at ${s(v.link)}`,
  },
  followed_outlet_listed: {
    audience: 'customer',
    // Not marketing: the customer asked for it by tapping Follow.
    marketing: false,
    whatsapp: (v) =>
      `${s(v.name)}, ${s(v.vendor)} just listed tonight’s bags.\n\nPickup ${window(v, true)}, from ₹${rupees(v.fromPaise)}\nQuantities are limited, so reserve soon if you want one.`,
    sms: (v) =>
      `${brand()}: ${s(v.vendor)} just listed tonight. Pickup ${window(v, false)}, from Rs${rupees(v.fromPaise)}. ${s(v.link)}`,
  },
  licence_expiring: {
    audience: 'vendor',
    marketing: false,
    whatsapp: (v) =>
      `Hi ${s(v.owner)}, the FSSAI licence for *${s(v.business)}* expires in ${s(v.days)} days (${day(v.expiresOn)}).\n\nUpload the renewed licence before then, or new listings will be blocked.`,
    sms: (v) =>
      `${brand()}: FSSAI licence for ${s(v.business)} expires in ${s(v.days)} days (${day(v.expiresOn)}). Upload the renewal: ${s(v.link)}`,
  },
  outlet_closed: {
    audience: 'customer',
    marketing: false,
    whatsapp: (v) =>
      `${s(v.name)}, ${s(v.vendor)} has closed on ${brand()}.\n\nYou won’t see their bags any more. Thanks for following them.`,
    sms: (v) => `${brand()}: ${s(v.vendor)} has closed and will not list any more bags. Thanks for following.`,
  },
};

/** One SMS segment is 160 characters. */
const SMS_LIMIT = 159;
/** Free text that may be shortened to fit an SMS, in the order it is shortened. Codes, links, times and amounts never are. */
const TRIMMABLE = ['vendor', 'business', 'address', 'item', 'reason', 'area', 'name', 'owner'];
const MIN_KEPT = 8;

function fitSms(template: TemplateName, variables: Vars): string {
  let text = TEMPLATES[template].sms(variables);
  const v: Vars = { ...variables };
  for (const key of TRIMMABLE) {
    const excess = text.length - SMS_LIMIT;
    if (excess <= 0) break;
    const value = v[key];
    if (typeof value !== 'string') continue;
    const keep = Math.max(value.length - excess, MIN_KEPT);
    if (keep >= value.length) continue;
    v[key] = `${value.slice(0, keep - 3).trimEnd()}...`;
    text = TEMPLATES[template].sms(v);
  }
  return text;
}

/** The text of a message for a channel. An SMS has its vendor, address and similar names shortened to fit. */
export function renderMessage(template: TemplateName, channel: 'whatsapp' | 'sms', variables: Vars): string {
  return channel === 'sms' ? fitSms(template, variables) : TEMPLATES[template].whatsapp(variables);
}
