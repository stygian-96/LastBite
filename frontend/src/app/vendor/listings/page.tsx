"use client";

import { useState } from "react";
import { FormError } from "@/components/forms";
import { Illo, illoFor } from "@/components/Illo";
import { ErrorState, LinkButton, Sheet, Skeleton } from "@/components/ui";
import { VendorShell } from "@/components/vendor";
import { api, errorMessage, type Listing, type VendorOutlet } from "@/lib/api";
import { rupees, timeRange } from "@/lib/format";
import { useQuery } from "@/lib/hooks";

const DAYS = [
  [1, "M", "Monday"],
  [2, "T", "Tuesday"],
  [3, "W", "Wednesday"],
  [4, "T", "Thursday"],
  [5, "F", "Friday"],
  [6, "S", "Saturday"],
  [7, "S", "Sunday"],
] as const;

function hhmmRange(start: string, end: string) {
  const iso = (value: string) => `2026-01-01T${value.slice(0, 5)}:00+05:30`;
  return timeRange(iso(start), iso(end));
}

function Row({ listing, outlets, onChanged }: { listing: Listing; outlets: VendorOutlet[]; onChanged: () => void }) {
  const [days, setDays] = useState(listing.repeatDays);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(day: number) {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
    const before = days;
    setDays(next);
    setError(null);
    try {
      await api.updateListing(listing.id, { repeatDays: next });
    } catch (err) {
      setDays(before);
      setError(errorMessage(err));
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const duplicate = () => {
    if (outlets.length > 1) setCopying(true);
    else run(() => api.copyListing(listing.id, listing.outletId));
  };

  const pill = "flex h-11 flex-1 items-center justify-center rounded-full bg-fill text-sm font-medium no-underline";

  return (
    <section className="flex flex-col gap-3 rounded-[22px] p-4 shadow-card">
      <div className="flex items-center gap-3">
        <span className="flex size-14 flex-none items-center justify-center rounded-[14px] bg-fill-2">
          <Illo kind={illoFor(listing.foodCategory)} size={44} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">{listing.name}</span>
          <span className="tabular text-xs text-muted">
            {listing.type === "surprise_bag" ? "Surprise Bag" : "Fixed box"} · {rupees(listing.pricePaise)} · worth {rupees(listing.valuePaise)}
          </span>
          <span className="tabular text-xs text-muted">Pickup {hhmmRange(listing.pickupStart, listing.pickupEnd)}</span>
        </span>
      </div>
      <div role="group" aria-label="Repeats on" className="flex justify-between gap-1">
        {DAYS.map(([day, letter, full]) => {
          const on = days.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              aria-label={full}
              onClick={() => toggle(day)}
              className={`flex size-10 items-center justify-center rounded-full text-[13px] font-medium ${on ? "bg-dark text-white" : "bg-[#f0f0f0] text-muted"}`}
            >
              {letter}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <LinkButton href={`/vendor/listings/${listing.id}`} variant="quiet" size="md" className="flex-1">
          Edit
        </LinkButton>
        <button type="button" onClick={duplicate} className={pill}>
          Duplicate
        </button>
        <button type="button" onClick={() => run(() => api.archiveListing(listing.id))} className={`${pill} text-danger`}>
          Remove
        </button>
      </div>
      <FormError message={error} />
      {copying && (
        <Sheet title="Copy to which outlet?" onClose={() => setCopying(false)}>
          {outlets.map((outlet) => (
            <button
              key={outlet.id}
              type="button"
              onClick={() => {
                setCopying(false);
                run(() => api.copyListing(listing.id, outlet.id));
              }}
              className="flex min-h-[52px] items-center border-b border-[#f0f0f0] text-left text-[15px]"
            >
              {outlet.branchName}
            </button>
          ))}
        </Sheet>
      )}
    </section>
  );
}

function List({ outlet, outlets }: { outlet: VendorOutlet; outlets: VendorOutlet[] }) {
  const listings = useQuery(() => api.getListings(outlet.id), [outlet.id]);
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-muted">What you sell and which days it repeats</span>
        <LinkButton href="/vendor/listings/new" size="md" className="flex-none">
          New listing
        </LinkButton>
      </div>
      {listings.loading ? (
        <Skeleton className="h-44 rounded-[22px]" />
      ) : listings.error ? (
        <ErrorState message={errorMessage(listings.error)} onRetry={listings.reload} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {listings.data!.map((listing) => (
            <Row key={listing.id} listing={listing} outlets={outlets} onChanged={listings.reload} />
          ))}
        </div>
      )}
      <span className="text-xs text-muted">Set tonight’s quantities on Today.</span>
    </>
  );
}

export default function VendorListings() {
  return <VendorShell title="Listings">{(outlet, outlets) => <List key={outlet.id} outlet={outlet} outlets={outlets} />}</VendorShell>;
}
