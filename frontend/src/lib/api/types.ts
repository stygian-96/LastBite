// Response shapes from the backend on main. JSON is camelCase, money is integer paise,
// dates are ISO strings. Fields marked "fix pass" are promised but not on main yet, and
// optional fields are ones the frontend wants but no route returns. See API-GAPS.md.

export type FoodCategory = "bakery" | "cafe" | "meals" | "desserts";
export type OutletCategory = "bakery" | "cafe" | "restaurant" | "sweets" | "kitchen";
export type Diet = "veg" | "egg" | "nonveg" | "mixed";
export type ListingType = "surprise_bag" | "fixed_box";
export type OrderStatus = "held" | "expired" | "paid" | "collected" | "no_show" | "cancelled";
export type OutletStatus = "draft" | "in_review" | "changes_needed" | "live" | "suspended" | "closed";

export type Area = { id: string; name: string };
export type City = { slug: string; name: string; areas: Area[] };

export type Drop = {
  id: string;
  name: string;
  type: ListingType;
  diet: Diet;
  pricePaise: number;
  valuePaise: number;
  remaining: number;
  pickupStartAt: string;
  pickupEndAt: string;
  brandName: string;
  branchName: string;
  area: string | null;
  photoUrl: string | null;
  foodCategory: FoodCategory;
  // Fix pass
  outletId: string;
  city: string;
  brandSlug: string;
  outletSlug: string;
  salesEndAt: string;
};

export type DropDetail = Drop & {
  description: string;
  allergens: string[];
  pickupInstructions: string | null;
  address: string | null;
  mapsUrl: string | null;
  fssaiNumber: string | null;
  rating: number | null;
};

export type DropFilters = {
  city: string;
  area?: string; // area name
  category?: FoodCategory;
  veg?: boolean;
  pickup_by?: string; // "21:00", IST
  max_price?: number; // paise
  q?: string;
};

export type OpeningHours = Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", string[][]>>;

export type OutletPage = {
  outletId: string; // fix pass
  brandName: string;
  brandSlug: string;
  branchName: string;
  outletSlug: string;
  city: string | null;
  area: string | null;
  category: OutletCategory;
  address: string | null;
  mapsUrl: string | null;
  pickupInstructions: string | null;
  openingHours: OpeningHours | null;
  fssaiNumber: string | null;
  photoUrls: string[];
  rating: number | null;
  drops: Drop[];
};

export type Refund = { status: "pending" | "processed" | "failed"; amountPaise: number };

export type Order = {
  id: string;
  number: string; // "SJ-20481"
  status: OrderStatus;
  pricePaise: number;
  valuePaise: number;
  name: string;
  type: ListingType;
  diet: Diet;
  allergens: string[];
  brandName: string;
  branchName: string;
  address: string | null;
  mapsUrl: string | null;
  pickupInstructions: string | null;
  pickupStartAt: string;
  pickupEndAt: string;
  holdExpiresAt: string;
  pickupCode: string | null;
  refund: Refund | null;
  // Not returned yet. Screens work without them.
  foodCategory?: FoodCategory;
  city?: string;
  brandSlug?: string;
  outletSlug?: string;
  collectedAt?: string | null;
  rating?: number | null;
};

export type PayInfo = {
  razorpayOrderId: string;
  amountPaise: number;
  keyId: string;
  timeoutSeconds: number;
};

export type Profile = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  whatsappOptIn: boolean;
  marketingOptIn: boolean;
  impact: { bagsCollected: number; moneySavedPaise: number };
};

export type ProfilePatch = Partial<Pick<Profile, "name" | "email" | "whatsappOptIn" | "marketingOptIn">>;

export type SignedInUser = { id: string; phone: string; name: string | null; isAdmin: boolean };

export type VerifyResult = {
  user: SignedInUser;
  attachedOrderId?: string;
  existingOrderId?: string;
};

export type FollowedOutlet = {
  outletId: string;
  brandName: string;
  brandSlug: string;
  branchName: string;
  outletSlug: string;
  category: OutletCategory;
  status: OutletStatus;
  city?: string;
};

export type IssueReason = "bag_not_ready" | "quality" | "allergen" | "code_rejected" | "other";

// ---------- Vendor ----------

