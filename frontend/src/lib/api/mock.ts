// In-browser stand-in for the backend, on when NEXT_PUBLIC_API_MOCK=1.
// State lives in localStorage so a refresh keeps your hold and orders.
//
// Sign in with any 10-digit number and any 6-digit code except 000000.
//   90000xxxxx  a brand new customer with no name saved
//   98860xxxxx  owner of Butterfold Bakehouse, with two outlets
//   99999xxxxx  admin
//   anything else: Priya, a returning customer with past orders

import { HOLD_SECONDS } from "@/config/brand";
import { istDay } from "@/lib/format";
import { readJson, writeJson } from "@/lib/storage";
import type { Api } from "./client";
import { ApiError, type ErrorDetails } from "./errors";
import type {
  Application,
  Drop,
  DropDetail,
  FoodCategory,
  Listing,
  OpeningHours,
  Order,
  OutletCategory,
  OutletPage,
  Payout,
  Profile,
  ReviewedDocument,
  SignedInUser,
  VendorDrop,
  VendorOrder,
  VendorOutlet,
} from "./types";

const KEY = "lb_mock_v2";
const LATENCY_MS = 200;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type OutletRow = VendorOutlet & {
  brandName: string;
  brandSlug: string;
  city: string;
  area: string;
  rating: number | null;
  submittedAt: string | null;
  createdAt: string;
  ownerPhone: string | null;
};

type DropRow = Omit<Drop, "brandName" | "branchName" | "area" | "city" | "brandSlug" | "outletSlug"> & {
  listingId: string;
  quantity: number;
  status: "live" | "paused" | "cancelled";
  description: string;
  allergens: string[];
  losesRace?: boolean;
};

type OrderRow = Omit<Order, "brandName" | "branchName" | "address" | "mapsUrl" | "pickupInstructions" | "city" | "brandSlug" | "outletSlug"> & {
  outletId: string;
  dropId: string;
  mine: boolean;
  customerLabel: string;
};

type AccountRow = { id: string; brandId: string; holderName: string; legalName: string; panLast4: string; accountLast4: string; ifsc: string; agreed: boolean };

type DocRow = ReviewedDocument;

type Db = {
  day: string;
  outlets: OutletRow[];
  drops: DropRow[];
  orders: OrderRow[];
  listings: Listing[];
  accounts: AccountRow[];
  documents: DocRow[];
  payouts: Payout[];
  user: SignedInUser | null;
  profile: Profile | null;
  following: string[];
  nextNumber: number;
  nextId: number;
};

const CITIES = [
  { slug: "bengaluru", name: "Bengaluru", areas: ["HSR Layout", "Indiranagar", "Jayanagar", "Koramangala", "Malleshwaram", "Whitefield"] },
  { slug: "hyderabad", name: "Hyderabad", areas: ["Banjara Hills", "Gachibowli", "Jubilee Hills", "Kondapur", "Madhapur"] },
];

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const EVERY_DAY = (open: string, close: string): OpeningHours => ({
  mon: [[open, close]],
  tue: [[open, close]],
  wed: [[open, close]],
  thu: [[open, close]],
  fri: [[open, close]],
  sat: [[open, close]],
  sun: [[open, close]],
});

function cityOf(area: string) {
  return CITIES.find((c) => c.areas.includes(area))!.slug;
}

function outlet(
  area: string,
  brandName: string,
  category: OutletCategory,
  address: string,
  pincode: string,
  rating: number | null,
  extra: Partial<OutletRow> = {},
): OutletRow {
  return {
    id: `${slug(brandName)}-${slug(area)}`,
    brandId: `brand-${slug(brandName)}`,
    brandName,
    brandSlug: slug(brandName),
    payoutAccountId: null,
    areaId: slug(area),
    branchName: area,
    slug: slug(area),
    city: cityOf(area),
    area,
    category,
    rating,
    address,
    pincode,
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${brandName} ${area}`)}`,
    contactPhone: null,
    pickupInstructions: "Show your code at the counter.",
    openingHours: EVERY_DAY("09:00", "22:00"),
    photoKeys: [],
    fssaiNumber: "11224999000123",
    fssaiExpiresOn: "2027-01-14",
    gstin: null,
    commissionBps: 2000,
    status: "live",
    onboardingStep: 5,
    pausedUntil: null,
    submittedAt: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    ownerPhone: null,
    ...extra,
  };
}

const OUTLETS: OutletRow[] = [
  outlet("Indiranagar", "Butterfold Bakehouse", "bakery", "14, 12th Main, HAL 2nd Stage, Indiranagar, Bengaluru 560038", "560038", 4.6, {
    pickupInstructions: "Side counter on the left. Show your code, no need to queue.",
    openingHours: EVERY_DAY("08:00", "22:00"),
    payoutAccountId: "account-butterfold",
    ownerPhone: "98860",
  }),
  outlet("Koramangala", "Butterfold Bakehouse", "bakery", "7, 80 Feet Road, Koramangala, Bengaluru 560095", "560095", null, {
    payoutAccountId: "account-butterfold",
    ownerPhone: "98860",
  }),
  outlet("Indiranagar", "Smoke & Salt Grill", "restaurant", "221, Double Road, Indiranagar, Bengaluru 560038", "560038", 4.3),
  outlet("Indiranagar", "Chai Patti House", "cafe", "9, CMH Road, Indiranagar, Bengaluru 560038", "560038", 4.4),
  outlet("Koramangala", "Kaapi Corner", "cafe", "48, 5th Block, Koramangala, Bengaluru 560095", "560095", 4.5),
  outlet("Malleshwaram", "Udupi Tiffin Room", "restaurant", "3, Sampige Road, Malleshwaram, Bengaluru 560003", "560003", 4.7),
  outlet("HSR Layout", "Little Lamington", "sweets", "17, Sector 3, HSR Layout, Bengaluru 560102", "560102", 4.8),
  outlet("Jayanagar", "Ragi & Rye", "bakery", "62, 4th Block, Jayanagar, Bengaluru 560011", "560011", null),
  outlet("Banjara Hills", "Irani Chai Stop", "cafe", "8-2, Road No 1, Banjara Hills, Hyderabad 500034", "500034", 4.5),
  outlet("Madhapur", "Deccan Bakes", "bakery", "12, Ayyappa Society, Madhapur, Hyderabad 500081", "500081", 4.2),
  outlet("Gachibowli", "Nawab’s Kitchen", "kitchen", "5, DLF Road, Gachibowli, Hyderabad 500032", "500032", 4.4),
];

