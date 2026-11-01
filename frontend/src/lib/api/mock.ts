// In-browser stand-in for the backend, on when NEXT_PUBLIC_API_MOCK=1.
// State lives in localStorage so a refresh keeps your hold and orders.
// Sign in with any 10-digit number and any 6-digit code except 000000.
// A number starting 90000 is a brand new customer with no name saved.

import { HOLD_SECONDS } from "@/config/brand";
import { istDay } from "@/lib/format";
import { readJson, writeJson } from "@/lib/storage";
import type { Api } from "./client";
import { ApiError } from "./errors";
import type { CityId, Drop, DropDetail, Me, Order, OutletPickupInfo } from "./types";

const KEY = "lb_mock_v1";
const LATENCY_MS = 200;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type OutletRow = OutletPickupInfo & { opening_hours_today: string | null };
type DropRow = Omit<Drop, "outlet"> & { outlet_id: string; loses_race?: boolean };
type OrderRow = Omit<Order, "outlet"> & { outlet_id: string; mine: boolean };

type Db = {
  day: string;
  outlets: OutletRow[];
  drops: DropRow[];
  orders: OrderRow[];
  me: Me | null;
  following: string[];
  nextNumber: number;
};

const CITIES = [
  {
    id: "bengaluru" as const,
    name: "Bengaluru",
    areas: ["Indiranagar", "Koramangala", "HSR Layout", "Jayanagar", "Malleshwaram", "Whitefield"],
  },
  {
    id: "hyderabad" as const,
    name: "Hyderabad",
    areas: ["Banjara Hills", "Jubilee Hills", "Madhapur", "Gachibowli", "Kondapur"],
  },
];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function outlet(
  city: CityId,
  area: string,
  brand: string,
  category: OutletRow["category"],
  address: string,
  pincode: string,
  rating: [number | null, number],
  extra: Partial<OutletRow> = {},
): OutletRow {
  return {
    id: `${slug(brand)}-${slug(area)}`,
    brand_name: brand,
    brand_slug: slug(brand),
    branch_name: area,
    slug: slug(area),
    city,
    area_name: area,
    category,
    rating_avg: rating[0],
    rating_count: rating[1],
    address,
    pincode,
    maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${brand} ${area}`)}`,
    pickup_instructions: "Show your code at the counter.",
    fssai_number: "1122 4999 0001 23",
    opening_hours_today: "9am–10pm",
    ...extra,
  };
}

const OUTLETS: OutletRow[] = [
  outlet("bengaluru", "Indiranagar", "Butterfold Bakehouse", "bakery", "14, 12th Main, HAL 2nd Stage, Indiranagar, Bengaluru", "560038", [4.6, 212], {
    pickup_instructions: "Side counter on the left. Show your code, no need to queue.",
    opening_hours_today: "8am–10pm",
  }),
  outlet("bengaluru", "Indiranagar", "Smoke & Salt Grill", "restaurant", "221, Double Road, Indiranagar, Bengaluru", "560038", [4.3, 88]),
  outlet("bengaluru", "Indiranagar", "Chai Patti House", "cafe", "9, CMH Road, Indiranagar, Bengaluru", "560038", [4.4, 131]),
  outlet("bengaluru", "Koramangala", "Kaapi Corner", "cafe", "48, 5th Block, Koramangala, Bengaluru", "560095", [4.5, 176]),
  outlet("bengaluru", "Malleshwaram", "Udupi Tiffin Room", "restaurant", "3, Sampige Road, Malleshwaram, Bengaluru", "560003", [4.7, 305]),
  outlet("bengaluru", "HSR Layout", "Little Lamington", "sweets", "17, Sector 3, HSR Layout, Bengaluru", "560102", [4.8, 97]),
  outlet("bengaluru", "Jayanagar", "Ragi & Rye", "bakery", "62, 4th Block, Jayanagar, Bengaluru", "560011", [null, 0]),
  outlet("hyderabad", "Banjara Hills", "Irani Chai Stop", "cafe", "8-2, Road No 1, Banjara Hills, Hyderabad", "500034", [4.5, 64]),
  outlet("hyderabad", "Madhapur", "Deccan Bakes", "bakery", "12, Ayyappa Society, Madhapur, Hyderabad", "500081", [4.2, 41]),
  outlet("hyderabad", "Gachibowli", "Nawab’s Kitchen", "kitchen", "5, DLF Road, Gachibowli, Hyderabad", "500032", [4.4, 120]),
];