export type VendorOutlet = {
  id: string;
  brandId: string;
  payoutAccountId: string | null;
  areaId: string | null;
  branchName: string;
  slug: string;
  category: OutletCategory;
  address: string | null;
  pincode: string | null;
  mapsUrl: string | null;
  contactPhone: string | null;
  pickupInstructions: string | null;
  openingHours: OpeningHours | null;
  photoKeys: string[];
  fssaiNumber: string | null;
  fssaiExpiresOn: string | null;
  gstin: string | null;
  commissionBps: number;
  status: OutletStatus;
  onboardingStep: number;
  pausedUntil: string | null;
  brandName?: string; // not returned yet
};

export type OutletPatch = Partial<
  Pick<
    VendorOutlet,
    "branchName" | "category" | "photoKeys"
  > & {
    step: number;
    address: string;
    pincode: string;
    areaId: string;
    mapsUrl: string;
    contactPhone: string;
    pickupInstructions: string;
    openingHours: OpeningHours;
    fssaiNumber: string;
    fssaiExpiresOn: string;
    gstin: string;
    payoutAccountId: string;
  }
>;

export type Fix = { code: string; message: string };

export type OutletStatusView = {
  status: OutletStatus;
  steps: { key: "details" | "licence" | "payout" | "agreement" | "listing"; done: boolean }[];
  fixes: Fix[];
};

export type DocumentKind = "fssai" | "gst" | "pan" | "bank_proof";
export type UploadPurpose = "photo" | "logo" | "document";

export type PayoutAccountInput = {
  legalName: string;
  pan: string;
  holderName: string;
  accountNumber: string;
  ifsc: string;
};

export type PayoutAccount = {
  id: string;
  brandId: string;
  legalName: string;
  panLast4: string;
  holderName: string;
  accountLast4: string;
  ifsc: string;
  status: "pending" | "verified" | "rejected" | "on_hold";
};

export type Listing = {
  id: string;
  outletId: string;
  type: ListingType;
  name: string;
  description: string;
  foodCategory: FoodCategory;
  diet: Diet;
  allergens: string[];
  valuePaise: number;
  pricePaise: number;
  defaultQuantity: number;
  pickupStart: string; // "20:30"
  pickupEnd: string;
  repeatDays: number[]; // 1 = Monday ... 7 = Sunday
  photoKey: string | null;
  archivedAt: string | null;
};

export type ListingInput = Omit<Listing, "id" | "outletId" | "archivedAt" | "photoKey"> & { photoKey?: string | null };

export type VendorDrop = {
  id: string;
  listingId: string;
  outletId: string;
  serviceDate: string;
  quantity: number;
  reservedCount: number;
  status: "live" | "paused" | "cancelled";
  name: string;
  pricePaise: number;
  valuePaise: number;
  pickupStartAt: string;
  pickupEndAt: string;
};

export type Today = {
  serviceDate: string;
  drops: VendorDrop[];
  totals: { drops: number; quantity: number; reserved: number; remaining: number };
};

export type VendorOrder = {
  id: string;
  number: string;
  status: "paid" | "collected" | "no_show";
  customerLabel: string;
  dropName: string;
  pricePaise: number;
  pickupStartAt: string;
  pickupEndAt: string;
  collectedAt: string | null;
};

export type CancelReason = "ran_out" | "quality" | "closing_early";

export type Payout = {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossPaise: number;
  commissionPaise: number;
  feesPaise: number;
  taxPaise: number;
  adjustmentPaise: number;
  netPaise: number;
  status: "draft" | "held" | "released" | "paid";
  paidAt: string | null;
};

export type Earnings = {
  payouts: Payout[];
  thisWeek: {
    orders: number;
    grossPaise: number;
    commissionPaise: number;
    feesPaise: number;
    taxPaise: number;
    adjustmentPaise: number;
    netPaise: number;
  };
};

// ---------- Admin ----------

export type ReviewedDocument = {
  id: string;
  outletId: string | null;
  payoutAccountId: string | null;
  kind: DocumentKind;
  status: "pending" | "approved" | "rejected" | "replaced";
  rejectionReason: string | null;
  createdAt: string;
  url: string;
};

export type Application = {
  outlet: VendorOutlet & { submittedAt: string | null; createdAt: string };
  brand: { id: string; name: string };
  payoutAccount: Omit<PayoutAccount, "brandId"> | null;
  documents: ReviewedDocument[];
  warnings: { code: string; message: string; outletIds: string[] }[];
};

export type OutletDecision = "approve" | "request_changes" | "suspend" | "reinstate" | "close";
