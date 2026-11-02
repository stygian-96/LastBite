"use client";

import { useParams, useRouter } from "next/navigation";
import { ListingForm } from "@/components/forms";
import { ErrorState, Skeleton } from "@/components/ui";
import { VendorShell } from "@/components/vendor";
import { api, errorMessage, type VendorOutlet } from "@/lib/api";
import { useQuery } from "@/lib/hooks";

function Editor({ outlet, id }: { outlet: VendorOutlet; id: string }) {
  const router = useRouter();
  const isNew = id === "new";
  const listings = useQuery(() => api.getListings(outlet.id), [outlet.id], { enabled: !isNew });

  if (!isNew && listings.loading) return <Skeleton className="h-96 rounded-[22px]" />;
  if (!isNew && listings.error) return <ErrorState message={errorMessage(listings.error)} onRetry={listings.reload} />;

  const listing = listings.data?.find((row) => row.id === id);
  if (!isNew && !listing) return <p className="text-sm text-muted">This listing isn’t at the selected outlet.</p>;

  return (
    <div className="max-w-xl">
      <ListingForm outletId={outlet.id} listing={listing} submitLabel="Save listing" onSaved={() => router.push("/vendor/listings")} />
    </div>
  );
}

export default function EditListing() {
  const { id } = useParams<{ id: string }>();
  return <VendorShell title={id === "new" ? "New listing" : "Edit listing"}>{(outlet) => <Editor key={outlet.id} outlet={outlet} id={id} />}</VendorShell>;
}