function photo(top: string, bottom: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 390 380'><defs><linearGradient id='g' x2='1' y2='1'><stop stop-color='${top}'/><stop offset='1' stop-color='${bottom}'/></linearGradient></defs><rect width='390' height='380' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const MORE_ALLERGENS = ["gluten", "dairy", "nuts", "sesame"];

type SeedDrop = Partial<DropRow> &
  Pick<DropRow, "name" | "description" | "food_category" | "diet"> & {
    outlet_id: string;
    rupees: number;
    was: number;
    left: number;
    of: number;
    start: number;
    minutes: number;
  };

const SEED_DROPS: SeedDrop[] = [
  {
    outlet_id: "butterfold-bakehouse-indiranagar",
    name: "Bakery Surprise Bag",
    description: "Usually 4–6 items from today’s bakes, like bread, croissants, a cake slice or cookies. Contents change every day. Packed fresh just before your window.",
    food_category: "bakery",
    diet: "egg",
    allergens: ["egg", ...MORE_ALLERGENS],
    rupees: 149,
    was: 450,
    left: 2,
    of: 6,
    start: 30,
    minutes: 60,
    photo_urls: [photo("#d9b48f", "#8c5a34"), photo("#eccda6", "#b87a2c"), photo("#c9a27c", "#6e3820")],
  },
  {
    outlet_id: "butterfold-bakehouse-indiranagar",
    name: "Four Croissants Box",
    description: "Four butter croissants from this morning’s bake, packed in a box.",
    type: "fixed_box",
    food_category: "desserts",
    diet: "egg",
    allergens: ["egg", "gluten", "dairy"],
    rupees: 199,
    was: 480,
    left: 5,
    of: 6,
    start: 30,
    minutes: 60,
  },
  {
    outlet_id: "smoke-salt-grill-indiranagar",
    name: "Chicken Biryani Box",
    description: "One generous portion of tonight’s chicken dum biryani with raita.",
    type: "fixed_box",
    food_category: "meals",
    diet: "nonveg",
    allergens: ["dairy"],
    rupees: 179,
    was: 420,
    left: 3,
    of: 5,
    start: 120,
    minutes: 45,
  },
  {
    outlet_id: "chai-patti-house-indiranagar",
    name: "Café Snack Bag",
    description: "A mix of tonight’s snacks: puffs, samosas, sandwiches or cake.",
    food_category: "cafe",
    diet: "mixed",
    allergens: [...MORE_ALLERGENS],
    rupees: 99,
    was: 260,
    left: 5,
    of: 8,
    start: 0,
    minutes: 45,
  },
  {
    outlet_id: "kaapi-corner-koramangala",
    name: "Café Surprise Bag",
    description: "Pastries, sandwiches and sweet bakes from today’s counter. Contents change every day.",
    food_category: "cafe",
    diet: "mixed",
    allergens: [...MORE_ALLERGENS],
    rupees: 129,
    was: 380,
    left: 6,
    of: 8,
    start: 60,
    minutes: 45,
  },
  {
    outlet_id: "udupi-tiffin-room-malleshwaram",
    name: "Evening Tiffin Box",
    description: "Idli, vada, a rice dish and chutneys from tonight’s kitchen.",
    type: "fixed_box",
    food_category: "meals",
    diet: "veg",
    allergens: ["sesame"],
    rupees: 89,
    was: 200,
    left: 8,
    of: 10,
    start: 30,
    minutes: 45,
  },
  {
    // Shows one left, but the reserve call loses the race, to demo sold_out.
    outlet_id: "little-lamington-hsr-layout",
    name: "Dessert Surprise Bag",
    description: "Lamingtons, brownies and tarts from today’s trays. Contents change every day.",
    food_category: "desserts",
    diet: "egg",
    allergens: ["egg", ...MORE_ALLERGENS],
    rupees: 179,
    was: 520,
    left: 1,
    of: 4,
    start: 90,
    minutes: 45,
    loses_race: true,
  },
  {
    outlet_id: "ragi-rye-jayanagar",
    name: "Six Millet Buns",
    description: "Six soft millet buns, baked this afternoon.",
    type: "fixed_box",
    food_category: "bakery",
    diet: "veg",
    allergens: ["gluten"],
    rupees: 99,
    was: 240,
    left: 4,
    of: 6,
    start: 0,
    minutes: 45,
  },
  {
    outlet_id: "ragi-rye-jayanagar",
    name: "Sourdough Loaf",
    description: "One whole sourdough loaf from today’s bake.",
    type: "fixed_box",
    food_category: "bakery",
    diet: "veg",
    allergens: ["gluten"],
    rupees: 119,
    was: 280,
    left: 0,
    of: 6,
    start: 0,
    minutes: 45,
  },
  {
    outlet_id: "irani-chai-stop-banjara-hills",
    name: "Osmania Biscuit Box",
    description: "A box of tonight’s Osmania biscuits and two chai buns.",
    type: "fixed_box",
    food_category: "cafe",
    diet: "egg",
    allergens: ["egg", "gluten", "dairy"],
    rupees: 79,
    was: 180,
    left: 7,
    of: 9,
    start: 30,
    minutes: 60,
  },
  {
    outlet_id: "deccan-bakes-madhapur",
    name: "Bakery Surprise Bag",
    description: "A mix of today’s breads, buns and cakes. Contents change every day.",
    food_category: "bakery",
    diet: "egg",
    allergens: ["egg", ...MORE_ALLERGENS],
    rupees: 139,
    was: 400,
    left: 4,
    of: 6,
    start: 60,
    minutes: 45,
  },
  {
    outlet_id: "nawab-s-kitchen-gachibowli",
    name: "Hyderabadi Biryani Box",
    description: "One portion of tonight’s mutton biryani with mirchi ka salan.",
    type: "fixed_box",
    food_category: "meals",
    diet: "nonveg",
    allergens: ["dairy", "nuts"],
    rupees: 199,
    was: 450,
    left: 3,
    of: 5,
    start: 90,
    minutes: 60,
  },
];

// Evening windows, pushed later if you are testing late at night.
function pickupBase(now: number): number {
  const eight = new Date(`${istDay(now)}T20:00:00+05:30`).getTime();
  const soonest = Math.ceil((now + 45 * MINUTE) / (15 * MINUTE)) * (15 * MINUTE);
  return Math.max(eight, soonest);
}

function seedDrops(now: number): DropRow[] {
  const base = pickupBase(now);
  return SEED_DROPS.map(({ rupees, was, left, of, start, minutes, ...seed }, index) => {
    const startAt = base + start * MINUTE;
    const endAt = startAt + minutes * MINUTE;
    return {
      id: `drop-${index + 1}`,
      listing_id: `listing-${index + 1}`,
      status: "live",
      type: "surprise_bag",
      allergens: [],
      photo_urls: [],
      ...seed,
      value_paise: was * 100,
      price_paise: rupees * 100,
      quantity: of,
      reserved_count: of - left,
      pickup_start_at: new Date(startAt).toISOString(),
      pickup_end_at: new Date(endAt).toISOString(),
      sales_end_at: new Date(endAt - 15 * MINUTE).toISOString(),
    };
  });
}

function pastOrder(
  number: number,
  name: string,
  outletId: string,
  food: Order["food_category"],
  daysAgo: number,
  now: number,
  status: Order["status"],
  price: number,
  value: number,
  extra: Partial<OrderRow> = {},
): OrderRow {
  const when = now - daysAgo * DAY;
  const at = new Date(when).toISOString();
  return {
    id: `order-${number}`,
    number,
    status,
    drop_id: "past",
    outlet_id: outletId,
    mine: true,
    name,
    food_category: food,
    type: "surprise_bag",
    diet: "mixed",
    allergens: [],
    price_paise: price * 100,
    value_paise: value * 100,
    pickup_code: null,
    pickup_start_at: at,
    pickup_end_at: new Date(when + 45 * MINUTE).toISOString(),
    hold_expires_at: at,
    paid_at: at,
    collected_at: status === "collected" ? at : null,
    cancelled_at: null,
    cancel_reason: null,
    payment_method: "UPI",
    rating: null,
    refund: null,
    created_at: at,
    ...extra,
  };
}

function seedOrders(now: number): OrderRow[] {
  const started = new Date(now - 90 * MINUTE).toISOString();
  return [
    pastOrder(20477, "Café Surprise Bag", "kaapi-corner-koramangala", "cafe", 0, now, "cancelled", 129, 380, {
      cancelled_at: started,
      cancel_reason: "ran out of stock",
      refund: { id: "RF-88213", amount_paise: 12900, status: "pending", created_at: started, processed_at: null },
    }),
    pastOrder(20402, "Veg Thali Box", "udupi-tiffin-room-malleshwaram", "meals", 5, now, "collected", 129, 300),
    pastOrder(20388, "Dessert Surprise Bag", "little-lamington-hsr-layout", "desserts", 8, now, "no_show", 179, 520),
    pastOrder(20351, "Café Surprise Bag", "kaapi-corner-koramangala", "cafe", 10, now, "cancelled", 129, 380, {
      cancelled_at: new Date(now - 10 * DAY).toISOString(),
      cancel_reason: "ran out of stock",
      refund: {
        id: "RF-80411",
        amount_paise: 12900,
        status: "processed",
        created_at: new Date(now - 10 * DAY).toISOString(),
        processed_at: new Date(now - 8 * DAY).toISOString(),
      },
    }),
  ];
}

function freshDb(now: number): Db {
  return {
    day: istDay(now),
    outlets: OUTLETS,
    drops: seedDrops(now),
    orders: [],
    me: null,
    following: ["butterfold-bakehouse-indiranagar", "kaapi-corner-koramangala"],
    nextNumber: 20481,
  };
}

function load(): Db {
  const now = Date.now();
  const stored = readJson<Db>(KEY);
  const db = stored && stored.day === istDay(now) ? stored : { ...freshDb(now), me: stored?.me ?? null };
  expireHolds(db, now);
  return db;
}

function save(db: Db) {
  writeJson(KEY, db);
}

function expireHolds(db: Db, now: number) {
  for (const order of db.orders) {
    if (order.status === "held" && new Date(order.hold_expires_at).getTime() < now) {
      order.status = "expired";
      returnStock(db, order.drop_id);
    }
  }
}

function returnStock(db: Db, dropId: string) {
  const drop = db.drops.find((d) => d.id === dropId);
  if (drop) drop.reserved_count = Math.max(0, drop.reserved_count - 1);
}

const wait = () => new Promise((resolve) => setTimeout(resolve, LATENCY_MS));

function fail(code: string, message: string, status: number): never {
  throw new ApiError(code, message, status);
}

function requireMe(db: Db): Me {
  return db.me ?? fail("unauthorized", "Sign in to continue.", 401);
}

function summary(row: OutletRow): OutletPickupInfo {
  const { opening_hours_today: _hours, ...rest } = row;
  return rest;
}

function outletOf(db: Db, id: string): OutletRow {
  return db.outlets.find((o) => o.id === id) ?? fail("not_found", "Outlet not found.", 404);
}

function dropView(db: Db, row: DropRow): Drop {
  const { outlet_id, loses_race: _race, ...rest } = row;
  return { ...rest, outlet: summary(outletOf(db, outlet_id)) };
}

function orderView(db: Db, row: OrderRow): Order {
  const { outlet_id, mine: _mine, ...rest } = row;
  return { ...rest, outlet: summary(outletOf(db, outlet_id)) };
}

function orderRow(db: Db, id: string): OrderRow {
  return db.orders.find((o) => o.id === id) ?? fail("not_found", "We can’t find that order.", 404);
}

function istMinutes(iso: string): number {
  const [hour, minute] = new Date(iso)
    .toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
    .split(":")
    .map(Number);
  return hour * 60 + minute;
}

function pickupCode(db: Db): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const taken = new Set(db.orders.map((o) => o.pickup_code));
  for (;;) {
    const code = letters[Math.floor(Math.random() * letters.length)] + String(100 + Math.floor(Math.random() * 900));
    if (!taken.has(code)) return code;
  }
}

