"use client";

import { useState } from "react";
import { FormError, Stepper } from "@/components/forms";
import { ErrorState, LinkButton, Skeleton, Switch } from "@/components/ui";
import { CancelSheet, OrderList, useTonightOrders, VendorShell } from "@/components/vendor";
import { api, errorMessage, type Listing, type VendorDrop, type VendorOutlet } from "@/lib/api";
import { rupees, shortDate, timeRange } from "@/lib/format";
import { useQuery } from "@/lib/hooks";

function hhmmRange(start: string, end: string) {
  const iso = (value: string) => `2026-01-01T${value.slice(0, 5)}:00+05:30`;
  return timeRange(iso(start), iso(end));
}

function ListingRow({ listing, drop, onChanged }: { listing: Listing; drop?: VendorDrop; onChanged: () => void }) {
  const [draft, setDraft] = useState(listing.defaultQuantity);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelled = drop?.status === "cancelled";
  const live = drop?.status === "live";
  const sold = drop?.reservedCount ?? 0;
  const quantity = drop ? drop.quantity : draft;
  const left = Math.max(0, quantity - sold);
  const window = drop ? timeRange(drop.pickupStartAt, drop.pickupEndAt) : hhmmRange(listing.pickupStart, listing.pickupEnd);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const setLive = (on: boolean) => {
    if (!drop) return run(() => api.publishDrop(listing.id, draft));
    return run(() => api.updateDrop(drop.id, { status: on ? "live" : "paused" }));
  };

  return (
    <section className={`flex flex-col gap-3 rounded-[22px] p-4 shadow-card ${live ? "" : "opacity-90"}`}>
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">{listing.name}</span>
          <span className="tabular text-xs text-muted">
            {rupees(drop?.pricePaise ?? listing.pricePaise)} · pickup {window}
          </span>
        </span>
        {cancelled && <span className="text-xs font-medium text-danger">Cancelled</span>}
      </div>
      {!cancelled && (
        <>
          <Switch on={!!live} onChange={setLive} label={live ? "Live" : drop ? "Paused" : "Not listed tonight"} hint={drop ? undefined : "Turn on to publish"} />
          <Stepper
            value={quantity}
            min={Math.max(1, sold)}
            onChange={(value) => (drop ? run(() => api.updateDrop(drop.id, { quantity: value })) : setDraft(value))}
          >
            <span className="text-xs text-muted">available tonight</span>
          </Stepper>
          {drop && (
            <div className="flex flex-col gap-1.5">
              <span className="tabular text-xs text-muted">
                {sold} sold · {left} left
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-line">
                <span className="block h-full rounded-full bg-coral" style={{ width: `${quantity ? Math.round((sold / quantity) * 100) : 0}%` }} />
              </span>
              <button type="button" disabled={busy} onClick={() => setCancelling(true)} className="min-h-9 self-start text-xs text-danger underline">
                Cancel tonight and refund everyone
              </button>
            </div>
          )}
        </>
      )}
      <FormError message={error} />
      {cancelling && drop && (
        <CancelSheet
          title={`Cancel ${listing.name} tonight?`}
          body={`Everyone who paid (${sold}) gets a full refund automatically and a WhatsApp message. Pick a reason:`}
          onConfirm={async (reason) => {
            await api.cancelDrop(drop.id, reason);
            onChanged();
          }}
          onClose={() => setCancelling(false)}
        />
      )}
    </section>
  );
}

function Tonight({ outlet }: { outlet: VendorOutlet }) {
  const listings = useQuery(() => api.getListings(outlet.id), [outlet.id]);
  const today = useQuery(() => api.getToday(outlet.id), [outlet.id]);
  const orders = useTonightOrders(outlet.id);

  if (listings.loading || today.loading) {
    return (
      <>
        <Skeleton className="h-24 rounded-[22px]" />
        <Skeleton className="h-52 rounded-[22px]" />
      </>
    );
  }
  if (listings.error || today.error) {
    return <ErrorState message={errorMessage(listings.error ?? today.error)} onRetry={today.reload} />;
  }

  const list = orders.data ?? [];
  const revenue = list.reduce((sum, order) => sum + order.pricePaise, 0);
  const toCollect = list.filter((order) => order.status === "paid").length;
  const refresh = () => {
    today.reload();
    orders.reload();
  };

  return (
    <>
      <span className="text-[13px] text-muted">How many tonight? · {shortDate(`${today.data!.serviceDate}T12:00:00+05:30`)}</span>
      <section className="grid grid-cols-3 gap-2 rounded-[22px] bg-dark p-4 text-white">
        {[
          [String(today.data!.totals.reserved), "sold"],
          [rupees(revenue), "tonight so far"],
          [String(toCollect), "to collect"],
        ].map(([value, label]) => (
          <span key={label} className="flex flex-col">
            <span className="tabular text-2xl font-black">{value}</span>
            <span className="text-xs text-dark-sub">{label}</span>
          </span>
        ))}
      </section>

      {listings.data!.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-[18px] bg-fill p-4 text-[13px] text-muted">
          Add a listing to start selling.
          <LinkButton href="/vendor/listings/new" size="md">
            New listing
          </LinkButton>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {listings.data!.map((listing) => (
            <ListingRow key={listing.id} listing={listing} drop={today.data!.drops.find((d) => d.listingId === listing.id)} onChanged={refresh} />
          ))}
        </div>
      )}
      <span className="text-xs text-muted">Changes go live instantly. You can’t go below what’s already sold.</span>

      <section className="hidden flex-col gap-2 lg:flex">
        <h2 className="text-lg font-medium">Tonight’s orders</h2>
        <OrderList orders={list} onChanged={refresh} />
      </section>
    </>
  );
}

export default function VendorToday() {
  return <VendorShell title="Today">{(outlet) => <Tonight key={outlet.id} outlet={outlet} />}</VendorShell>;
}
