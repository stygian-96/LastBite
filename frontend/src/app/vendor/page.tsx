"use client";

import Link from "next/link";
import { useState } from "react";
import { FormError, Stepper } from "@/components/forms";
import { ErrorState, LinkButton, Skeleton, Switch } from "@/components/ui";
import { ActiveSwitch, hhmmRange, isActive, matchesListing, switchListing } from "@/components/listings";
import { CancelSheet, OrderList, useTonightOrders, VendorSearch, VendorShell } from "@/components/vendor";
import { api, errorMessage, type Listing, type VendorDrop, type VendorOutlet } from "@/lib/api";
import { rupees, shortDate, timeRange } from "@/lib/format";
import { useQuery } from "@/lib/hooks";

/** A drop on sale tonight, or one paused that still has pickups: quantity, sales, pause and cancel. */
function LiveCard({ listing, drop, onChanged }: { listing: Listing; drop: VendorDrop; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = drop.status === "live";
  const sold = drop.reservedCount;
  const left = Math.max(0, drop.quantity - sold);

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

  return (
    <section className={`flex flex-col gap-3 rounded-[22px] p-4 shadow-card ${live ? "" : "opacity-90"}`}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-medium">{listing.name}</span>
        <span className="tabular text-xs text-muted">
          {rupees(drop.pricePaise)} · pickup {timeRange(drop.pickupStartAt, drop.pickupEndAt)}
        </span>
      </span>
      <Switch
        on={live}
        onChange={(on) => run(() => switchListing(listing, on))}
        label={live ? "Live" : "Paused"}
        hint={live ? undefined : `${sold} still to collect. Turn on to sell again`}
      />
      <Stepper value={drop.quantity} min={Math.max(1, sold)} onChange={(value) => run(() => api.updateDrop(drop.id, { quantity: value }))}>
        <span className="text-xs text-muted">available tonight</span>
      </Stepper>
      <div className="flex flex-col gap-1.5">
        <span className="tabular text-xs text-muted">
          {sold} sold · {left} left
        </span>
        <span className="h-1.5 overflow-hidden rounded-full bg-line">
          <span className="block h-full rounded-full bg-coral" style={{ width: `${drop.quantity ? Math.round((sold / drop.quantity) * 100) : 0}%` }} />
        </span>
        <button type="button" disabled={busy} onClick={() => setCancelling(true)} className="min-h-9 self-start text-xs text-danger underline">
          Cancel tonight and refund everyone
        </button>
      </div>
      <FormError message={error} />
      {cancelling && (
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

/** A listing not on sale tonight, with the switch that puts it live. */
function OffRow({ listing, drop, onChanged }: { listing: Listing; drop?: VendorDrop; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cancelled = drop?.status === "cancelled";

  async function turnOn() {
    setBusy(true);
    setNote(null);
    try {
      const result = await switchListing(listing, true);
      setNote(result.note);
      onChanged();
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 px-3 py-3">
      <div className="flex items-center gap-3">
        <span className={`flex min-w-0 flex-1 flex-col gap-0.5 ${isActive(listing) ? "" : "text-muted"}`}>
          <span className="truncate text-[15px] font-medium">{listing.name}</span>
          <span className="tabular truncate text-xs text-muted">
            {rupees(listing.pricePaise)} · pickup {hhmmRange(listing.pickupStart, listing.pickupEnd)} · {listing.defaultQuantity} bags
          </span>
        </span>
        {cancelled ? <span className="text-xs font-medium text-danger">Cancelled tonight</span> : <ActiveSwitch on={false} busy={busy} onChange={turnOn} />}
      </div>
      {note && <p className="text-[13px] text-muted">{note}</p>}
    </li>
  );
}

function Tonight({ outlet }: { outlet: VendorOutlet }) {
  const listings = useQuery(() => api.getListings(outlet.id), [outlet.id]);
  const today = useQuery(() => api.getToday(outlet.id), [outlet.id]);
  const orders = useTonightOrders(outlet.id);
  const [q, setQ] = useState("");

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
  const drops = today.data!.drops;
  const dropFor = (listing: Listing) => drops.find((d) => d.listingId === listing.id);
  // A card while it's on sale, or paused with bags still to hand over; everything else is a row below.
  const onCard = (drop?: VendorDrop) => !!drop && (drop.status === "live" || (drop.status === "paused" && drop.reservedCount > 0));
  const all = listings.data!;
  const found = all.filter((l) => matchesListing(l, q));
  const cards = found.filter((l) => onCard(dropFor(l)));
  const rows = found
    .filter((l) => !onCard(dropFor(l)))
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || a.name.localeCompare(b.name));
  const revenue = list.reduce((sum, order) => sum + order.pricePaise, 0);
  const toCollect = list.filter((order) => order.status === "paid").length;
  const refresh = () => {
    today.reload();
    listings.reload();
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

      {all.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-[18px] bg-fill p-4 text-[13px] text-muted">
          Add a listing to start selling.
          <LinkButton href="/vendor/listings/new" size="md">
            New listing
          </LinkButton>
        </div>
      ) : (
        <>
          <VendorSearch label="Search tonight’s listings" value={q} onChange={setQ} />
          {found.length === 0 && <p className="py-2 text-sm text-muted">No listing matches “{q.trim()}”.</p>}
          {cards.length > 0 && (
            <section aria-label="Tonight" className="flex flex-col gap-2">
              <h2 className="text-[13px] font-medium text-muted">Tonight · {cards.length}</h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {cards.map((listing) => (
                  <LiveCard key={listing.id} listing={listing} drop={dropFor(listing)!} onChanged={refresh} />
                ))}
              </div>
            </section>
          )}
          {cards.length === 0 && found.length > 0 && (
            <p className="rounded-[18px] bg-fill p-4 text-[13px] text-muted">Nothing is live tonight. Switch a listing on below to start selling.</p>
          )}
          {rows.length > 0 && (
            <section aria-label="Not live tonight" className="flex flex-col gap-2">
              <h2 className="text-[13px] font-medium text-muted">Not live tonight · {rows.length}</h2>
              <ul className="divide-y divide-[#f0f0f0] overflow-hidden rounded-[18px] border-[1.5px] border-line">
                {rows.map((listing) => (
                  <OffRow key={listing.id} listing={listing} drop={dropFor(listing)} onChanged={refresh} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <span className="text-xs text-muted">
        Changes go live instantly and match the switch in{" "}
        <Link href="/vendor/listings" className="text-ink underline">
          Listings
        </Link>
        . You can’t go below what’s already sold.
      </span>

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
