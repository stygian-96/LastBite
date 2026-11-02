"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { CustomerShell, ListingCard } from "@/components/customer";
import { Illo, illoFor } from "@/components/Illo";
import { ErrorState, ExternalButton, LinkButton, Notice, PageSkeleton, SlowBanner, TopBar } from "@/components/ui";
import { api, errorMessage, errorStatus } from "@/lib/api";
import { hoursToday, time } from "@/lib/format";
import { useNow, useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const CATEGORY_LABEL = { bakery: "Bakery", cafe: "Café", restaurant: "Restaurant", sweets: "Sweet shop", kitchen: "Kitchen" };

export default function Outlet() {
  const params = useParams<{ brand: string; outlet: string }>();
  const router = useRouter();
  const { me } = useSession();
  const now = useNow(60_000);
  const outlet = useQuery(() => api.getOutlet(params.brand, params.outlet), [params.brand, params.outlet]);
  const following = useQuery(() => api.getFollowing(), [me?.id], { enabled: !!me });
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  if (outlet.loading) {
    return (
      <>
        {outlet.slow && (
          <div className="p-4">
            <SlowBanner onRetry={outlet.reload} />
          </div>
        )}
        <PageSkeleton />
      </>
    );
  }
  if (!outlet.data) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3 p-4 pt-10">
        {errorStatus(outlet.error) === 404 ? (
          <Notice big="—" band="not found" title="We can’t find this outlet">
            <LinkButton href="/browse" size="md">
              See tonight’s bags
            </LinkButton>
          </Notice>
        ) : (
          <ErrorState message={errorMessage(outlet.error)} onRetry={outlet.reload} />
        )}
      </div>
    );
  }

  const page = outlet.data;
  const shortBrand = page.brandName.split(" ")[0];
  const isFollowing = override ?? !!following.data?.some((f) => f.outletId === page.outletId);
  const hours = now === null ? null : hoursToday(page.openingHours, now);
  const usual = page.drops[0];

  async function toggleFollow() {
    if (!me) {
      router.push(`/signin?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    setBusy(true);
    const next = !isFollowing;
    setOverride(next);
    try {
      await (next ? api.follow(page.outletId) : api.unfollow(page.outletId));
    } catch {
      setOverride(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CustomerShell>
      <div className="lg:hidden">
        <TopBar title="Vendor" back="/browse" />
      </div>
      <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-3.5 px-4 pb-5 pt-1 lg:pt-6">
        <section className="relative flex h-44 flex-none flex-col justify-between overflow-hidden rounded-[22px] bg-dark px-[18px] py-5 text-white">
          <div className="absolute -right-[30px] -top-2.5 flex size-[190px] items-center justify-center rounded-full bg-dark-2">
            <Illo kind={illoFor(page.category)} size={150} />
          </div>
          <div className="relative flex max-w-[200px] flex-col gap-1 lg:max-w-md">
            <h1 className="text-[23px] font-medium leading-[1.15]">{page.brandName}</h1>
            <span className="text-[13px] text-dark-sub">
              {CATEGORY_LABEL[page.category]} · {page.area ?? page.branchName}
            </span>
          </div>
          {page.rating !== null && (
            <span className="relative inline-flex items-center gap-1.5 self-start rounded-full bg-coral px-3 py-1.5 text-[13px] font-medium text-on-coral">★ {page.rating}</span>
          )}
        </section>

        <div className="grid grid-cols-3 rounded-[18px] px-1 py-3 text-center shadow-card">
          <div className="flex flex-col gap-0.5">
            <span className="tabular text-[15px] font-medium">{hours ?? "Closed"}</span>
            <span className="text-xs text-muted">open today</span>
          </div>
          <div className="flex flex-col gap-0.5 border-l border-line">
            <span className="tabular text-[15px] font-medium">{usual ? time(usual.pickupStartAt) : "—"}</span>
            <span className="text-xs text-muted">pickup from</span>
          </div>
          <div className="flex flex-col gap-0.5 border-l border-line">
            <span className="text-[15px] font-medium">Verified</span>
            <span className="text-xs text-muted">FSSAI licence</span>
          </div>
        </div>

        <div className="flex items-baseline justify-between pt-1">
          <h2 className="text-lg font-medium">Tonight</h2>
          <span className="text-[13px] text-muted">
            {page.drops.length} {page.drops.length === 1 ? "listing" : "listings"}
          </span>
        </div>
        {page.drops.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {page.drops.map((drop) => (
              <ListingCard key={drop.id} drop={drop} />
            ))}
          </div>
        ) : (
          <div className="rounded-[18px] bg-fill px-4 py-6 text-center text-[13px] text-muted">Nothing listed yet tonight. Follow them to hear when they do.</div>
        )}

        <section className="flex items-center gap-3 rounded-[18px] bg-fill px-4 py-3.5">
          <span className="flex-1 text-[13px] leading-[1.45]">
            <strong className="text-[15px] font-medium">Follow {shortBrand}</strong>
            <br />
            <span className="text-muted">WhatsApp alert when they list</span>
          </span>
          <button
            type="button"
            aria-pressed={isFollowing}
            disabled={busy}
            onClick={toggleFollow}
            className={`h-11 min-w-[104px] flex-none rounded-full border-[1.5px] px-4 text-sm font-medium ${
              isFollowing ? "border-ink bg-white text-ink" : "border-coral bg-coral text-on-coral"
            }`}
          >
            {isFollowing ? "Following" : "Follow"}
          </button>
        </section>

        <section className="flex flex-col gap-2 text-[13px] leading-[1.55] text-body">
          {page.address && (
            <span>
              <strong className="font-medium text-ink">Address:</strong> {page.address}
            </span>
          )}
          {page.pickupInstructions && (
            <span>
              <strong className="font-medium text-ink">At pickup:</strong> {page.pickupInstructions}
            </span>
          )}
          {page.fssaiNumber && (
            <span>
              <strong className="font-medium text-ink">FSSAI:</strong> {page.fssaiNumber}
            </span>
          )}
        </section>
        {page.mapsUrl && (
          <ExternalButton href={page.mapsUrl} variant="outline">
            Get directions
          </ExternalButton>
        )}
      </div>
    </CustomerShell>
  );
}
