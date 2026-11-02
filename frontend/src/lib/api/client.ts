import { ApiError } from "./errors";
import type {
  Application,
  CancelReason,
  City,
  DocumentKind,
  Drop,
  DropDetail,
  DropFilters,
  Earnings,
  FollowedOutlet,
  IssueReason,
  Listing,
  ListingInput,
  Order,
  OutletDecision,
  OutletPage,
  OutletPatch,
  OutletStatusView,
  PayInfo,
  PayoutAccount,
  PayoutAccountInput,
  Profile,
  ProfilePatch,
  Today,
  UploadPurpose,
  VendorDrop,
  VendorOrder,
  VendorOutlet,
  VerifyResult,
} from "./types";

export type OrdersFilter = "active" | "past";

// Every backend call in the site goes through this interface.
export type Api = {
  // Public
  getCities(): Promise<City[]>;
  getDrops(filters: DropFilters): Promise<Drop[]>;
  getDrop(id: string): Promise<DropDetail>;
  getOutlet(brandSlug: string, outletSlug: string): Promise<OutletPage>;

  // Auth
  sendOtp(phone: string): Promise<void>;
  verifyOtp(phone: string, code: string): Promise<VerifyResult>;
  logout(): Promise<void>;

  // Customer
  reserve(dropId: string): Promise<Order>;
  getOrder(id: string): Promise<Order>;
  payOrder(id: string, body: { allergenAck: true }): Promise<PayInfo>;
  releaseHold(id: string): Promise<void>;
  getMyOrders(status: OrdersFilter): Promise<Order[]>;
  rateOrder(id: string, stars: number): Promise<void>;
  reportIssue(id: string, body: { reason: IssueReason; description?: string; photoKey?: string }): Promise<void>;
  uploadIssuePhoto(file: File): Promise<string>;
  getProfile(): Promise<Profile>;
  updateProfile(patch: ProfilePatch): Promise<Profile>;
  deleteAccount(): Promise<void>;
  getFollowing(): Promise<FollowedOutlet[]>;
  follow(outletId: string): Promise<void>;
  unfollow(outletId: string): Promise<void>;

  // Vendor onboarding
  startOutlet(body: {
    brandName?: string;
    brandId?: string;
    branchName: string;
    category: string;
  }): Promise<VendorOutlet>;
  saveOutlet(id: string, patch: OutletPatch): Promise<VendorOutlet>;
  uploadFile(file: File, purpose: UploadPurpose): Promise<string>;
  addDocument(outletId: string, body: { kind: DocumentKind; fileKey: string; payoutAccountId?: string }): Promise<void>;
  createPayoutAccount(body: PayoutAccountInput & { brandId: string }): Promise<PayoutAccount>;
  signAgreement(accountId: string, body: { signedName: string; version: string }): Promise<void>;
  submitOutlet(id: string): Promise<VendorOutlet>;
  getOutletStatus(id: string): Promise<OutletStatusView>;

  // Vendor daily use
  getVendorOutlets(): Promise<VendorOutlet[]>;
  getListings(outletId: string): Promise<Listing[]>;
  createListing(outletId: string, body: ListingInput): Promise<Listing>;
  updateListing(id: string, patch: Partial<ListingInput>): Promise<Listing>;
  archiveListing(id: string): Promise<void>;
  copyListing(id: string, targetOutletId: string): Promise<Listing>;
  getToday(outletId: string): Promise<Today>;
  publishDrop(listingId: string, quantity: number): Promise<VendorDrop>;
  updateDrop(id: string, patch: { quantity?: number; status?: "live" | "paused" }): Promise<VendorDrop>;
  cancelDrop(id: string, reason: CancelReason): Promise<void>;
  getVendorOrders(outletId: string, params?: { date?: string; q?: string }): Promise<VendorOrder[]>;
  collectByCode(outletId: string, code: string): Promise<Order>;
  collectOrder(id: string): Promise<Order>;
  markNoShow(id: string): Promise<void>;
  cancelOrder(id: string, reason: CancelReason): Promise<void>;
  getEarnings(payoutAccountId: string): Promise<Earnings>;
  getStatementCsv(payoutId: string): Promise<string>;

  // Admin
  getApplications(): Promise<Application[]>;
  reviewDocument(id: string, body: { approve: boolean; reason?: string }): Promise<void>;
  decideOutlet(id: string, body: { decision: OutletDecision; reason?: string }): Promise<void>;
};

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", "We can’t reach the server. Check your connection.");
  }
  if (res.ok) return res;
  const json = await res.json().catch(() => null);
  const { code, message, ...details } = json?.error ?? {};
  throw new ApiError(code ?? "unknown", message ?? "Something went wrong. Try again.", res.status, details);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  return (await res.json()) as T;
}

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// Signed links are made for the file's exact size, so the body must be the file as it is.
async function putFile(url: string, file: File) {
  // The backend's local fake store hands out links on this host, which take no file.
  if (new URL(url).hostname === "fake-storage.test") return;
  try {
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
    if (res.ok) return;
  } catch {
    // Falls through to the same message.
  }
  throw new ApiError("upload_failed", "That upload didn’t work. Try again.");
}

type Ticket = { key: string; url: string };