function photo(top: string, bottom: string) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 390 380'><defs><linearGradient id='g' x2='1' y2='1'><stop stop-color='${top}'/><stop offset='1' stop-color='${bottom}'/></linearGradient></defs><rect width='390' height='380' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const MAY_CONTAIN = ["gluten", "dairy", "nuts", "sesame"];

type Seed = Partial<DropRow> &
  Pick<DropRow, "name" | "description" | "foodCategory" | "diet"> & {
    outletId: string;
    rupees: number;
    was: number;
    left: number;
    of: number;
    start: number;
    minutes: number;
  };

const SEEDS: Seed[] = [
  {
    outletId: "butterfold-bakehouse-indiranagar",
    name: "Bakery Surprise Bag",
    description: "Usually 4–6 items from today’s bakes, like bread, croissants, a cake slice or cookies. Contents change every day. Packed fresh just before your window.",
    foodCategory: "bakery",
    diet: "egg",
    allergens: ["egg", ...MAY_CONTAIN],
    rupees: 149,
    was: 450,
    left: 2,
    of: 6,
    start: 30,
    minutes: 60,
    photoUrl: photo("#d9b48f", "#8c5a34"),
  },
  {
    outletId: "butterfold-bakehouse-indiranagar",
    name: "Four Croissants Box",
    description: "Four butter croissants from this morning’s bake, packed in a box.",
    type: "fixed_box",
    foodCategory: "desserts",
    diet: "egg",
    allergens: ["egg", "gluten", "dairy"],
    rupees: 199,
    was: 480,
    left: 2,
    of: 5,
    start: 30,
    minutes: 60,
  },
  {
    outletId: "smoke-salt-grill-indiranagar",
    name: "Chicken Biryani Box",
    description: "One generous portion of tonight’s chicken dum biryani with raita.",
    type: "fixed_box",
    foodCategory: "meals",
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
    outletId: "chai-patti-house-indiranagar",
    name: "Café Snack Bag",
    description: "A mix of tonight’s snacks: puffs, samosas, sandwiches or cake.",
    foodCategory: "cafe",
    diet: "mixed",
    allergens: [...MAY_CONTAIN],
    rupees: 99,
    was: 260,
    left: 5,
    of: 8,
    start: 0,
    minutes: 45,
  },
  {
    outletId: "kaapi-corner-koramangala",
    name: "Café Surprise Bag",
    description: "Pastries, sandwiches and sweet bakes from today’s counter. Contents change every day.",
    foodCategory: "cafe",
    diet: "mixed",
    allergens: [...MAY_CONTAIN],
    rupees: 129,
    was: 380,
    left: 6,
    of: 8,
    start: 60,
    minutes: 45,
  },
  {
    outletId: "udupi-tiffin-room-malleshwaram",
    name: "Evening Tiffin Box",
    description: "Idli, vada, a rice dish and chutneys from tonight’s kitchen.",
    type: "fixed_box",
    foodCategory: "meals",
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
    outletId: "little-lamington-hsr-layout",
    name: "Dessert Surprise Bag",
    description: "Lamingtons, brownies and tarts from today’s trays. Contents change every day.",
    foodCategory: "desserts",
    diet: "egg",
    allergens: ["egg", ...MAY_CONTAIN],
    rupees: 179,
    was: 520,
    left: 1,
    of: 4,
    start: 90,
    minutes: 45,
    losesRace: true,
  },
  {
    outletId: "ragi-rye-jayanagar",
    name: "Six Millet Buns",
    description: "Six soft millet buns, baked this afternoon.",
    type: "fixed_box",
    foodCategory: "bakery",
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
    outletId: "ragi-rye-jayanagar",
    name: "Sourdough Loaf",
    description: "One whole sourdough loaf from today’s bake.",
    type: "fixed_box",
    foodCategory: "bakery",
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
    outletId: "irani-chai-stop-banjara-hills",
    name: "Osmania Biscuit Box",
    description: "A box of tonight’s Osmania biscuits and two chai buns.",
    type: "fixed_box",
    foodCategory: "cafe",
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
    outletId: "deccan-bakes-madhapur",
    name: "Bakery Surprise Bag",
    description: "A mix of today’s breads, buns and cakes. Contents change every day.",
    foodCategory: "bakery",
    diet: "egg",
    allergens: ["egg", ...MAY_CONTAIN],
    rupees: 139,
    was: 400,
    left: 4,
    of: 6,
    start: 60,
    minutes: 45,
  },
  {
    outletId: "nawab-s-kitchen-gachibowli",
    name: "Hyderabadi Biryani Box",
    description: "One portion of tonight’s mutton biryani with mirchi ka salan.",
    type: "fixed_box",
    foodCategory: "meals",
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

function istHhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
}

function seedDrops(now: number): DropRow[] {
  const base = pickupBase(now);
  return SEEDS.map(({ rupees, was, left, of, start, minutes, ...seed }, index) => {
    const startAt = base + start * MINUTE;
    const endAt = startAt + minutes * MINUTE;
    return {
      id: `drop-${index + 1}`,
      listingId: `listing-${index + 1}`,
      status: "live",
      type: "surprise_bag",
      allergens: [],
      photoUrl: null,
      ...seed,
      valuePaise: was * 100,
      pricePaise: rupees * 100,
      quantity: of,
      remaining: left,
      pickupStartAt: new Date(startAt).toISOString(),
      pickupEndAt: new Date(endAt).toISOString(),
      salesEndAt: new Date(endAt - 15 * MINUTE).toISOString(),
    };
  });
}

function seedListings(drops: DropRow[]): Listing[] {
  const listings = drops.map(
    (d): Listing => ({
      id: d.listingId,
      outletId: d.outletId,
      type: d.type,
      name: d.name,
      description: d.description,
      foodCategory: d.foodCategory,
      diet: d.diet,
      allergens: d.allergens,
      valuePaise: d.valuePaise,
      pricePaise: d.pricePaise,
      defaultQuantity: d.quantity,
      pickupStart: istHhmm(new Date(d.pickupStartAt).getTime()),
      pickupEnd: istHhmm(new Date(d.pickupEndAt).getTime()),
      repeatDays: [1, 2, 3, 4, 5, 6, 7],
      photoKey: null,
      archivedAt: null,
    }),
  );
  listings.push({
    ...listings[1],
    id: "listing-cake-slice",
    name: "Cake Slice Box",
    description: "Two slices of today’s cakes.",
    pricePaise: 12900,
    valuePaise: 30000,
    defaultQuantity: 4,
    repeatDays: [6, 7],
  });
  return listings;
}

function vendorOrder(
  db: Db,
  drop: DropRow,
  customerLabel: string,
  code: string,
  status: "paid" | "collected",
  now: number,
): OrderRow {
  const number = db.nextNumber++;
  const at = new Date(now - 30 * MINUTE).toISOString();
  return {
    id: `order-${number}`,
    number: `SJ-${number}`,
    status,
    dropId: drop.id,
    outletId: drop.outletId,
    mine: false,
    customerLabel,
    name: drop.name,
    foodCategory: drop.foodCategory,
    type: drop.type,
    diet: drop.diet,
    allergens: drop.allergens,
    pricePaise: drop.pricePaise,
    valuePaise: drop.valuePaise,
    pickupCode: code,
    pickupStartAt: drop.pickupStartAt,
    pickupEndAt: drop.pickupEndAt,
    holdExpiresAt: at,
    collectedAt: status === "collected" ? at : null,
    rating: null,
    refund: null,
  };
}

function pastOrder(
  number: number,
  name: string,
  outletId: string,
  food: FoodCategory,
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
    number: `SJ-${number}`,
    status,
    dropId: "past",
    outletId,
    mine: true,
    customerLabel: "Priya S.",
    name,
    foodCategory: food,
    type: "surprise_bag",
    diet: "mixed",
    allergens: [],
    pricePaise: price * 100,
    valuePaise: value * 100,
    pickupCode: null,
    pickupStartAt: at,
    pickupEndAt: new Date(when + 45 * MINUTE).toISOString(),
    holdExpiresAt: at,
    collectedAt: status === "collected" ? at : null,
    rating: null,
    refund: null,
    ...extra,
  };
}