function capture(id: string, method: string) {
  const db = load();
  const order = orderRow(db, id);
  if (order.status !== "held") return;
  const now = new Date().toISOString();
  order.status = "paid";
  order.paid_at = now;
  order.payment_method = method;
  order.pickup_code = pickupCode(db);
  save(db);
}

export const mockApi: Api = {
  async getCities() {
    await wait();
    return CITIES.map((city) => ({
      id: city.id,
      name: city.name,
      areas: city.areas.map((name) => ({ id: slug(name), name })),
    }));
  },

  async getDrops(filters) {
    await wait();
    const db = load();
    const now = Date.now();
    const q = filters.q?.trim().toLowerCase();
    const limit = filters.pickup_by
      ? Number(filters.pickup_by.slice(0, 2)) * 60 + Number(filters.pickup_by.slice(3))
      : null;
    return db.drops
      .filter((d) => d.status === "live" && new Date(d.sales_end_at).getTime() > now)
      .map((d) => dropView(db, d))
      .filter((d) => d.outlet.city === filters.city)
      .filter((d) => !filters.area || slug(d.outlet.area_name) === filters.area)
      .filter((d) => !filters.category || d.food_category === filters.category)
      .filter((d) => !filters.veg || d.diet === "veg")
      .filter((d) => !filters.max_price || d.price_paise <= filters.max_price)
      .filter((d) => limit === null || istMinutes(d.pickup_start_at) <= limit)
      .filter((d) => !q || `${d.name} ${d.outlet.brand_name} ${d.outlet.area_name}`.toLowerCase().includes(q))
      .sort((a, b) => Number(a.quantity === a.reserved_count) - Number(b.quantity === b.reserved_count));
  },

  async getDrop(id) {
    await wait();
    const db = load();
    const row = db.drops.find((d) => d.id === id) ?? fail("not_found", "This listing is gone.", 404);
    return { ...dropView(db, row), outlet: summary(outletOf(db, row.outlet_id)) } as DropDetail;
  },

  async getOutlet(brandSlug, outletSlug) {
    await wait();
    const db = load();
    const row =
      db.outlets.find((o) => o.brand_slug === brandSlug && o.slug === outletSlug) ??
      fail("not_found", "We can’t find that outlet.", 404);
    return {
      ...row,
      following: db.me ? db.following.includes(row.id) : false,
      drops: db.drops.filter((d) => d.outlet_id === row.id).map((d) => dropView(db, d)),
    };
  },

  async sendOtp() {
    await wait();
  },

  async verifyOtp(phone, code) {
    await wait();
    if (code === "000000") fail("invalid_otp", "That code isn’t right. Check the SMS and try again.", 400);
    const db = load();
    const digits = phone.replace(/\D/g, "").slice(-10);
    const brandNew = digits.startsWith("90000");
    const now = Date.now();
    db.me = {
      id: `user-${digits}`,
      phone: `+91${digits}`,
      name: brandNew ? null : "Priya Sharma",
      email: null,
      is_admin: false,
      whatsapp_opt_in: true,
      marketing_opt_in: false,
      created_at: new Date(now - (brandNew ? 0 : 150 * DAY)).toISOString(),
      bags_rescued: brandNew ? 0 : 23,
      saved_paise: brandNew ? 0 : 487000,
    };
    if (brandNew) {
      db.following = [];
    } else if (!db.orders.some((o) => o.id === "order-20402")) {
      db.orders.push(...seedOrders(now));
    }
    // Attach any signed-out hold. One bag per outlet per night, so a clash releases it.
    for (const hold of db.orders.filter((o) => o.status === "held" && !o.mine)) {
      const clash = db.orders.some(
        (o) => o.mine && o.outlet_id === hold.outlet_id && (o.status === "held" || o.status === "paid"),
      );
      if (clash) {
        hold.status = "expired";
        returnStock(db, hold.drop_id);
      } else {
        hold.mine = true;
      }
    }
    save(db);
    return db.me;
  },

  async logout() {
    await wait();
    const db = load();
    db.me = null;
    save(db);
  },

  async reserve(dropId) {
    await wait();
    const db = load();
    const now = Date.now();
    const drop = db.drops.find((d) => d.id === dropId) ?? fail("not_found", "This listing is gone.", 404);
    if (db.me) {
      const clash = db.orders.some(
        (o) =>
          o.mine &&
          o.outlet_id === drop.outlet_id &&
          (o.status === "held" || o.status === "paid") &&
          o.drop_id !== "past",
      );
      if (clash) fail("already_ordered", "You already have a bag from this outlet tonight.", 409);
    }
    if (drop.loses_race) {
      drop.reserved_count = drop.quantity;
      drop.loses_race = false;
      save(db);
    }
    const open = drop.status === "live" && new Date(drop.sales_end_at).getTime() > now;
    if (!open || drop.reserved_count >= drop.quantity) fail("sold_out", "Sold out for tonight.", 409);
    // One active hold per signed-out visitor: a new one replaces the old.
    for (const old of db.orders.filter((o) => o.status === "held" && !o.mine)) {
      old.status = "expired";
      returnStock(db, old.drop_id);
    }
    drop.reserved_count += 1;
    const at = new Date(now).toISOString();
    const row: OrderRow = {
      id: `order-${db.nextNumber}`,
      number: db.nextNumber,
      status: "held",
      drop_id: drop.id,
      outlet_id: drop.outlet_id,
      mine: !!db.me,
      name: drop.name,
      food_category: drop.food_category,
      type: drop.type,
      diet: drop.diet,
      allergens: drop.allergens,
      price_paise: drop.price_paise,
      value_paise: drop.value_paise,
      pickup_code: null,
      pickup_start_at: drop.pickup_start_at,
      pickup_end_at: drop.pickup_end_at,
      hold_expires_at: new Date(now + HOLD_SECONDS * 1000).toISOString(),
      paid_at: null,
      collected_at: null,
      cancelled_at: null,
      cancel_reason: null,
      payment_method: null,
      rating: null,
      refund: null,
      created_at: at,
    };
    db.nextNumber += 1;
    db.orders.push(row);
    save(db);
    return orderView(db, row);
  },

  async getOrder(id) {
    await wait();
    const db = load();
    return orderView(db, orderRow(db, id));
  },

  async payOrder(id) {
    await wait();
    const db = load();
    requireMe(db);
    const order = orderRow(db, id);
    if (order.status !== "held") fail("hold_expired", "Your hold has ended.", 409);
    return {
      razorpay_order_id: `order_mock_${order.number}`,
      key_id: "rzp_test_mock",
      amount_paise: order.price_paise,
      currency: "INR",
      timeout_seconds: Math.floor((new Date(order.hold_expires_at).getTime() - Date.now()) / 1000),
    };
  },

  async releaseHold(id) {
    await wait();
    const db = load();
    const order = orderRow(db, id);
    if (order.status === "held") {
      order.status = "expired";
      returnStock(db, order.drop_id);
      save(db);
    }
  },

  async getMyOrders(status) {
    await wait();
    const db = load();
    requireMe(db);
    const active = (o: OrderRow) =>
      o.status === "held" || o.status === "paid" || (o.status === "cancelled" && o.refund?.status === "pending");
    return db.orders
      .filter((o) => o.mine && o.status !== "expired" && (status === "active" ? active(o) : !active(o)))
      .sort((a, b) => b.number - a.number)
      .map((o) => orderView(db, o));
  },

  async rateOrder(id, rating) {
    await wait();
    const db = load();
    orderRow(db, id).rating = rating;
    save(db);
  },

  async reportIssue() {
    await wait();
  },

  async getMe() {
    await wait();
    return requireMe(load());
  },

  async updateMe(patch) {
    await wait();
    const db = load();
    db.me = { ...requireMe(db), ...patch };
    save(db);
    return db.me;
  },

  async deleteMe() {
    await wait();
    const db = load();
    db.me = null;
    db.orders = db.orders.filter((o) => !o.mine);
    save(db);
  },

  async getFollowing() {
    await wait();
    const db = load();
    return db.following.map((id) => summary(outletOf(db, id)));
  },

  async follow(outletId) {
    await wait();
    const db = load();
    if (!db.following.includes(outletId)) db.following.push(outletId);
    save(db);
  },

  async unfollow(outletId) {
    await wait();
    const db = load();
    db.following = db.following.filter((id) => id !== outletId);
    save(db);
  },
};

// Things only the real backend or Razorpay can do, driven by the mock pay sheet.
export const mockControls = {
  capture,
  captureLater(id: string, method: string, ms: number) {
    setTimeout(() => capture(id, method), ms);
  },
  expireHold(id: string) {
    const db = load();
    const order = orderRow(db, id);
    order.hold_expires_at = new Date(Date.now() - 1000).toISOString();
    save(db);
  },
};

export type MockControls = typeof mockControls;
