"use client";

import Link from "next/link";
import { useState } from "react";
import { Choice, FormError, TextArea } from "@/components/forms";
import { Button, Chip, ErrorState, Skeleton, StatusChip } from "@/components/ui";
import {
  api,
  errorMessage,
  type AdminInventoryRow,
  type AdminOrderCounts,
  type AdminVendor,
  type AdminVendorDetail,
  type Listing,
  type OutletStatus,
} from "@/lib/api";
import { phoneDisplay, rupees, shortDate, timeRange } from "@/lib/format";
import { useDebounced, useHashTab, useNow, useQuery } from "@/lib/hooks";

const OUTLET_STATUS: Record<OutletStatus, { label: string; tone: "ok" | "warn" | "wait" | "info" }> = {
  live: { label: "Active", tone: "ok" },
  suspended: { label: "Inactive", tone: "warn" },
  in_review: { label: "Under review", tone: "wait" },
  changes_needed: { label: "Changes needed", tone: "wait" },
  draft: { label: "Draft", tone: "info" },
  closed: { label: "Closed", tone: "info" },
};

const ACTION = "min-h-10 rounded-full border border-[#dddddd] px-3.5 text-[13px] font-medium disabled:text-muted";
const POLL_MS = 30_000;
const vendorHref = (outletId: string) => `/admin/vendors/${outletId}`;
/** A YYYY-MM-DD date as "Thu 12 Nov". shortDate wants an instant, so give it midday IST. */
const day = (date: string) => shortDate(`${date}T12:00:00+05:30`);

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((n) => (
        <Skeleton key={n} className="h-20 rounded-2xl" />
      ))}
    </div>
  );
}

