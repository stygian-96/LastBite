import { ApiError } from "./errors";
import type {
  City,
  Drop,
  DropDetail,
  DropFilters,
  IssueReason,
  Me,
  MePatch,
  Order,
  OutletPage,
  OutletSummary,
  PayInfo,
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
  verifyOtp(phone: string, code: string): Promise<Me>;
  logout(): Promise<void>;

  // Customer
  reserve(dropId: string): Promise<Order>;
  getOrder(id: string): Promise<Order>;
  payOrder(id: string, body: { allergen_ack: true }): Promise<PayInfo>;
  releaseHold(id: string): Promise<void>;
  getMyOrders(status: OrdersFilter): Promise<Order[]>;
  rateOrder(id: string, rating: number): Promise<void>;
  reportIssue(id: string, body: { reason: IssueReason; description?: string }): Promise<void>;
  getMe(): Promise<Me>;
  updateMe(patch: MePatch): Promise<Me>;
  deleteMe(): Promise<void>;
  getFollowing(): Promise<OutletSummary[]>;
  follow(outletId: string): Promise<void>;
  unfollow(outletId: string): Promise<void>;
};

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(err?.code ?? "unknown", err?.message ?? "Something went wrong. Try again.", res.status);
  }
  return json as T;
}

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const httpApi: Api = {
  getCities: () => request("GET", "/cities"),
  getDrops: (filters) => request("GET", `/drops${query(filters)}`),
  getDrop: (id) => request("GET", `/drops/${id}`),
  getOutlet: (brandSlug, outletSlug) => request("GET", `/outlets/${brandSlug}/${outletSlug}`),

  sendOtp: (phone) => request("POST", "/auth/otp/send", { phone }),
  verifyOtp: (phone, code) => request("POST", "/auth/otp/verify", { phone, code }),
  logout: () => request("POST", "/auth/logout"),

  reserve: (dropId) => request("POST", "/orders", { drop_id: dropId }),
  getOrder: (id) => request("GET", `/orders/${id}`),
  payOrder: (id, body) => request("POST", `/orders/${id}/pay`, body),
  releaseHold: (id) => request("DELETE", `/orders/${id}/hold`),
  getMyOrders: (status) => request("GET", `/me/orders${query({ status })}`),
  rateOrder: (id, rating) => request("POST", `/orders/${id}/rating`, { rating }),
  reportIssue: (id, body) => request("POST", `/orders/${id}/issues`, body),
  getMe: () => request("GET", "/me"),
  updateMe: (patch) => request("PATCH", "/me", patch),
  deleteMe: () => request("DELETE", "/me"),
  getFollowing: () => request("GET", "/me/following"),
  follow: (outletId) => request("PUT", `/outlets/${outletId}/follow`),
  unfollow: (outletId) => request("DELETE", `/outlets/${outletId}/follow`),
};