export const httpApi: Api = {
  getCities: async () => (await request<{ cities: City[] }>("GET", "/cities")).cities,
  getDrops: async (filters) => (await request<{ drops: Drop[] }>("GET", `/drops${query(filters)}`)).drops,
  getDrop: async (id) => (await request<{ drop: DropDetail }>("GET", `/drops/${id}`)).drop,
  getOutlet: async (brandSlug, outletSlug) =>
    (await request<{ outlet: OutletPage }>("GET", `/outlets/${brandSlug}/${outletSlug}`)).outlet,

  sendOtp: async (phone) => {
    await send("POST", "/auth/otp/send", { phone });
  },
  verifyOtp: (phone, code) => request("POST", "/auth/otp/verify", { phone, code }),
  logout: async () => {
    await send("POST", "/auth/logout");
  },

  reserve: async (dropId) => (await request<{ order: Order }>("POST", "/orders", { dropId })).order,
  getOrder: async (id) => (await request<{ order: Order }>("GET", `/orders/${id}`)).order,
  payOrder: (id, body) => request("POST", `/orders/${id}/pay`, body),
  releaseHold: async (id) => {
    await send("DELETE", `/orders/${id}/hold`);
  },
  getMyOrders: async (status) => (await request<{ orders: Order[] }>("GET", `/me/orders${query({ status })}`)).orders,
  rateOrder: async (id, stars) => {
    await send("POST", `/orders/${id}/rating`, { stars });
  },
  reportIssue: async (id, body) => {
    await send("POST", `/orders/${id}/issues`, body);
  },
  uploadIssuePhoto: async (file) => {
    const ticket = await request<Ticket>("POST", "/me/uploads", { contentType: file.type, size: file.size });
    await putFile(ticket.url, file);
    return ticket.key;
  },
  getProfile: async () => (await request<{ profile: Profile }>("GET", "/me")).profile,
  updateProfile: async (patch) => (await request<{ profile: Profile }>("PATCH", "/me", patch)).profile,
  deleteAccount: async () => {
    await send("DELETE", "/me");
  },
  getFollowing: async () => (await request<{ following: FollowedOutlet[] }>("GET", "/me/following")).following,
  follow: async (outletId) => {
    await send("PUT", `/outlets/${outletId}/follow`);
  },
  unfollow: async (outletId) => {
    await send("DELETE", `/outlets/${outletId}/follow`);
  },

  startOutlet: async (body) => (await request<{ outlet: VendorOutlet }>("POST", "/vendor/outlets", body)).outlet,
  saveOutlet: async (id, patch) => (await request<{ outlet: VendorOutlet }>("PATCH", `/vendor/outlets/${id}`, patch)).outlet,
  uploadFile: async (file, purpose) => {
    const ticket = await request<Ticket>("POST", "/vendor/uploads", { contentType: file.type, size: file.size, purpose });
    await putFile(ticket.url, file);
    return ticket.key;
  },
  addDocument: async (outletId, body) => {
    await send("POST", `/vendor/outlets/${outletId}/documents`, body);
  },
  createPayoutAccount: async (body) =>
    (await request<{ payoutAccount: PayoutAccount }>("POST", "/vendor/payout-accounts", body)).payoutAccount,
  signAgreement: async (accountId, body) => {
    await send("POST", `/vendor/payout-accounts/${accountId}/agreement`, body);
  },
  submitOutlet: async (id) => (await request<{ outlet: VendorOutlet }>("POST", `/vendor/outlets/${id}/submit`)).outlet,
  getOutletStatus: (id) => request("GET", `/vendor/outlets/${id}/status`),

  getVendorOutlets: async () => (await request<{ outlets: VendorOutlet[] }>("GET", "/vendor/outlets")).outlets,
  getListings: async (outletId) =>
    (await request<{ listings: Listing[] }>("GET", `/vendor/outlets/${outletId}/listings`)).listings,
  createListing: async (outletId, body) =>
    (await request<{ listing: Listing }>("POST", `/vendor/outlets/${outletId}/listings`, body)).listing,
  updateListing: async (id, patch) => (await request<{ listing: Listing }>("PATCH", `/vendor/listings/${id}`, patch)).listing,
  archiveListing: async (id) => {
    await send("DELETE", `/vendor/listings/${id}`);
  },
  copyListing: async (id, targetOutletId) =>
    (await request<{ listing: Listing }>("POST", `/vendor/listings/${id}/copy`, { targetOutletId })).listing,
  getToday: async (outletId) => (await request<{ today: Today }>("GET", `/vendor/outlets/${outletId}/today`)).today,
  publishDrop: async (listingId, quantity) =>
    (await request<{ drop: VendorDrop }>("PUT", `/vendor/listings/${listingId}/drops/today`, { quantity })).drop,
  updateDrop: async (id, patch) => (await request<{ drop: VendorDrop }>("PATCH", `/vendor/drops/${id}`, patch)).drop,
  cancelDrop: async (id, reason) => {
    await send("POST", `/vendor/drops/${id}/cancel`, { reason });
  },
  getVendorOrders: async (outletId, params = {}) =>
    (await request<{ orders: VendorOrder[] }>("GET", `/vendor/outlets/${outletId}/orders${query(params)}`)).orders,
  collectByCode: (outletId, code) => request("POST", `/vendor/outlets/${outletId}/collect`, { code }),
  collectOrder: (id) => request("POST", `/vendor/orders/${id}/collect`),
  markNoShow: async (id) => {
    await send("POST", `/vendor/orders/${id}/no-show`);
  },
  cancelOrder: async (id, reason) => {
    await send("POST", `/vendor/orders/${id}/cancel`, { reason });
  },
  getEarnings: (payoutAccountId) => request("GET", `/vendor/earnings${query({ payout_account: payoutAccountId })}`),
  getStatementCsv: async (payoutId) => (await send("GET", `/vendor/payouts/${payoutId}/statement`)).text(),

  getApplications: async () => (await request<{ applications: Application[] }>("GET", "/admin/applications")).applications,
  reviewDocument: async (id, body) => {
    await send("POST", `/admin/documents/${id}/review`, body);
  },
  decideOutlet: async (id, body) => {
    await send("POST", `/admin/outlets/${id}/decision`, body);
  },
};
