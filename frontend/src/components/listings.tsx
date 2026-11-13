"use client";

import { useState } from "react";
import { FormError, ListingForm } from "@/components/forms";
import { Illo, illoFor } from "@/components/Illo";
import { Sheet, StatusChip } from "@/components/ui";
import { api, errorMessage, type Listing, type VendorOutlet } from "@/lib/api";
import { rupees, timeRange } from "@/lib/format";

export const isActive = (listing: Listing) => !listing.archivedAt;

const DAYS = [
  [1, "M", "Monday"],
  [2, "T", "Tuesday"],
  [3, "W", "Wednesday"],
  [4, "T", "Thursday"],
  [5, "F", "Friday"],
  [6, "S", "Saturday"],
  [7, "S", "Sunday"],
] as const;
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function hhmmRange(start: string, end: string) {
  const iso = (value: string) => `2026-01-01T${value.slice(0, 5)}:00+05:30`;
  return timeRange(iso(start), iso(end));
}

function repeatText(days: number[]) {
  if (days.length === 7) return "Every day";
  if (days.length === 0) return "Not repeating";
  if (days.join() === "1,2,3,4,5") return "Weekdays";
  return days.map((d) => SHORT[d - 1]).join(", ");
}

/** A small on/off switch for one listing. */
export function ActiveSwitch({ on, busy, onChange }: { on: boolean; busy?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? "Active, tap to make inactive" : "Inactive, tap to make active"}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
      className={`relative h-7 w-12 flex-none rounded-full disabled:opacity-60 ${on ? "bg-coral" : "bg-[#cfcfcf]"}`}
    >
      <span className={`absolute top-[3px] size-[22px] rounded-full bg-white shadow ${on ? "left-[23px]" : "left-[3px]"}`} />
    </button>
  );
}

/** One listing in the list: what it is, when it repeats, and its on/off switch. */
export function ListingRow({
  listing,
  selected,
  onOpen,
  onToggle,
  busy,
}: {
  listing: Listing;
  selected: boolean;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
  busy: boolean;
}) {
  const active = isActive(listing);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        className={`flex cursor-pointer items-center gap-3 px-3 py-3 ${selected ? "bg-tint" : "hover:bg-fill"}`}
      >
        <span className={`flex size-11 flex-none items-center justify-center rounded-xl bg-fill-2 ${active ? "" : "opacity-50"}`}>
          <Illo kind={illoFor(listing.foodCategory)} size={34} />
        </span>
        <span className={`flex min-w-0 flex-1 flex-col gap-0.5 ${active ? "" : "text-muted"}`}>
          <span className="truncate text-[15px] font-medium">{listing.name}</span>
          <span className="tabular truncate text-xs text-muted">
            {rupees(listing.pricePaise)} · {hhmmRange(listing.pickupStart, listing.pickupEnd)} · {repeatText(listing.repeatDays)}
          </span>
        </span>
        {!active && <StatusChip tone="info">Inactive</StatusChip>}
        <ActiveSwitch on={active} busy={busy} onChange={onToggle} />
      </div>
    </li>
  );
}

/**
 * Everything about one listing, editable in place: on or off, the days it repeats, duplicate, and
 * the full form. Used beside the list on desktop and as its own page on a phone.
 */
export function ListingPanel({
  listing,
  outlets,
  onChanged,
  onCopied,
}: {
  listing: Listing;
  outlets: VendorOutlet[];
  onChanged: (listing: Listing) => void;
  onCopied: (copy: Listing) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = isActive(listing);

  async function run(action: () => Promise<Listing>, then: (l: Listing) => void = onChanged) {
    setBusy(true);
    setError(null);
    try {
      then(await action());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const toggleDay = (day: number) => {
    const days = listing.repeatDays.includes(day) ? listing.repeatDays.filter((d) => d !== day) : [...listing.repeatDays, day].sort();
    void run(() => api.updateListing(listing.id, { repeatDays: days }));
  };
  const duplicate = () => {
    if (outlets.length > 1) setCopying(true);
    else void run(() => api.copyListing(listing.id, listing.outletId), onCopied);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-2xl bg-fill p-3.5">
        <div className="flex items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-[15px] font-medium">{active ? "Active" : "Inactive"}</strong>
            <span className="text-xs leading-snug text-muted">
              {active
                ? "Shows on Today, so you can put it on sale each evening."
                : "Hidden from Today and the evening WhatsApp prompt. Anything already on sale tonight keeps selling."}
            </span>
          </span>
          <ActiveSwitch on={active} busy={busy} onChange={(on) => void run(() => api.updateListing(listing.id, { active: on }))} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted">Repeats on</span>
          <div role="group" aria-label="Repeats on" className="flex justify-between gap-1">
            {DAYS.map(([day, letter, full]) => {
              const on = listing.repeatDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={full}
                  disabled={busy}
                  onClick={() => toggleDay(day)}
                  className={`flex size-10 items-center justify-center rounded-full text-[13px] font-medium ${on ? "bg-dark text-white" : "bg-white text-muted"}`}
                >
                  {letter}
                </button>
              );
            })}
          </div>
        </div>
        <button type="button" disabled={busy} onClick={duplicate} className="min-h-10 self-start rounded-full border border-[#dddddd] bg-white px-3.5 text-[13px] font-medium">
          Duplicate listing
        </button>
        <FormError message={error} />
      </div>

      <ListingForm key={listing.id} outletId={listing.outletId} listing={listing} submitLabel="Save changes" onSaved={onChanged} />

      {copying && (
        <Sheet title="Copy to which outlet?" onClose={() => setCopying(false)}>
          {outlets.map((outlet) => (
            <button
              key={outlet.id}
              type="button"
              onClick={() => {
                setCopying(false);
                void run(() => api.copyListing(listing.id, outlet.id), onCopied);
              }}
              className="flex min-h-[52px] items-center border-b border-[#f0f0f0] text-left text-[15px]"
            >
              {outlet.branchName}
            </button>
          ))}
        </Sheet>
      )}
    </div>
  );
}
