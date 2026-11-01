// Response shapes for the API in docs/backend-implementation.md section 8.
// The spec lists routes but not bodies, so these follow its column names.
// Anything assumed beyond the columns is listed in API-GAPS.md.

export type CityId = "bengaluru" | "hyderabad";
export type FoodCategory = "bakery" | "cafe" | "meals" | "desserts";
export type OutletCategory = "bakery" | "cafe" | "restaurant" | "sweets" | "kitchen";
export type Diet = "veg" | "egg" | "nonveg" | "mixed";
export type ListingType = "surprise_bag" | "fixed_box";
export type OrderStatus = "held" | "expired" | "paid" | "collected" | "no_show" | "cancelled";

export type Area = { id: string; name: string };
export type City = { id: CityId; name: string; areas: Area[] };

export type OutletSummary = {
  id: string;
  brand_name: string;
  brand_slug: string;
  branch_name: string;
  slug: string;
  city: CityId;
  area_name: string;
  category: OutletCategory;
  rating_avg: number | null;
  rating_count: number;
};

export type OutletPickupInfo = OutletSummary & {
  address: string;
  pincode: string;
  maps_url: string;
  pickup_instructions: string;
  fssai_number: string;
};

export type Drop = {
  id: string;
  listing_id: string;
  outlet: OutletSummary;
  status: "live" | "paused" | "cancelled";
  name: string;
  description: string;
  type: ListingType;
  food_category: FoodCategory;
  diet: Diet;
  allergens: string[];
  value_paise: number;
  price_paise: number;
  quantity: number;
  reserved_count: number;
  photo_urls: string[];
  pickup_start_at: string;
  pickup_end_at: string;
  sales_end_at: string;
};

export type DropDetail = Omit<Drop, "outlet"> & { outlet: OutletPickupInfo };

export type DropFilters = {
  city: CityId;
  area?: string;
  category?: FoodCategory;
  veg?: boolean;
  pickup_by?: string; // "21:00", IST
  max_price?: number; // paise
  q?: string;
};

export type OutletPage = OutletPickupInfo & {
  opening_hours_today: string | null;
  following: boolean;
  drops: Drop[];
};

export type Refund = {
  id: string;
  amount_paise: number;
  status: "pending" | "processed" | "failed";
  created_at: string;
  processed_at: string | null;
};

export type Order = {
  id: string;
  number: number;
  status: OrderStatus;
  drop_id: string;
  outlet: OutletPickupInfo;
  name: string;
  food_category: FoodCategory;
  type: ListingType;
  diet: Diet;
  allergens: string[];
  price_paise: number;
  value_paise: number;
  pickup_code: string | null;
  pickup_start_at: string;
  pickup_end_at: string;
  hold_expires_at: string;
  paid_at: string | null;
  collected_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  payment_method: string | null;
  rating: number | null;
  refund: Refund | null;
  created_at: string;
};

export type PayInfo = {
  razorpay_order_id: string;
  key_id: string;
  amount_paise: number;
  currency: "INR";
  timeout_seconds: number;
};

export type Me = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  is_admin: boolean;
  whatsapp_opt_in: boolean;
  marketing_opt_in: boolean;
  created_at: string;
  bags_rescued: number;
  saved_paise: number;
};

export type MePatch = Partial<Pick<Me, "name" | "email" | "whatsapp_opt_in" | "marketing_opt_in">>;

export type IssueReason = "bag_not_ready" | "quality" | "allergen" | "code_rejected" | "other";