function customerHistory(now: number): OrderRow[] {
  return [
    pastOrder(20477, "Café Surprise Bag", "kaapi-corner-koramangala", "cafe", 0, now, "cancelled", 129, 380, {
      refund: { amountPaise: 12900, status: "pending" },
    }),
    pastOrder(20402, "Veg Thali Box", "udupi-tiffin-room-malleshwaram", "meals", 5, now, "collected", 129, 300),
    pastOrder(20388, "Dessert Surprise Bag", "little-lamington-hsr-layout", "desserts", 8, now, "no_show", 179, 520),
    pastOrder(20351, "Café Surprise Bag", "kaapi-corner-koramangala", "cafe", 10, now, "cancelled", 129, 380, {
      refund: { amountPaise: 12900, status: "processed" },
    }),
  ];
}

function applicant(
  id: number,
  brandName: string,
  area: string,
  category: OutletCategory,
  hoursAgo: number,
  now: number,
): { outlet: OutletRow; account: AccountRow; documents: DocRow[] } {
  const at = new Date(now - hoursAgo * 60 * MINUTE).toISOString();
  const row = outlet(area, brandName, category, `${id}, Main Road, ${area}`, "560001", null, {
    id: `app-${id}`,
    payoutAccountId: `account-app-${id}`,
    status: "in_review",
    submittedAt: at,
    createdAt: at,
  });
  const doc = (kind: ReviewedDocument["kind"], owner: "outlet" | "account"): DocRow => ({
    id: `doc-${id}-${kind}`,
    outletId: owner === "outlet" ? row.id : null,
    payoutAccountId: owner === "account" ? row.payoutAccountId : null,
    kind,
    status: "pending",
    rejectionReason: null,
    createdAt: at,
    url: photo("#f0ece6", "#d6cfc6"),
  });
  return {
    outlet: row,
    account: {
      id: row.payoutAccountId!,
      brandId: row.brandId,
      legalName: brandName,
      holderName: brandName,
      panLast4: "821K",
      accountLast4: "3317",
      ifsc: "SMPL0004512",
      agreed: true,
    },
    documents: [doc("fssai", "outlet"), doc("pan", "account"), doc("bank_proof", "account")],
  };
}

function payout(id: string, weeksAgo: number, now: number, gross: number, status: Payout["status"]): Payout {
  const end = new Date(now - weeksAgo * 7 * DAY);
  const start = new Date(end.getTime() - 6 * DAY);
  const commission = Math.round(gross * 0.2);
  const fees = Math.round(gross * 0.02);
  return {
    id,
    periodStart: istDay(start.getTime()),
    periodEnd: istDay(end.getTime()),
    grossPaise: gross,
    commissionPaise: commission,
    feesPaise: fees,
    taxPaise: 0,
    adjustmentPaise: 0,
    netPaise: gross - commission - fees,
    status,
    paidAt: status === "paid" ? new Date(end.getTime() + 2 * DAY).toISOString() : null,
  };
}

function freshDb(now: number): Db {
  const drops = seedDrops(now);
  const listings = seedListings(drops);
  const queue = [
    applicant(1042, "Pesarattu & Co", "Madhapur", "cafe", 22, now),
    applicant(1043, "Deccan Crust Bakery", "Jubilee Hills", "bakery", 9, now),
  ];
  const db: Db = {
    day: istDay(now),
    outlets: [...OUTLETS, ...queue.map((q) => q.outlet)],
    drops,
    orders: [],
    listings,
    accounts: [
      {
        id: "account-butterfold",
        brandId: "brand-butterfold-bakehouse",
        legalName: "Butterfold Bakehouse",
        holderName: "Ananya Rao",
        panLast4: "821K",
        accountLast4: "3317",
        ifsc: "SMPL0004512",
        agreed: true,
      },
      ...queue.map((q) => q.account),
    ],
    documents: queue.flatMap((q) => q.documents),
    payouts: [payout("payout-2", 1, now, 720000, "paid"), payout("payout-1", 2, now, 601000, "paid")],
    user: null,
    profile: null,
    following: [],
    nextNumber: 20470,
    nextId: 1,
  };
  const [bag, box] = drops;
  db.orders.push(
    vendorOrder(db, bag, "Fatima K.", "P903", "paid", now),
    vendorOrder(db, bag, "Divya N.", "T120", "paid", now),
    vendorOrder(db, bag, "Neha G.", "V664", "paid", now),
    vendorOrder(db, box, "Arjun R.", "M218", "collected", now),
    vendorOrder(db, box, "Rahul M.", "R551", "paid", now),
  );
  db.nextNumber = 20481;
  return db;
}

