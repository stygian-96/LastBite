"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ListingForm } from "@/components/forms";
import { isActive, ListingPanel, ListingRow, matchesListing } from "@/components/listings";
import { Button, Chip, ErrorState, LinkButton, Skeleton } from "@/components/ui";
import { VendorSearch, VendorShell } from "@/components/vendor";
import { api, errorMessage, type Listing, type VendorOutlet } from "@/lib/api";
import { useQuery } from "@/lib/hooks";

const DESKTOP = "(min-width: 1024px)";

// Active first, then by name, so the ones being sold are at the top.
const byActiveThenName = (a: Listing, b: Listing) => Number(isActive(b)) - Number(isActive(a)) || a.name.localeCompare(b.name);

/**
 * The outlet's listings as a list. On desktop the selected one opens beside it, editable in place;
 * on a phone a listing opens on its own page.
 */
function Listings({ outlet, outlets }: { outlet: VendorOutlet; outlets: VendorOutlet[] }) {
  const router = useRouter();
  const listings = useQuery(() => api.getListings(outlet.id), [outlet.id]);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "active" | "inactive">("all");

  if (listings.error && !listings.data) return <ErrorState message={errorMessage(listings.error)} onRetry={listings.reload} />;
  if (!listings.data) return <Skeleton className="h-64 rounded-[22px]" />;

  const all = [...listings.data].sort(byActiveThenName);
  const inactive = all.filter((l) => !isActive(l)).length;
  const found = all.filter((l) => matchesListing(l, q) && (show === "all" || isActive(l) === (show === "active")));
  const current = selected === "new" ? null : (all.find((l) => l.id === selected) ?? all[0] ?? null);
  const showNew = selected === "new" || all.length === 0;

  const open = (id: string) => {
    if (window.matchMedia(DESKTOP).matches) setSelected(id);
    else router.push(`/vendor/listings/${id}`);
  };
  const startNew = () => {
    if (window.matchMedia(DESKTOP).matches) setSelected("new");
    else router.push("/vendor/listings/new");
  };
  const replace = (updated: Listing) => {
    listings.setData(listings.data!.map((l) => (l.id === updated.id ? updated : l)));
  };
  const deleted = (id: string) => {
    listings.setData(listings.data!.filter((l) => l.id !== id));
    setSelected(null);
  };
  const added = (listing: Listing) => {
    listings.setData([...listings.data!, listing]);
    setSelected(listing.id);
  };

  async function toggle(listing: Listing, on: boolean) {
    setToggling(listing.id);
    setError(null);
    try {
      replace(await api.updateListing(listing.id, { active: on }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:items-start">
      <section aria-label="Your listings" className="flex flex-col gap-2.5 lg:sticky lg:top-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-muted">
            {all.length - inactive} active{inactive ? `, ${inactive} inactive` : ""}
          </span>
          <Button size="md" className="flex-none" onClick={startNew}>
            New listing
          </Button>
        </div>
        {all.length > 0 && <VendorSearch label="Search listings" value={q} onChange={setQ} />}
        {all.length > 0 && (
          <div role="group" aria-label="Show" className="flex gap-1.5">
            {(
              [
                ["all", "All", all.length],
                ["active", "Active", all.length - inactive],
                ["inactive", "Inactive", inactive],
              ] as const
            ).map(([id, label, count]) => (
              <Chip key={id} on={show === id} onClick={() => setShow(id)}>
                {label} {count}
              </Chip>
            ))}
          </div>
        )}
        {all.length > 0 && found.length === 0 && (
          <p className="py-2 text-sm text-muted">
            {q.trim() ? `No listing matches “${q.trim()}”.` : show === "inactive" ? "Nothing is switched off." : "Nothing is switched on."}
          </p>
        )}
        {found.length > 0 && (
          <ul className="divide-y divide-[#f0f0f0] overflow-hidden rounded-[18px] border-[1.5px] border-line">
            {found.map((listing) => (
              <ListingRow
                key={listing.id}
                listing={listing}
                selected={selected !== "new" && current?.id === listing.id}
                onOpen={() => open(listing.id)}
                onToggle={(on) => toggle(listing, on)}
                onDeleted={() => deleted(listing.id)}
                busy={toggling === listing.id}
              />
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <span className="text-xs text-muted">The switch turns a listing on or off for Today. Set tonight’s quantities on Today.</span>
        {all.length === 0 && (
          <div className="flex flex-col gap-2 rounded-[18px] bg-fill p-4 text-[13px] text-muted lg:hidden">
            No listings yet. Add the bag you sell most evenings.
            <LinkButton href="/vendor/listings/new" size="md">
              Add a listing
            </LinkButton>
          </div>
        )}
      </section>

      {/* Desktop only: the selected listing, editable in place. */}
      <section aria-label="Listing details" className="hidden min-w-0 flex-col gap-3 lg:flex">
        {showNew ? (
          <>
            <h2 className="text-lg font-medium">New listing</h2>
            <ListingForm outletId={outlet.id} submitLabel="Add listing" onSaved={added} />
          </>
        ) : current ? (
          <>
            <h2 className="text-lg font-medium">{current.name}</h2>
            <ListingPanel key={current.id} listing={current} outlets={outlets} onChanged={replace} onCopied={added} onDeleted={() => deleted(current.id)} />
          </>
        ) : null}
      </section>
    </div>
  );
}

export default function VendorListings() {
  return <VendorShell title="Listings">{(outlet, outlets) => <Listings key={outlet.id} outlet={outlet} outlets={outlets} />}</VendorShell>;
}
