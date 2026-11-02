"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { CustomerShell, leftText, outletHref } from "@/components/customer";
import { Illo, illoFor } from "@/components/Illo";
import { BackIcon, DietMark, dietLong, ErrorState, ExternalButton, LinkButton, Notice, PageSkeleton, SlowBanner } from "@/components/ui";
import { api, errorCode, errorDetails, errorMessage, errorStatus, type DropDetail } from "@/lib/api";
import { rupees, timeRange } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

type Problem = { kind: "sold_out" } | { kind: "already"; orderId?: string } | { kind: "hold"; orderId?: string } | { kind: "other"; message: string };

function Hero({ drop }: { drop: DropDetail }) {
  const kind = illoFor(drop.foodCategory);
  const surprise = drop.type === "surprise_bag";
  return (
    <div className={`relative h-[380px] overflow-hidden lg:h-[460px] lg:rounded-[28px] ${drop.photoUrl ? "bg-[#d9d0c7]" : "bg-[linear-gradient(180deg,#8f8f8f_0%,#c9c9c9_100%)]"}`}>
      {drop.photoUrl ? (
        <>
          {/* Vendor photos come from another host. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={drop.photoUrl} alt={`${drop.name}, vendor photo`} className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-x-0 top-0 h-[130px] bg-[linear-gradient(180deg,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_100%)]" />
          <span className="absolute left-4 top-[74px] inline-flex items-center gap-1.5 rounded-full bg-ink/70 px-3 py-1.5 text-xs font-medium text-white">
            {surprise ? "Example of a past bag · contents vary" : "Photo by vendor"}
          </span>
        </>
      ) : (
        <div className="absolute left-1/2 top-20 -ml-[140px] drop-shadow-[0_18px_18px_rgba(0,0,0,0.18)]">
          <Illo kind={kind} size={280} />
        </div>
      )}
      <svg viewBox="0 0 390 380" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full lg:hidden">
        <path d={drop.photoUrl ? "M0 318 C 140 338, 300 298, 390 266 L390 380 L0 380 Z" : "M0 230 C 140 250, 300 190, 390 120 L390 380 L0 380 Z"} fill="#FFFFFF" />
      </svg>
      <div className="absolute inset-x-4 top-[18px] flex items-center justify-between">
        <Link href="/browse" aria-label="Back" className="flex size-11 items-center justify-center rounded-full bg-white">
          <BackIcon />
        </Link>
        <span className="text-[17px] font-medium text-white">Details</span>
        <span className="w-11" />
      </div>
    </div>
  );
}

export default function Listing() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me } = useSession();
  const drop = useQuery(() => api.getDrop(id), [id]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function reserve() {
    setBusy(true);
    setProblem(null);
    try {
      const order = await api.reserve(id);
      const params = `order=${order.id}&drop=${id}`;
      router.push(me ? `/checkout/${order.id}?drop=${id}` : `/signin?${params}`);
    } catch (err) {
      const code = errorCode(err);
      const orderId = errorDetails(err).existingOrderId;
      if (code === "sold_out" || code === "not_on_sale") {
        setProblem({ kind: "sold_out" });
        drop.reload();
      } else if (code === "already_ordered") {
        setProblem({ kind: "already", orderId });
      } else if (code === "hold_exists") {
        setProblem({ kind: "hold", orderId });
      } else {
        setProblem({ kind: "other", message: errorMessage(err) });
      }
      setBusy(false);
    }
  }

  if (drop.loading) {
    return (
      <>
        {drop.slow && (
          <div className="p-4">
            <SlowBanner onRetry={drop.reload} />
          </div>
        )}
        <PageSkeleton />
      </>
    );
  }

  if (!drop.data) {
    const gone = errorStatus(drop.error) === 404;
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3 p-4 pt-10">
        {gone ? (
          <Notice big="—" band="no longer available" title="This bag isn’t on sale any more">
            <p className="text-[13px] leading-normal text-body">Tonight’s pickup has ended, or the vendor took it down.</p>
            <LinkButton href="/browse" size="md">
              See tonight’s bags
            </LinkButton>
          </Notice>
        ) : (
          <ErrorState message={errorMessage(drop.error)} onRetry={drop.reload} />
        )}
      </div>
    );
  }

  const item = drop.data;
  const left = item.remaining;
  const window = timeRange(item.pickupStartAt, item.pickupEndAt);
  const [startClock, ...rest] = window.split("–");
  const vendorLink = outletHref(item);
  const surprise = item.type === "surprise_bag";
  const soldOut = left === 0 || problem?.kind === "sold_out";

  const stats = (
    <div className="grid grid-cols-3 rounded-[18px] bg-white px-1 py-3.5 text-center shadow-card">
      <div className="flex flex-col gap-0.5">
        <span className="tabular text-[17px] font-medium">{rupees(item.pricePaise)}</span>
        <s className="text-xs text-muted">{rupees(item.valuePaise)}</s>
      </div>
      <div className="flex flex-col gap-0.5 border-l border-line">
        <span className={`tabular text-[17px] font-medium ${left <= 2 ? "text-danger" : ""}`}>{left}</span>
        <span className="text-xs text-muted">left</span>
      </div>
      <div className="flex flex-col gap-0.5 border-l border-line">
        <span className="tabular text-[17px] font-medium">{startClock}</span>
        <span className="text-xs text-muted">to {rest.join("–")}</span>
      </div>
    </div>
  );

  const details = (
    <>
      <section className="flex flex-col gap-2">
        <h2 className="text-[17px] font-medium">{surprise ? "What to expect" : "What you get"}</h2>
        <p className="text-sm leading-relaxed text-muted">{item.description}</p>
      </section>

      {item.pickupInstructions && (
        <span className="text-sm leading-normal text-body">
          <strong className="font-medium text-ink">At pickup:</strong> {item.pickupInstructions}
        </span>
      )}

      <section className="flex flex-col gap-2 rounded-2xl bg-fill-2 p-3.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          <DietMark diet={item.diet} />
          {dietLong(item.diet)} · marked by vendor
        </span>
        <span className="text-[13px] text-muted">
          {item.allergens.length > 0 ? `May contain ${item.allergens.join(", ")}. ` : ""}Veg or allergen-free status isn’t guaranteed unless marked.
        </span>
      </section>

      {item.mapsUrl && (
        <ExternalButton href={item.mapsUrl} variant="outline" size="md">
          Get directions
        </ExternalButton>
      )}

      <span className="text-xs leading-relaxed text-muted">
        Pickup only, no delivery. Vendor cancels: full automatic refund. Missed pickup: forfeited.
        {item.fssaiNumber ? ` FSSAI ${item.fssaiNumber}.` : ""}
      </span>
    </>
  );

  const action = (
    <div className="flex flex-col gap-2">
      {problem?.kind === "already" && (
        <div role="alert" className="flex flex-col gap-2 rounded-2xl bg-wait-bg p-3.5 text-[13px] leading-normal text-wait-fg">
          <strong className="text-sm font-medium">You already have a bag from {item.brandName} tonight</strong>
          It’s one bag per outlet each night.
          <LinkButton href={problem.orderId ? `/orders/${problem.orderId}` : "/orders"} size="md" variant="dark">
            Show my order
          </LinkButton>
        </div>
      )}
      {problem?.kind === "hold" && (
        <div role="alert" className="flex flex-col gap-2 rounded-2xl bg-wait-bg p-3.5 text-[13px] leading-normal text-wait-fg">
          <strong className="text-sm font-medium">You already have a bag on hold</strong>
          Finish that one first, or let it go.
          <LinkButton href={problem.orderId ? `/signin?order=${problem.orderId}` : "/orders"} size="md" variant="dark">
            Go to my held bag
          </LinkButton>
        </div>
      )}
      {problem?.kind === "other" && (
        <p role="alert" className="text-[13px] text-danger">
          {problem.message}
        </p>
      )}
      {soldOut ? (
        <div className="flex flex-col gap-3">
          <Notice big="0" band={`left at ${item.brandName} tonight`} tone="warn" title="Sold out for tonight">
            <p className="text-[13px] leading-normal text-body">Every bag has gone. New listings usually appear 5–8 pm tomorrow.</p>
            <LinkButton href="/browse" size="md">
              See what’s left
            </LinkButton>
          </Notice>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={reserve}
          className="flex h-14 w-full flex-col items-center justify-center rounded-full bg-coral leading-tight text-on-coral disabled:opacity-70"
        >
          <span className="text-base font-medium">{busy ? "Holding your bag…" : `Reserve for ${rupees(item.pricePaise)}`}</span>
          <span className="text-[11px] opacity-85">we hold it for 5 min from here</span>
        </button>
      )}
    </div>
  );

  return (
    <CustomerShell nav={false}>
      <div className="mx-auto grid w-full max-w-[1100px] lg:grid-cols-[1fr_420px] lg:gap-8 lg:p-6">
        <div className="min-w-0">
          <Hero drop={item} />
          <div className="hidden flex-col gap-4 pt-6 lg:flex">{details}</div>
        </div>
        <div className="flex flex-col gap-4 px-4 pb-4 lg:px-0">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[23px] font-medium">{item.name}</h1>
            <Link href={vendorLink ?? "#"} className="flex items-center gap-1.5 text-sm text-muted no-underline">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 22s-7-6.4-7-12a7 7 0 0 1 14 0c0 5.6-7 12-7 12z" fill="#8A8A8A" />
                <circle cx="12" cy="10" r="2.6" fill="#FFFFFF" />
              </svg>
              {item.brandName} · {item.area ?? item.branchName}
              {item.rating !== null && ` · ★ ${item.rating}`}
            </Link>
          </div>
          {stats}
          <span className="sr-only">{leftText(left)}</span>
          <div className="hidden lg:block">{action}</div>
          <div className="flex flex-col gap-4 lg:hidden">{details}</div>
        </div>
      </div>
      <div className="sticky bottom-0 z-10 bg-white px-4 pb-6 pt-3 shadow-nav lg:hidden">{action}</div>
    </CustomerShell>
  );
}