function load(): Db {
  const now = Date.now();
  const stored = readJson<Db>(KEY);
  const db = stored && stored.day === istDay(now) ? stored : { ...freshDb(now), user: stored?.user ?? null, profile: stored?.profile ?? null };
  expireHolds(db, now);
  return db;
}

function save(db: Db) {
  writeJson(KEY, db);
}

function expireHolds(db: Db, now: number) {
  for (const order of db.orders) {
    if (order.status === "held" && new Date(order.holdExpiresAt).getTime() < now) {
      order.status = "expired";
      returnStock(db, order.dropId);
    }
  }
}

function returnStock(db: Db, dropId: string) {
  const drop = db.drops.find((d) => d.id === dropId);
  if (drop) drop.remaining = Math.min(drop.quantity, drop.remaining + 1);
}

const wait = () => new Promise((resolve) => setTimeout(resolve, LATENCY_MS));

function fail(code: string, message: string, status: number, details?: ErrorDetails): never {
  throw new ApiError(code, message, status, details);
}

function requireUser(db: Db): SignedInUser {
  return db.user ?? fail("unauthorized", "Sign in to continue.", 401);
}

function requireAdmin(db: Db) {
  if (!requireUser(db).isAdmin) fail("forbidden", "Not allowed", 403);
}

function outletOf(db: Db, id: string): OutletRow {
  return db.outlets.find((o) => o.id === id) ?? fail("not_found", "Outlet not found", 404);
}

function mineOutlets(db: Db): OutletRow[] {
  const prefix = requireUser(db).phone.slice(3, 8);
  return db.outlets.filter((o) => o.ownerPhone === prefix || o.ownerPhone === requireUser(db).phone);
}

function publicVendorOutlet(row: OutletRow): VendorOutlet {
  const { brandSlug: _b, city: _c, area: _a, rating: _r, ownerPhone: _o, ...rest } = row;
  return rest;
}

function dropView(db: Db, row: DropRow): Drop {
  const { listingId: _l, quantity: _q, status: _s, description: _d, allergens: _al, losesRace: _r, ...rest } = row;
  const o = outletOf(db, row.outletId);
  return { ...rest, brandName: o.brandName, branchName: o.branchName, area: o.area, city: o.city, brandSlug: o.brandSlug, outletSlug: o.slug };
}

function orderView(db: Db, row: OrderRow): Order {
  const { outletId, dropId: _d, mine: _m, customerLabel: _c, ...rest } = row;
  const o = outletOf(db, outletId);
  return {
    ...rest,
    brandName: o.brandName,
    branchName: o.branchName,
    address: o.address,
    mapsUrl: o.mapsUrl,
    pickupInstructions: o.pickupInstructions,
    city: o.city,
    brandSlug: o.brandSlug,
    outletSlug: o.slug,
  };
}

function vendorDropView(row: DropRow): VendorDrop {
  return {
    id: row.id,
    listingId: row.listingId,
    outletId: row.outletId,
    serviceDate: istDay(row.pickupStartAt),
    quantity: row.quantity,
    reservedCount: row.quantity - row.remaining,
    status: row.status,
    name: row.name,
    pricePaise: row.pricePaise,
    valuePaise: row.valuePaise,
    pickupStartAt: row.pickupStartAt,
    pickupEndAt: row.pickupEndAt,
  };
}

function orderRow(db: Db, id: string): OrderRow {
  return db.orders.find((o) => o.id === id) ?? fail("not_found", "Order not found", 404);
}

function dropRow(db: Db, id: string): DropRow {
  return db.drops.find((d) => d.id === id) ?? fail("not_found", "Drop not found", 404);
}

function listingRow(db: Db, id: string): Listing {
  return db.listings.find((l) => l.id === id) ?? fail("not_found", "Listing not found", 404);
}

function nextId(db: Db, prefix: string) {
  return `${prefix}-${db.nextId++}`;
}

function istMinutes(iso: string): number {
  const [hour, minute] = istHhmm(new Date(iso).getTime()).split(":").map(Number);
  return hour * 60 + minute;
}

function pickupCode(db: Db): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const taken = new Set(db.orders.map((o) => o.pickupCode));
  for (;;) {
    const code = letters[Math.floor(Math.random() * letters.length)] + String(100 + Math.floor(Math.random() * 900));
    if (!taken.has(code)) return code;
  }
}

function capture(id: string) {
  const db = load();
  const order = orderRow(db, id);
  if (order.status !== "held") return;
  order.status = "paid";
  order.pickupCode = pickupCode(db);
  save(db);
}

function collect(db: Db, order: OrderRow) {
  if (order.status === "collected") {
    fail("already_collected", "This order was already collected", 409, { collectedAt: order.collectedAt ?? undefined });
  }
  if (order.status !== "paid") fail("not_collectable", "This order cannot be collected", 409);
  order.status = "collected";
  order.collectedAt = new Date().toISOString();
}

function cancelPaid(db: Db, order: OrderRow) {
  order.status = "cancelled";
  order.refund = { amountPaise: order.pricePaise, status: "pending" };
  returnStock(db, order.dropId);
}

