"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ListingForm } from "@/components/forms";
import { ListingPanel } from "@/components/listings";
import { ErrorState, Skeleton } from "@/components/ui";
import { VendorShell } from "@/components/vendor";
import { api, errorMessage, type VendorOutlet } from "@/lib/api";
import { useQuery } from "@/lib/hooks";

/** A listing on its own page, as a phone opens it from the list. Desktop edits beside the list. */
function Editor({ outlet, outlets, id }: { outlet: VendorOutlet; outlets: VendorOutlet[]; id: string }) {
  const router = useRouter();
  const isNew = id === "new";
  const listings = useQuery(() => api.getListings(outlet.id), [outlet.id], { enabled: !isNew });

  const back = (
    <Link href="/vendor/listings" className="flex min-h-11 items-center self-start text-sm font-medium text-muted no-underline">
      ‹ All listings
    </Link>
  );

  if (isNew) {
    return (
      <div className="flex max-w-xl flex-col gap-2">
        {back}
        <ListingForm outletId={outlet.id} submitLabel="Add listing" onSaved={(listing) => router.replace(`/vendor/listings/${listing.id}`)} />
      </div>
    );
  }
  if (listings.error && !listings.data) return <ErrorState message={errorMessage(listings.error)} onRetry={listings.reload} />;
  if (!listings.data) return <Skeleton className="h-96 rounded-[22px]" />;

  const listing = listings.data.find((row) => row.id === id);
  if (!listing) {
    return (
      <div className="flex flex-col gap-2">
        {back}
        <p className="text-sm text-muted">This listing isn’t at the selected outlet.</p>
      </div>
    );
  }

  return (
    <div className="flex max-w-xl flex-col gap-2">
      {back}
      <h2 className="text-lg font-medium">{listing.name}</h2>
      <ListingPanel
        listing={listing}
        outlets={outlets}
        onChanged={(updated) => listings.setData(listings.data!.map((l) => (l.id === updated.id ? updated : l)))}
        onCopied={(copy) => router.push(`/vendor/listings/${copy.id}`)}
        onDeleted={() => router.replace("/vendor/listings")}
      />
    </div>
  );
}

export default function EditListing() {
  const { id } = useParams<{ id: string }>();
  return (
    <VendorShell title={id === "new" ? "New listing" : "Listing"}>
      {(outlet, outlets) => <Editor key={outlet.id} outlet={outlet} outlets={outlets} id={id} />}
    </VendorShell>
  );
}