/** Make active / Make inactive, with the confirmation and reason for going inactive. */
function ActiveToggle({ outletId, status, onChanged }: { outletId: string; status: OutletStatus; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "suspend" | "reinstate") {
    setBusy(true);
    setError(null);
    try {
      await api.decideOutlet(outletId, {
        decision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setConfirming(false);
      setReason("");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (status !== "live" && status !== "suspended") return null;
  return (
    <div className="flex flex-col gap-2.5">
      {status === "live" && !confirming && (
        <button type="button" className={`${ACTION} self-start`} onClick={() => setConfirming(true)}>
          Make inactive
        </button>
      )}
      {status === "suspended" && (
        <button type="button" className={`${ACTION} self-start`} disabled={busy} onClick={() => decide("reinstate")}>
          {busy ? "Making active…" : "Make active"}
        </button>
      )}
      {confirming && (
        <div className="flex flex-col gap-2.5 rounded-2xl border-[1.5px] border-coral p-3">
          <p className="text-[13px] leading-normal text-muted">
            Customers won&rsquo;t see this outlet and it can&rsquo;t put bags on sale. Orders already paid for tonight can still be picked up.
          </p>
          <TextArea id={`reason-${outletId}`} label="Reason (for the audit log)" value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="md" variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Keep active
            </Button>
            <Button size="md" variant="dark" disabled={busy} onClick={() => decide("suspend")}>
              {busy ? "Making inactive…" : "Make inactive"}
            </Button>
          </div>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}

// ---------- Vendors ----------

type VendorFilter = "all" | "live" | "suspended";

function VendorRow({ row, onChanged }: { row: AdminVendor; onChanged: () => void }) {
  const { outlet, brand, area, tonight } = row;
  const status = OUTLET_STATUS[outlet.status];
  return (
    <li className="flex flex-col gap-2.5 rounded-2xl border-[1.5px] border-line p-3.5">
      <Link href={vendorHref(outlet.id)} className="flex flex-wrap items-start gap-3 text-ink no-underline">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-[15px] font-medium">
            {brand.name} <span className="font-normal text-muted">· {outlet.branchName}</span>
          </strong>
          <span className="text-xs text-muted">
            {[area ? `${area.name}, ${area.city}` : null, outlet.category, row.ownerPhone ? `owner ${phoneDisplay(row.ownerPhone)}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="text-xs text-muted">
            Tonight:{" "}
            {tonight.drops === 0
              ? "nothing on sale"
              : `${tonight.drops} item${tonight.drops > 1 ? "s" : ""} · ${tonight.reserved} of ${tonight.quantity} bags reserved`}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
          <span aria-hidden className="text-muted">
            ›
          </span>
        </span>
      </Link>
      <ActiveToggle outletId={outlet.id} status={outlet.status} onChanged={onChanged} />
    </li>
  );
}

const INPUT = "h-11 w-full rounded-full border-none bg-fill px-4 text-[15px] text-ink placeholder:text-faint";

function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`${INPUT} min-w-0 flex-1`}
    />
  );
}

/** Every launch area, grouped by city. Empty means all areas. */
function AreaSelect({ value, onChange }: { value: string; onChange: (areaId: string) => void }) {
  const cities = useQuery(() => api.getCities(), []);
  return (
    <select aria-label="Area" value={value} onChange={(event) => onChange(event.target.value)} className={`${INPUT} flex-none pr-8 sm:w-56`}>
      <option value="">All areas</option>
      {cities.data?.map((city) => (
        <optgroup key={city.slug} label={city.name}>
          {city.areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

const VENDOR_PAGE = 50;

export function VendorsView() {
  const [filter, setFilter] = useState<VendorFilter>("all");
  const [q, setQ] = useState("");
  const [areaId, setAreaId] = useState("");
  const [pages, setPages] = useState(1);
  const search = useDebounced(q.trim());
  // Every page shown is fetched again on reload, so a change made further down the list shows up.
  const vendors = useQuery(async () => {
    const params = {
      status: filter === "all" ? undefined : filter,
      q: search || undefined,
      areaId: areaId || undefined,
    };
    const loaded = await Promise.all(Array.from({ length: pages }, (_, i) => api.getVendors({ ...params, offset: i * VENDOR_PAGE })));
    return {
      vendors: loaded.flatMap((page) => page.vendors),
      hasMore: loaded.at(-1)!.hasMore,
    };
  }, [filter, search, areaId, pages]);
  const refilter =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPages(1);
    };

  return (
    <section aria-label="Vendors" className="flex min-w-0 flex-1 flex-col gap-3.5 p-4 lg:p-6">
      <h1 className="text-2xl font-bold">Vendors</h1>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SearchBox label="Search brand, branch or phone" value={q} onChange={refilter(setQ)} />
        <AreaSelect value={areaId} onChange={refilter(setAreaId)} />
      </div>
      <div className="flex gap-1.5">
        {(
          [
            ["all", "All"],
            ["live", "Active"],
            ["suspended", "Inactive"],
          ] as const
        ).map(([id, label]) => (
          <Chip key={id} on={filter === id} onClick={() => refilter(setFilter)(id)}>
            {label}
          </Chip>
        ))}
      </div>
      {vendors.error && !vendors.data ? (
        <ErrorState message={errorMessage(vendors.error)} onRetry={vendors.reload} />
      ) : !vendors.data ? (
        <ListSkeleton />
      ) : vendors.data.vendors.length === 0 ? (
        <p className="py-4 text-sm text-muted">No vendors match.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {vendors.data.vendors.map((row) => (
              <VendorRow key={row.outlet.id} row={row} onChanged={vendors.reload} />
            ))}
          </ul>
          {vendors.data.hasMore && (
            <Button size="md" variant="quiet" className="self-center" onClick={() => setPages(pages + 1)}>
              Show more vendors
            </Button>
          )}
        </>
      )}
    </section>
  );
}

// ---------- Tonight's items ----------

type DropFilter = "all" | "selling" | "sold_out" | "paused" | "cancelled";

const DROP_STATUS = {
  selling: { label: "On sale", tone: "ok" as const },
  sold_out: { label: "Sold out", tone: "info" as const },
  paused: { label: "Paused", tone: "wait" as const },
  cancelled: { label: "Cancelled", tone: "warn" as const },
  closed: { label: "Sales closed", tone: "info" as const },
  hidden: { label: "Outlet inactive", tone: "warn" as const },
};

function dropState(row: AdminInventoryRow, now: number): keyof typeof DROP_STATUS {
  const { drop } = row;
  if (drop.status === "cancelled") return "cancelled";
  if (row.outlet.status !== "live") return "hidden";
  if (drop.status === "paused") return "paused";
  if (drop.reservedCount >= drop.quantity) return "sold_out";
  if (new Date(drop.salesEndAt).getTime() <= now) return "closed";
  return "selling";
}

function Numbers({ items }: { items: [string, string | number][] }) {
  return (
    <dl className="grid grid-cols-3 gap-2 rounded-xl bg-fill p-2.5 text-center text-xs sm:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-muted">{label}</dt>
          <dd className="text-[15px] font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One item on sale tonight: the bag, its numbers, and pause, resume or cancel. */
function ItemRow({ row, now, onChanged }: { row: AdminInventoryRow; now: number; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [chargedTo, setChargedTo] = useState<"vendor" | "platform">("vendor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { drop, orders } = row;
  const state = dropState(row, now);
  const ended = new Date(drop.pickupEndAt).getTime() <= now;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setCancelling(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`flex flex-col gap-2.5 rounded-2xl border-[1.5px] bg-white p-3 ${cancelling ? "border-coral" : "border-line"}`}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-[15px] font-medium">{drop.name}</strong>
          <span className="text-xs text-muted">
            {rupees(drop.pricePaise)} a bag · pickup {timeRange(drop.pickupStartAt, drop.pickupEndAt)}
          </span>
        </span>
        <StatusChip tone={DROP_STATUS[state].tone}>{DROP_STATUS[state].label}</StatusChip>
      </div>

      <Numbers
        items={[
          ["Bags", drop.quantity],
          ["Reserved", drop.reservedCount],
          ["Left", Math.max(drop.quantity - drop.reservedCount, 0)],
          ["To collect", orders.paid],
          ["Collected", orders.collected],
          ["No-show", orders.noShow],
        ]}
      />

      {drop.status !== "cancelled" && !ended && !cancelling && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={ACTION}
            disabled={busy}
            onClick={() => run(() => api.adminSetDropStatus(drop.id, drop.status === "paused" ? "live" : "paused"))}
          >
            {drop.status === "paused" ? "Resume sales" : "Pause sales"}
          </button>
          <button type="button" className={ACTION} disabled={busy} onClick={() => setCancelling(true)}>
            Cancel item
          </button>
        </div>
      )}

      {cancelling && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[13px] leading-normal text-muted">
            {orders.paid > 0
              ? `${orders.paid} paid order${orders.paid > 1 ? "s" : ""} will be cancelled and refunded in full, and the customers told.`
              : "No paid orders yet. The item comes off sale for tonight."}
          </p>
          <TextArea id={`cancel-${drop.id}`} label="Reason (sent to customers)" value={reason} onChange={(event) => setReason(event.target.value)} />
          {orders.paid > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-muted">Who pays for the refunds</span>
              <div className="grid grid-cols-2 gap-2">
                <Choice on={chargedTo === "vendor"} onClick={() => setChargedTo("vendor")}>
                  Vendor
                </Choice>
                <Choice on={chargedTo === "platform"} onClick={() => setChargedTo("platform")}>
                  LastBite
                </Choice>
              </div>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="md" variant="quiet" disabled={busy} onClick={() => setCancelling(false)}>
              Keep it
            </Button>
            <Button
              size="md"
              variant="dark"
              disabled={busy || !reason.trim()}
              onClick={() =>
                run(() =>
                  api.adminCancelDrop(drop.id, {
                    reason: reason.trim(),
                    chargedTo,
                  }),
                )
              }
            >
              {busy ? "Cancelling…" : orders.paid > 0 ? "Cancel and refund" : "Cancel item"}
            </Button>
          </div>
        </div>
      )}
      <FormError message={error} />
    </li>
  );
}

const DROP_FILTERS = [
  ["all", "All"],
  ["selling", "On sale"],
  ["sold_out", "Sold out"],
  ["paused", "Paused"],
  ["cancelled", "Cancelled"],
] as const;

const matches = (filter: DropFilter, row: AdminInventoryRow, now: number) => {
  if (filter === "all") return true;
  const state = dropState(row, now);
  return filter === "selling" ? state === "selling" || state === "closed" : state === filter;
};

const VENDOR_GROUPS_SHOWN = 30;

export function InventoryView() {
  const [filter, setFilter] = useState<DropFilter>("all");
  const [q, setQ] = useState("");
  const [areaId, setAreaId] = useState("");
  const [shown, setShown] = useState(VENDOR_GROUPS_SHOWN);
  const search = useDebounced(q.trim());
  const inventory = useQuery(() => api.getInventory({ q: search || undefined, areaId: areaId || undefined }), [search, areaId], { pollMs: POLL_MS });
  const now = useNow(POLL_MS) ?? 0;
  const filtered = search || areaId;

  const all = inventory.data?.drops ?? [];
  const counted = all.filter((row) => row.drop.status !== "cancelled");
  const sum = (pick: (row: AdminInventoryRow) => number) => counted.reduce((n, row) => n + pick(row), 0);
  const groups = new Map<string, AdminInventoryRow[]>();
  for (const row of all.filter((r) => matches(filter, r, now))) {
    groups.set(row.outlet.id, [...(groups.get(row.outlet.id) ?? []), row]);
  }

  return (
    <section aria-label="Tonight's inventory" className="flex min-w-0 flex-1 flex-col gap-3.5 p-4 lg:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Tonight&rsquo;s inventory</h1>
        <p className="text-[13px] text-muted">
          Every item vendors have put on sale tonight
          {inventory.data ? ` (${day(inventory.data.serviceDate)})` : ""}, by vendor. Refreshes every 30 seconds.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <SearchBox
          label="Search vendor, branch or item"
          value={q}
          onChange={(value) => {
            setQ(value);
            setShown(VENDOR_GROUPS_SHOWN);
          }}
        />
        <AreaSelect
          value={areaId}
          onChange={(value) => {
            setAreaId(value);
            setShown(VENDOR_GROUPS_SHOWN);
          }}
        />
      </div>

      {inventory.data && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              [filtered ? "Vendors matching" : "Vendors selling", new Set(counted.map((row) => row.outlet.id)).size],
              ["Bags put up", sum((row) => row.drop.quantity)],
              ["Reserved", sum((row) => row.drop.reservedCount)],
              ["Collected", sum((row) => row.orders.collected)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5 rounded-2xl bg-fill p-3">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="text-xl font-bold">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex gap-1.5 overflow-x-auto">
        {DROP_FILTERS.map(([id, label]) => (
          <Chip key={id} on={filter === id} onClick={() => setFilter(id)}>
            {label}
          </Chip>
        ))}
      </div>

      {inventory.error && !inventory.data ? (
        <ErrorState message={errorMessage(inventory.error)} onRetry={inventory.reload} />
      ) : !inventory.data ? (
        <ListSkeleton />
      ) : groups.size === 0 ? (
        <p className="py-4 text-sm text-muted">Nothing here tonight.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {[...groups.values()].slice(0, shown).map((rows) => {
              const { outlet, brand, area } = rows[0]!;
              return (
                <li key={outlet.id} className="flex flex-col gap-2 rounded-[20px] bg-fill p-2.5">
                  <Link href={vendorHref(outlet.id)} className="flex items-center gap-2 px-1.5 pt-1 text-ink no-underline">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <strong className="text-sm font-medium">
                        {brand.name} <span className="font-normal text-muted">· {outlet.branchName}</span>
                      </strong>
                      {area && <span className="text-xs text-muted">{area.name}</span>}
                    </span>
                    {outlet.status !== "live" && <StatusChip tone={OUTLET_STATUS[outlet.status].tone}>{OUTLET_STATUS[outlet.status].label}</StatusChip>}
                    <span className="text-xs text-muted">Vendor details ›</span>
                  </Link>
                  <ul className="flex flex-col gap-2">
                    {rows.map((row) => (
                      <ItemRow key={row.drop.id} row={row} now={now} onChanged={inventory.reload} />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          {groups.size > shown && (
            <Button size="md" variant="quiet" className="self-center" onClick={() => setShown(shown + VENDOR_GROUPS_SHOWN)}>
              Show more vendors ({groups.size - shown} left)
            </Button>
          )}
        </>
      )}
    </section>
  );
}

// ---------- One vendor ----------

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hhmm = (t: string) => t.slice(0, 5);

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-[13px]">{children || "—"}</span>
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl bg-fill p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xl font-bold">{value}</dd>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

function ListingCard({ listing }: { listing: Listing }) {
  const days =
    listing.repeatDays.length === 7 ? "Every day" : listing.repeatDays.length ? listing.repeatDays.map((d) => DAY_NAMES[d - 1]).join(", ") : "Not repeating";
  return (
    <li className={`flex flex-col gap-1 rounded-2xl border-[1.5px] border-line p-3 ${listing.archivedAt ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-2">
        <strong className="flex-1 text-sm font-medium">{listing.name}</strong>
        {listing.archivedAt && <StatusChip tone="info">Archived</StatusChip>}
      </div>
      <span className="text-xs text-muted">
        {listing.type === "surprise_bag" ? "Surprise bag" : "Fixed box"} · {listing.diet} · {rupees(listing.pricePaise)} (worth {rupees(listing.valuePaise)})
      </span>
      <span className="text-xs text-muted">
        {listing.defaultQuantity} bags usually · pickup {hhmm(listing.pickupStart)}–{hhmm(listing.pickupEnd)} · {days}
      </span>
    </li>
  );
}

function OverviewTab({ vendor }: { vendor: AdminVendorDetail }) {
  const { outlet, details, stats, tonight } = vendor;
  const activeListings = vendor.listings.filter((l) => !l.archivedAt).length;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Orders, last 30 days" value={stats.orders30d} />
        <Stat label="Cancelled" value={`${Math.round(stats.cancellationRate * 100)}%`} hint={`${stats.cancelled30d} of ${stats.orders30d} orders`} />
        <Stat
          label="Tonight"
          value={`${tonight.reserved}/${tonight.quantity}`}
          hint={tonight.drops ? `bags reserved, ${tonight.drops} item${tonight.drops > 1 ? "s" : ""}` : "nothing on sale"}
        />
        <Stat label="Active listings" value={activeListings} />
      </dl>
      <div className="grid grid-cols-2 gap-3 rounded-2xl bg-fill p-3.5 lg:grid-cols-4">
        <Fact label="Owner">{vendor.ownerPhone && phoneDisplay(vendor.ownerPhone)}</Fact>
        <Fact label="Outlet phone">{outlet.contactPhone && phoneDisplay(outlet.contactPhone)}</Fact>
        <Fact label="Address">{details.address && `${details.address} ${details.pincode ?? ""}`}</Fact>
        <Fact label="Maps">
          {details.mapsUrl && (
            <a href={details.mapsUrl} target="_blank" rel="noreferrer">
              Open in Google Maps
            </a>
          )}
        </Fact>
        <Fact label="FSSAI">{details.fssaiNumber && `${details.fssaiNumber}${details.fssaiExpiresOn ? ` · to ${day(details.fssaiExpiresOn)}` : ""}`}</Fact>
        <Fact label="GSTIN">{details.gstin}</Fact>
        <Fact label="Commission">{`${details.commissionBps / 100}%`}</Fact>
        <Fact label="On LastBite since">{shortDate(outlet.createdAt)}</Fact>
      </div>
      {details.pickupInstructions && (
        <div className="rounded-2xl bg-fill p-3.5">
          <Fact label="Pickup instructions">{details.pickupInstructions}</Fact>
        </div>
      )}
    </div>
  );
}

function TonightTab({ vendor, onChanged }: { vendor: AdminVendorDetail; onChanged: () => void }) {
  const now = useNow(POLL_MS) ?? 0;
  if (vendor.tonightDrops.length === 0) return <p className="text-sm text-muted">Nothing on sale tonight.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {vendor.tonightDrops.map((row) => (
        <ItemRow key={row.drop.id} row={row} now={now} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function ListingsTab({ listings }: { listings: Listing[] }) {
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = listings.filter((l) => !!l.archivedAt === archived && (!needle || `${l.name} ${l.description}`.toLowerCase().includes(needle)));
  const archivedCount = listings.filter((l) => l.archivedAt).length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">The items this vendor has set up. They put some of these on sale each night.</p>
      <SearchBox label="Search listings" value={q} onChange={setQ} />
      <div className="flex gap-1.5">
        <Chip on={!archived} onClick={() => setArchived(false)}>
          Active ({listings.length - archivedCount})
        </Chip>
        <Chip on={archived} onClick={() => setArchived(true)}>
          Archived ({archivedCount})
        </Chip>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{needle ? "No listings match." : archived ? "Nothing archived." : "No active listings."}</p>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {shown.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </ul>
      )}
    </div>
  );
}

const HISTORY_PAGE = 30;
const sold = (o: AdminOrderCounts) => o.paid + o.collected + o.noShow;

function HistoryTab({ outletId }: { outletId: string }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [shown, setShown] = useState(HISTORY_PAGE);
  const [q, setQ] = useState("");
  const history = useQuery(() => api.getVendorHistory(outletId, days), [outletId, days]);
  const needle = q.trim().toLowerCase();
  // The summary follows the search, so "how did the cake box do this month" is one search away.
  const rows = (history.data?.drops ?? []).filter((r) => !needle || r.drop.name.toLowerCase().includes(needle));
  const total = (pick: (o: AdminOrderCounts) => number) => rows.reduce((n, r) => n + pick(r.orders), 0);
  const bagsSold = total(sold);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        {([7, 30, 90] as const).map((d) => (
          <Chip
            key={d}
            on={days === d}
            onClick={() => {
              setDays(d);
              setShown(HISTORY_PAGE);
            }}
          >
            Last {d} nights
          </Chip>
        ))}
      </div>
      <SearchBox
        label="Search items in this history"
        value={q}
        onChange={(value) => {
          setQ(value);
          setShown(HISTORY_PAGE);
        }}
      />

      {history.error ? (
        <ErrorState message={errorMessage(history.error)} onRetry={history.reload} />
      ) : !history.data ? (
        <ListSkeleton />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat label="Nights selling" value={new Set(rows.map((r) => r.drop.serviceDate)).size} hint={`of the last ${history.data.days}`} />
            <Stat label="Bags sold" value={bagsSold} hint={`of ${rows.reduce((n, r) => n + r.drop.quantity, 0)} put up`} />
            <Stat label="Sales" value={rupees(total((o) => o.soldPaise))} />
            <Stat
              label="No-shows"
              value={bagsSold ? `${Math.round((total((o) => o.noShow) / bagsSold) * 100)}%` : "—"}
              hint={`${total((o) => o.cancelled)} cancelled`}
            />
          </dl>

          {rows.length === 0 ? (
            <p className="text-sm text-muted">{needle ? "No items match in these nights." : "Nothing put on sale in these nights."}</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border-[1.5px] border-line">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead className="bg-fill text-xs text-muted">
                  <tr>
                    {["Night", "Item", "Put up", "Sold", "Collected", "No-show", "Cancelled", "Sales"].map((h, i) => (
                      <th key={h} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${i > 1 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shown).map(({ drop, orders }, i) => {
                    const newNight = i === 0 || rows[i - 1]!.drop.serviceDate !== drop.serviceDate;
                    return (
                      <tr key={drop.id} className={newNight && i > 0 ? "border-t border-line" : ""}>
                        <td className="whitespace-nowrap px-3 py-2 text-muted">{newNight ? day(drop.serviceDate) : ""}</td>
                        <td className="px-3 py-2">
                          {drop.name}
                          {drop.status === "cancelled" && <span className="ml-1.5 text-xs text-danger">cancelled</span>}
                        </td>
                        <td className="px-3 py-2 text-right">{drop.quantity}</td>
                        <td className="px-3 py-2 text-right font-medium">{sold(orders)}</td>
                        <td className="px-3 py-2 text-right">{orders.collected}</td>
                        <td className="px-3 py-2 text-right">{orders.noShow}</td>
                        <td className="px-3 py-2 text-right">{orders.cancelled}</td>
                        <td className="px-3 py-2 text-right">{rupees(orders.soldPaise)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > shown && (
            <Button size="md" variant="quiet" className="self-center" onClick={() => setShown(shown + HISTORY_PAGE)}>
              Show more ({rows.length - shown} left)
            </Button>
          )}
        </>
      )}
    </div>
  );
}

const VENDOR_TABS = ["overview", "tonight", "listings", "history"] as const;
type VendorTab = (typeof VENDOR_TABS)[number];

export function VendorDetailView({ vendor, onChanged }: { vendor: AdminVendorDetail; onChanged: () => void }) {
  const { outlet, brand, area } = vendor;
  const status = OUTLET_STATUS[outlet.status];
  const [tab, setTab] = useHashTab<VendorTab>(VENDOR_TABS, "overview");
  const tabs: { id: VendorTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    {
      id: "tonight",
      label: `Tonight${vendor.tonightDrops.length ? ` (${vendor.tonightDrops.length})` : ""}`,
    },
    { id: "listings", label: "Listings" },
    { id: "history", label: "History" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold">{brand.name}</h1>
            <span className="text-[13px] text-muted">
              {outlet.branchName} · {outlet.category}
              {area ? ` · ${area.name}, ${area.city}` : ""}
            </span>
          </div>
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
        </div>
        <ActiveToggle outletId={outlet.id} status={outlet.status} onChanged={onChanged} />
      </div>

      <div role="tablist" aria-label="Vendor sections" className="-mx-4 flex gap-5 overflow-x-auto border-b border-line px-4 lg:mx-0 lg:px-0">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px min-h-11 flex-none whitespace-nowrap border-b-2 text-sm font-medium ${tab === id ? "border-ink text-ink" : "border-transparent text-muted"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "overview" && <OverviewTab vendor={vendor} />}
        {tab === "tonight" && <TonightTab vendor={vendor} onChanged={onChanged} />}
        {tab === "listings" && <ListingsTab listings={vendor.listings} />}
        {tab === "history" && <HistoryTab outletId={outlet.id} />}
      </div>
    </div>
  );
}