function checks(db: Db, o: OutletRow) {
  const fixes: { step: string; code: string; message: string }[] = [];
  const need = (step: string, code: string, message: string) => fixes.push({ step, code, message });
  if (!o.address) need("details", "address_missing", "Add the outlet address");
  if (!o.areaId) need("details", "area_missing", "Choose the area");
  if (!o.openingHours) need("details", "hours_missing", "Add opening hours");
  if (!o.mapsUrl) need("details", "maps_url_missing", "Add the Google Maps link");
  if (!o.fssaiNumber || !o.fssaiExpiresOn) need("licence", "fssai_details_missing", "Add the FSSAI number and expiry date");
  const docCheck = (step: string, kind: string, label: string, rows: DocRow[]) => {
    const live = rows.filter((d) => d.kind === kind && d.status !== "replaced");
    if (live.some((d) => d.status === "pending" || d.status === "approved")) return;
    const rejected = live.find((d) => d.status === "rejected");
    if (rejected) need(step, `${kind}_document_rejected`, `The ${label} was rejected: ${rejected.rejectionReason}. Upload it again`);
    else need(step, `${kind}_document_missing`, `Upload the ${label}`);
  };
  docCheck("licence", "fssai", "FSSAI licence", db.documents.filter((d) => d.outletId === o.id));
  if (!o.payoutAccountId) {
    need("payout", "payout_account_missing", "Add the payout account");
    need("agreement", "agreement_missing", "Sign the vendor agreement");
  } else {
    const rows = db.documents.filter((d) => d.payoutAccountId === o.payoutAccountId);
    docCheck("payout", "pan", "PAN card", rows);
    docCheck("payout", "bank_proof", "bank proof", rows);
    if (!db.accounts.find((a) => a.id === o.payoutAccountId)?.agreed) need("agreement", "agreement_missing", "Sign the vendor agreement");
  }
  if (!db.listings.some((l) => l.outletId === o.id && !l.archivedAt)) need("listing", "listing_missing", "Add at least one listing");
  return fixes;
}

export const mockApi: Api = {
  async getCities() {
    await wait();
    return CITIES.map((city) => ({
      slug: city.slug,
      name: city.name,
      areas: city.areas.map((name) => ({ id: slug(name), name })),
    }));
  },

  async getDrops(filters) {
    await wait();
    const db = load();
    const now = Date.now();
    const q = filters.q?.trim().toLowerCase();
    const limit = filters.pickup_by ? Number(filters.pickup_by.slice(0, 2)) * 60 + Number(filters.pickup_by.slice(3)) : null;
    return db.drops
      .filter((d) => d.status === "live" && new Date(d.salesEndAt).getTime() > now)
      .map((d) => dropView(db, d))
      .filter((d) => d.city === filters.city)
      .filter((d) => !filters.area || d.area?.toLowerCase() === filters.area.toLowerCase())
      .filter((d) => !filters.category || d.foodCategory === filters.category)
      .filter((d) => !filters.veg || d.diet === "veg")
      .filter((d) => !filters.max_price || d.pricePaise <= filters.max_price)
      .filter((d) => limit === null || istMinutes(d.pickupStartAt) <= limit)
      .filter((d) => !q || `${d.name} ${d.brandName} ${d.branchName}`.toLowerCase().includes(q))
      .sort((a, b) => Number(a.remaining === 0) - Number(b.remaining === 0));
  },

  async getDrop(id) {
    await wait();
    const db = load();
    const row = db.drops.find((d) => d.id === id);
    if (!row || row.status !== "live" || new Date(row.pickupEndAt).getTime() < Date.now()) fail("not_found", "Drop not found", 404);
    const o = outletOf(db, row.outletId);
    const detail: DropDetail = {
      ...dropView(db, row),
      description: row.description,
      allergens: row.allergens,
      pickupInstructions: o.pickupInstructions,
      address: o.address,
      mapsUrl: o.mapsUrl,
      fssaiNumber: o.fssaiNumber,
      rating: o.rating,
    };
    return detail;
  },

  async getOutlet(brandSlug, outletSlug) {
    await wait();
    const db = load();
    const o =
      db.outlets.find((row) => row.brandSlug === brandSlug && row.slug === outletSlug && row.status === "live") ??
      fail("not_found", "Outlet not found", 404);
    const page: OutletPage = {
      outletId: o.id,
      brandName: o.brandName,
      brandSlug: o.brandSlug,
      branchName: o.branchName,
      outletSlug: o.slug,
      city: o.city,
      area: o.area,
      category: o.category,
      address: o.address,
      mapsUrl: o.mapsUrl,
      pickupInstructions: o.pickupInstructions,
      openingHours: o.openingHours,
      fssaiNumber: o.fssaiNumber,
      photoUrls: [],
      rating: o.rating,
      drops: db.drops
        .filter((d) => d.outletId === o.id && d.status === "live" && new Date(d.salesEndAt).getTime() > Date.now())
        .map((d) => dropView(db, d)),
    };
    return page;
  },

  async sendOtp() {
    await wait();
  },

  async verifyOtp(phone, code) {
    await wait();
    if (code === "000000") fail("otp_invalid", "That code is not valid", 401);
    const db = load();
    const digits = phone.replace(/\D/g, "").slice(-10);
    const brandNew = digits.startsWith("90000");
    const owner = digits.startsWith("98860");
    const admin = digits.startsWith("99999");
    const now = Date.now();
    const name = brandNew ? null : owner ? "Ananya Rao" : admin ? "Reviewer" : "Priya Sharma";
    db.user = { id: `user-${digits}`, phone: `+91${digits}`, name, isAdmin: admin };
    db.profile = {
      id: db.user.id,
      phone: db.user.phone,
      name,
      email: null,
      whatsappOptIn: true,
      marketingOptIn: false,
      impact: brandNew || owner || admin ? { bagsCollected: 0, moneySavedPaise: 0 } : { bagsCollected: 23, moneySavedPaise: 487000 },
    };
    if (name === "Priya Sharma") {
      db.following = ["butterfold-bakehouse-indiranagar", "kaapi-corner-koramangala"];
      if (!db.orders.some((o) => o.id === "order-20402")) db.orders.push(...customerHistory(now));
    } else {
      db.following = [];
    }
    // Attach any signed-out hold. One bag per outlet per night, so a clash releases it.
    let attachedOrderId: string | undefined;
    let existingOrderId: string | undefined;
    const taken = (outletId: string) =>
      db.orders.find((o) => o.mine && o.dropId !== "past" && o.outletId === outletId && (o.status === "held" || o.status === "paid"));
    for (const hold of db.orders.filter((o) => o.status === "held" && !o.mine && o.customerLabel === "")) {
      const clash = taken(hold.outletId);
      if (clash) {
        hold.status = "expired";
        returnStock(db, hold.dropId);
        existingOrderId = clash.id;
      } else {
        hold.mine = true;
        hold.customerLabel = name ?? "Customer";
        attachedOrderId = hold.id;
      }
    }
    save(db);
    return { user: db.user, attachedOrderId, existingOrderId };
  },

  async logout() {
    await wait();
    const db = load();
    db.user = null;
    db.profile = null;
    save(db);
  },

  async reserve(dropId) {
    await wait();
    const db = load();
    const now = Date.now();
    const drop = dropRow(db, dropId);
    if (db.user) {
      const clash = db.orders.find(
        (o) => o.mine && o.dropId !== "past" && o.outletId === drop.outletId && (o.status === "held" || o.status === "paid"),
      );
      if (clash) fail("already_ordered", "You already have an order at this outlet tonight", 409, { existingOrderId: clash.id });
    } else {
      const hold = db.orders.find((o) => o.status === "held" && !o.mine && o.customerLabel === "");
      if (hold) fail("hold_exists", "You already have a bag on hold", 409, { existingOrderId: hold.id });
    }
    if (drop.losesRace) {
      drop.remaining = 0;
      drop.losesRace = false;
      save(db);
    }
    if (drop.status !== "live" || new Date(drop.salesEndAt).getTime() <= now) fail("not_on_sale", "This bag is not on sale", 409);
    if (drop.remaining <= 0) fail("sold_out", "Sold out for tonight", 409);
    drop.remaining -= 1;
    const number = db.nextNumber++;
    const row: OrderRow = {
      id: `order-${number}`,
      number: `SJ-${number}`,
      status: "held",
      dropId: drop.id,
      outletId: drop.outletId,
      mine: !!db.user,
      customerLabel: db.user ? (db.user.name ?? "Customer") : "",
      name: drop.name,
      foodCategory: drop.foodCategory,
      type: drop.type,
      diet: drop.diet,
      allergens: drop.allergens,
      pricePaise: drop.pricePaise,
      valuePaise: drop.valuePaise,
      pickupCode: null,
      pickupStartAt: drop.pickupStartAt,
      pickupEndAt: drop.pickupEndAt,
      holdExpiresAt: new Date(now + HOLD_SECONDS * 1000).toISOString(),
      collectedAt: null,
      rating: null,
      refund: null,
    };
    db.orders.push(row);
    save(db);
    return orderView(db, row);
  },

  async getOrder(id) {
    await wait();
    const db = load();
    return orderView(db, orderRow(db, id));
  },

  async payOrder(id, body) {
    await wait();
    const db = load();
    requireUser(db);
    if (!body.allergenAck) fail("ack_required", "Please confirm you have read the allergen information", 400);
    const order = orderRow(db, id);
    if (order.status !== "held") fail("hold_expired", "This hold has ended", 409);
    return {
      razorpayOrderId: `order_mock_${order.number}`,
      keyId: "rzp_test_mock",
      amountPaise: order.pricePaise,
      timeoutSeconds: Math.floor((new Date(order.holdExpiresAt).getTime() - Date.now()) / 1000),
    };
  },

  async releaseHold(id) {
    await wait();
    const db = load();
    const order = orderRow(db, id);
    if (order.status === "held") {
      order.status = "expired";
      returnStock(db, order.dropId);
      save(db);
    }
  },

  async getMyOrders(status) {
    await wait();
    const db = load();
    requireUser(db);
    const now = Date.now();
    const active = (o: OrderRow) => (o.status === "held" || o.status === "paid") && new Date(o.pickupEndAt).getTime() > now;
    return db.orders
      .filter((o) => o.mine && (status === "active" ? active(o) : !active(o)))
      .sort((a, b) => b.number.localeCompare(a.number))
      .map((o) => orderView(db, o));
  },

  async rateOrder(id, stars) {
    await wait();
    const db = load();
    const order = orderRow(db, id);
    if (order.rating) fail("already_rated", "This order has already been rated", 409);
    order.rating = stars;
    save(db);
  },

  async reportIssue() {
    await wait();
  },

  async uploadIssuePhoto(file) {
    await wait();
    return `issues/${file.name}`;
  },

  async getProfile() {
    await wait();
    const db = load();
    requireUser(db);
    return db.profile!;
  },

  async updateProfile(patch) {
    await wait();
    const db = load();
    requireUser(db);
    db.profile = { ...db.profile!, ...patch };
    if (patch.name) db.user = { ...db.user!, name: patch.name };
    save(db);
    return db.profile;
  },

  async deleteAccount() {
    await wait();
    const db = load();
    if (db.orders.some((o) => o.mine && (o.status === "held" || o.status === "paid"))) {
      fail("active_order", "Finish or cancel your active order first", 409);
    }
    db.user = null;
    db.profile = null;
    db.orders = db.orders.filter((o) => !o.mine);
    save(db);
  },

  async getFollowing() {
    await wait();
    const db = load();
    requireUser(db);
    return db.following.map((id) => {
      const o = outletOf(db, id);
      return {
        outletId: o.id,
        brandName: o.brandName,
        brandSlug: o.brandSlug,
        branchName: o.branchName,
        outletSlug: o.slug,
        category: o.category,
        status: o.status,
        city: o.city,
      };
    });
  },

  async follow(outletId) {
    await wait();
    const db = load();
    if (!db.following.includes(outletId)) db.following.unshift(outletId);
    save(db);
  },

  async unfollow(outletId) {
    await wait();
    const db = load();
    db.following = db.following.filter((id) => id !== outletId);
    save(db);
  },

  // ---------- Vendor onboarding ----------

  async startOutlet(body) {
    await wait();
    const db = load();
    const user = requireUser(db);
    const brandName = body.brandName ?? "Your brand";
    const id = nextId(db, "outlet");
    const row = outlet("Indiranagar", brandName, body.category as OutletCategory, "", "", null, {
      id,
      branchName: body.branchName,
      slug: slug(body.branchName),
      address: null,
      pincode: null,
      areaId: null,
      mapsUrl: null,
      openingHours: null,
      pickupInstructions: null,
      fssaiNumber: null,
      fssaiExpiresOn: null,
      status: "draft",
      onboardingStep: 2,
      ownerPhone: user.phone,
    });
    db.outlets.push(row);
    save(db);
    return publicVendorOutlet(row);
  },

  async saveOutlet(id, patch) {
    await wait();
    const db = load();
    const row = outletOf(db, id);
    const { step, ...fields } = patch;
    Object.assign(row, fields);
    if (step) row.onboardingStep = step;
    if (patch.areaId) {
      for (const city of CITIES) {
        const area = city.areas.find((name) => slug(name) === patch.areaId);
        if (area) {
          row.area = area;
          row.city = city.slug;
        }
      }
    }
    save(db);
    return publicVendorOutlet(row);
  },

  async uploadFile(file, purpose) {
    await wait();
    return `${purpose}/${file.name}`;
  },

  async addDocument(outletId, body) {
    await wait();
    const db = load();
    const accountDoc = body.kind === "pan" || body.kind === "bank_proof";
    for (const old of db.documents) {
      const same = accountDoc ? old.payoutAccountId === body.payoutAccountId : old.outletId === outletId;
      if (same && old.kind === body.kind && old.status === "rejected") old.status = "replaced";
    }
    db.documents.push({
      id: nextId(db, "doc"),
      outletId: accountDoc ? null : outletId,
      payoutAccountId: accountDoc ? (body.payoutAccountId ?? null) : null,
      kind: body.kind,
      status: "pending",
      rejectionReason: null,
      createdAt: new Date().toISOString(),
      url: photo("#f0ece6", "#d6cfc6"),
    });
    save(db);
  },

  async createPayoutAccount(body) {
    await wait();
    const db = load();
    const row: AccountRow = {
      id: nextId(db, "account"),
      brandId: body.brandId,
      legalName: body.legalName,
      holderName: body.holderName,
      panLast4: body.pan.slice(-4),
      accountLast4: body.accountNumber.slice(-4),
      ifsc: body.ifsc,
      agreed: false,
    };
    db.accounts.push(row);
    save(db);
    return { id: row.id, brandId: row.brandId, legalName: row.legalName, panLast4: row.panLast4, holderName: row.holderName, accountLast4: row.accountLast4, ifsc: row.ifsc, status: "pending" };
  },

  async signAgreement(accountId) {
    await wait();
    const db = load();
    const account = db.accounts.find((a) => a.id === accountId) ?? fail("not_found", "Payout account not found", 404);
    account.agreed = true;
    save(db);
  },

  async submitOutlet(id) {
    await wait();
    const db = load();
    const row = outletOf(db, id);
    if (row.status !== "draft" && row.status !== "changes_needed") fail("not_submittable", "This outlet was already submitted", 409);
    const fixes = checks(db, row).map(({ code, message }) => ({ code, message }));
    if (fixes.length > 0) fail("incomplete", "Some details are still missing", 422, { fixes });
    row.status = "in_review";
    row.submittedAt = new Date().toISOString();
    save(db);
    return publicVendorOutlet(row);
  },

  async getOutletStatus(id) {
    await wait();
    const db = load();
    const row = outletOf(db, id);
    const found = checks(db, row);
    return {
      status: row.status,
      steps: (["details", "licence", "payout", "agreement", "listing"] as const).map((key) => ({
        key,
        done: !found.some((f) => f.step === key),
      })),
      fixes: found.map(({ code, message }) => ({ code, message })),
    };
  },

  // ---------- Vendor daily use ----------

  async getVendorOutlets() {
    await wait();
    const db = load();
    return mineOutlets(db).map(publicVendorOutlet);
  },

  async getListings(outletId) {
    await wait();
    return load().listings.filter((l) => l.outletId === outletId && !l.archivedAt);
  },

  async createListing(outletId, body) {
    await wait();
    const db = load();
    const row: Listing = { photoKey: null, ...body, id: nextId(db, "listing"), outletId, archivedAt: null };
    db.listings.push(row);
    save(db);
    return row;
  },

  async updateListing(id, patch) {
    await wait();
    const db = load();
    const row = listingRow(db, id);
    Object.assign(row, patch);
    save(db);
    return row;
  },

  async archiveListing(id) {
    await wait();
    const db = load();
    listingRow(db, id).archivedAt = new Date().toISOString();
    save(db);
  },

  async copyListing(id, targetOutletId) {
    await wait();
    const db = load();
    const row: Listing = { ...listingRow(db, id), id: nextId(db, "listing"), outletId: targetOutletId };
    db.listings.push(row);
    save(db);
    return row;
  },

  async getToday(outletId) {
    await wait();
    const db = load();
    const drops = db.drops.filter((d) => d.outletId === outletId);
    const counted = drops.filter((d) => d.status !== "cancelled");
    const quantity = counted.reduce((n, d) => n + d.quantity, 0);
    const reserved = counted.reduce((n, d) => n + d.quantity - d.remaining, 0);
    return {
      serviceDate: db.day,
      drops: drops.map(vendorDropView),
      totals: { drops: counted.length, quantity, reserved, remaining: quantity - reserved },
    };
  },

  async publishDrop(listingId, quantity) {
    await wait();
    const db = load();
    const listing = listingRow(db, listingId);
    const existing = db.drops.find((d) => d.listingId === listingId);
    if (existing) {
      existing.remaining += quantity - existing.quantity;
      existing.quantity = quantity;
      save(db);
      return vendorDropView(existing);
    }
    const start = new Date(`${db.day}T${listing.pickupStart}:00+05:30`).getTime();
    const end = new Date(`${db.day}T${listing.pickupEnd}:00+05:30`).getTime();
    const row: DropRow = {
      id: nextId(db, "drop"),
      listingId,
      outletId: listing.outletId,
      status: "live",
      name: listing.name,
      description: listing.description,
      type: listing.type,
      foodCategory: listing.foodCategory,
      diet: listing.diet,
      allergens: listing.allergens,
      valuePaise: listing.valuePaise,
      pricePaise: listing.pricePaise,
      quantity,
      remaining: quantity,
      photoUrl: null,
      pickupStartAt: new Date(start).toISOString(),
      pickupEndAt: new Date(end).toISOString(),
      salesEndAt: new Date(end - 15 * MINUTE).toISOString(),
    };
    db.drops.push(row);
    save(db);
    return vendorDropView(row);
  },

  async updateDrop(id, patch) {
    await wait();
    const db = load();
    const drop = dropRow(db, id);
    if (patch.status) drop.status = patch.status;
    if (patch.quantity !== undefined) {
      const reserved = drop.quantity - drop.remaining;
      if (patch.quantity < reserved) fail("below_reserved", `Quantity cannot go below the ${reserved} already reserved`, 409);
      drop.quantity = patch.quantity;
      drop.remaining = patch.quantity - reserved;
    }
    save(db);
    return vendorDropView(drop);
  },

  async cancelDrop(id) {
    await wait();
    const db = load();
    const drop = dropRow(db, id);
    drop.status = "cancelled";
    for (const order of db.orders.filter((o) => o.dropId === id && o.status === "paid")) cancelPaid(db, order);
    save(db);
  },

  async getVendorOrders(outletId, params = {}) {
    await wait();
    const db = load();
    const q = params.q?.trim().toLowerCase();
    return db.orders
      .filter((o) => o.outletId === outletId && o.dropId !== "past")
      .filter((o) => o.status === "paid" || o.status === "collected" || o.status === "no_show")
      .filter((o) => !q || o.customerLabel.toLowerCase().includes(q))
      .map(
        (o): VendorOrder => ({
          id: o.id,
          number: o.number,
          status: o.status as VendorOrder["status"],
          customerLabel: o.customerLabel || "Customer",
          dropName: o.name,
          pricePaise: o.pricePaise,
          pickupStartAt: o.pickupStartAt,
          pickupEndAt: o.pickupEndAt,
          collectedAt: o.collectedAt ?? null,
        }),
      );
  },

  async collectByCode(outletId, code) {
    await wait();
    const db = load();
    const order =
      db.orders.find((o) => o.outletId === outletId && o.pickupCode === code.trim().toUpperCase()) ??
      fail("code_not_found", "No order with that code", 404);
    collect(db, order);
    save(db);
    return orderView(db, order);
  },

  async collectOrder(id) {
    await wait();
    const db = load();
    const order = orderRow(db, id);
    collect(db, order);
    save(db);
    return orderView(db, order);
  },

  async markNoShow(id) {
    await wait();
    const db = load();
    orderRow(db, id).status = "no_show";
    save(db);
  },

  async cancelOrder(id) {
    await wait();
    const db = load();
    cancelPaid(db, orderRow(db, id));
    save(db);
  },

  async getEarnings() {
    await wait();
    const db = load();
    const gross = 834200;
    const commission = 166800;
    const fees = 16700;
    return {
      payouts: db.payouts,
      thisWeek: {
        orders: 54,
        grossPaise: gross,
        commissionPaise: commission,
        feesPaise: fees,
        taxPaise: 0,
        adjustmentPaise: 0,
        netPaise: gross - commission - fees,
      },
    };
  },

  async getStatementCsv(payoutId) {
    await wait();
    const payout = load().payouts.find((p) => p.id === payoutId) ?? fail("forbidden", "Not allowed", 403);
    return `order,date,outlet,gross,commission,fee,tax,net\nSJ-20100,${payout.periodEnd},Indiranagar,149.00,29.80,2.98,0.00,116.22\n`;
  },

  // ---------- Admin ----------

  async getApplications() {
    await wait();
    const db = load();
    requireAdmin(db);
    return db.outlets
      .filter((o) => o.status === "in_review")
      .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))
      .map((o): Application => {
        const account = db.accounts.find((a) => a.id === o.payoutAccountId);
        return {
          outlet: publicVendorOutlet(o) as Application["outlet"],
          brand: { id: o.brandId, name: o.brandName },
          payoutAccount: account
            ? {
                id: account.id,
                legalName: account.legalName,
                panLast4: account.panLast4,
                holderName: account.holderName,
                accountLast4: account.accountLast4,
                ifsc: account.ifsc,
                status: "pending",
              }
            : null,
          documents: db.documents.filter(
            (d) => d.status !== "replaced" && (d.outletId === o.id || (!!account && d.payoutAccountId === account.id)),
          ),
          warnings: [],
        };
      });
  },

  async reviewDocument(id, body) {
    await wait();
    const db = load();
    requireAdmin(db);
    const doc = db.documents.find((d) => d.id === id) ?? fail("not_found", "Document not found", 404);
    if (doc.status !== "pending") fail("invalid_state", "That change is not allowed from the current status", 409);
    if (!body.approve && !body.reason) fail("invalid_request", "Say why the document was rejected", 400);
    doc.status = body.approve ? "approved" : "rejected";
    doc.rejectionReason = body.approve ? null : (body.reason ?? null);
    if (!body.approve) {
      for (const o of db.outlets) {
        const depends = o.id === doc.outletId || (!!doc.payoutAccountId && o.payoutAccountId === doc.payoutAccountId);
        if (depends && o.status === "in_review") o.status = "changes_needed";
      }
    }
    save(db);
  },

  async decideOutlet(id, body) {
    await wait();
    const db = load();
    requireAdmin(db);
    const row = outletOf(db, id);
    if (row.status !== "in_review") fail("invalid_state", "That change is not allowed from the current status", 409);
    if (body.decision === "approve") {
      const pending = db.documents.filter(
        (d) => (d.outletId === id || d.payoutAccountId === row.payoutAccountId) && d.status === "pending",
      );
      if (pending.length > 0) {
        fail("documents_pending", "Some required documents are not approved yet", 409, {
          fixes: pending.map((d) => ({ code: `${d.kind}_document_pending`, message: `The ${d.kind} has not been reviewed` })),
        });
      }
      row.status = "live";
    } else {
      row.status = "changes_needed";
    }
    save(db);
  },
};

// Payment isn't connected yet: capture stands in for Razorpay and its webhook.
export const mockControls = { capture };

export type MockControls = typeof mockControls;
