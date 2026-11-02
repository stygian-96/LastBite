"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { bagKind, CustomerShell } from "@/components/customer";
import { Illo } from "@/components/Illo";
import { ErrorState, ExternalButton, LinkButton, Notice, PageSkeleton, TopBar } from "@/components/ui";
import { api, errorMessage, type Order } from "@/lib/api";
import { rupees, shortName, time, timeRange } from "@/lib/format";
import { useNow, useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { readJson, writeJson } from "@/lib/storage";

const cacheKey = (id: string) => `lb_order_${id}`;

// The pickup code has to work on a weak network, so paid orders are kept on the device.
function useOrderWithCache(id: string) {
  return useQuery(
    async () => {
      try {
        const order = await api.getOrder(id);
        if (order.pickupCode) writeJson(cacheKey(id), order);
        return { order, offline: false };
      } catch (err) {
        const saved = readJson<Order>(cacheKey(id));
        if (saved) return { order: saved, offline: true };
        throw err;
      }
    },
    [id],
    { pollMs: 30_000 },
  );
}

function PickupCode({ order, offline }: { order: Order; offline: boolean }) {
  const { me } = useSession();
  const now = useNow(30_000);
  const window = timeRange(order.pickupStartAt, order.pickupEndAt);
  const opensIn = now === null ? 0 : Math.ceil((new Date(order.pickupStartAt).getTime() - now) / 60_000);
  const closed = now !== null && now > new Date(order.pickupEndAt).getTime();
  const reminder = new Date(new Date(order.pickupStartAt).getTime() - 30 * 60_000).toISOString();
  const name = shortName(me?.name ?? null);

  return (
    <div className="flex flex-col gap-3.5">
      {offline && (
        <div role="status" className="flex items-center gap-2.5 rounded-[14px] bg-dark px-3.5 py-3 text-[13px] text-white">
          <span className="size-2 flex-none rounded-full bg-coral" />
          Slow network. Your pickup code still works.
        </div>
      )}
      <section aria-label="Pickup code" className="relative flex flex-col gap-3.5 overflow-hidden rounded-3xl bg-dark p-5 text-white">
        <div className="flex items-center justify-between">
          <span className="pop inline-flex items-center gap-2 text-sm font-medium">
            <span className="flex size-[26px] items-center justify-center rounded-full bg-coral">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2A0A06" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7" />
              </svg>
            </span>
            Reserved &amp; paid
          </span>
          <span className="tabular text-xs text-dark-sub">#{order.number}</span>
        </div>
        <div className="flex flex-col items-center gap-0.5 rounded-[18px] bg-coral p-4 text-on-coral">
          <span className="text-xs font-bold tracking-[0.08em]">SHOW AT THE COUNTER</span>
          <span className="tabular text-[92px] font-black leading-none tracking-[0.04em]">{order.pickupCode}</span>
          <span className="text-center text-base font-medium">
            {name ? `${name} · ` : ""}
            {order.name} × 1
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-dark-sub">Pickup today</span>
            <span className="tabular text-xl font-medium">{window}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-dark-sub">Paid</span>
            <span className="tabular text-xl font-medium">{rupees(order.pricePaise)}</span>
          </div>
        </div>
      </section>

      {opensIn > 0 && (
        <div className="rounded-2xl bg-fill p-3.5 text-[13px] leading-normal text-body">
          <strong className="font-medium text-ink">Pickup opens at {time(order.pickupStartAt)}.</strong> Your bag is being packed. Arriving early? The vendor may not have it ready yet.
        </div>
      )}
      {closed && (
        <div className="rounded-2xl bg-warn-bg p-3.5 text-[13px] leading-normal text-warn-fg">
          <strong className="font-medium">The pickup window has closed.</strong> If you’re at the counter now, ask staff; they can still hand it over if it’s there. Otherwise it’s marked as missed.
        </div>
      )}

      <div className="flex items-center gap-3 rounded-[18px] bg-white p-3 shadow-card">
        <span className="flex size-14 flex-none items-center justify-center rounded-[14px] bg-fill-2">
          <Illo kind={bagKind(order)} size={44} />
        </span>
        <span className="flex flex-1 flex-col gap-0.5 leading-[1.3]">
          <span className="text-[15px] font-medium">{order.brandName}</span>
          <span className="text-xs text-muted">{[order.address, order.pickupInstructions].filter(Boolean).join(" · ")}</span>
        </span>
      </div>

      <section className="flex flex-col gap-2.5 rounded-[18px] bg-fill-2 p-3.5 text-[13px] leading-normal text-body">
        <span className="flex gap-2.5">
          <strong className="min-w-[74px] font-medium text-ink">Reminder</strong>We’ll WhatsApp you at {time(reminder)}.
        </span>
        <span className="flex gap-2.5">
          <strong className="min-w-[74px] font-medium text-ink">If cancelled</strong>Vendor cancels: {rupees(order.pricePaise)} back automatically.
        </span>
        <span className="flex gap-2.5">
          <strong className="min-w-[74px] font-medium text-ink">If you miss it</strong>The order is forfeited, no refund.
        </span>
      </section>

      {order.mapsUrl && <ExternalButton href={order.mapsUrl}>Get directions</ExternalButton>}
      <LinkButton href="/browse" variant="quiet" size="md">
        Keep browsing
      </LinkButton>
    </div>
  );
}

function OrderState({ order }: { order: Order }) {
  if (order.status === "collected") {
    return (
      <Notice big={order.pickupCode ?? "✓"} band="collected" tone="ok" title="You picked this up">
        <p className="text-[13px] leading-normal text-body">
          {order.name} from {order.brandName}. You saved {rupees(order.valuePaise - order.pricePaise)}.
        </p>
        <LinkButton href="/browse" size="md">
          See tonight’s bags
        </LinkButton>
      </Notice>
    );
  }
  if (order.status === "no_show") {
    return (
      <Notice big="—" band="not collected" title="You missed this pickup">
        <p className="text-[13px] leading-normal text-body">The bag wasn’t collected in time, so it’s forfeited. Food can’t be held overnight, so no refund.</p>
        <LinkButton href="/browse" size="md" variant="quiet">
          See tonight’s bags
        </LinkButton>
      </Notice>
    );
  }
  if (order.status === "cancelled") {
    return (
      <Notice big={rupees(order.refund?.amountPaise ?? order.pricePaise)} band={order.refund?.status === "processed" ? "refunded" : "full refund"} tone="warn" title={`${order.brandName} cancelled tonight`}>
        <p className="text-[13px] leading-normal text-body">
          {order.refund?.status === "processed"
            ? "Your refund has been sent back the way you paid."
            : "Your full refund has started automatically, usually back in 5–7 working days. Nothing for you to do."}
        </p>
        <LinkButton href="/browse" size="md">
          Find another bag
        </LinkButton>
      </Notice>
    );
  }
  return (
    <Notice big="0:00" band="hold ended" tone="dark" title="This hold has ended">
      <p className="text-[13px] leading-normal text-body">You haven’t been charged.</p>
      <LinkButton href="/browse" size="md">
        See tonight’s bags
      </LinkButton>
    </Notice>
  );
}

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const already = useSearchParams().get("already");
  const router = useRouter();
  const result = useOrderWithCache(id);
  const status = result.data?.order.status;

  useEffect(() => {
    if (status === "held") router.replace(`/checkout/${id}`);
  }, [status, id, router]);

  return (
    <CustomerShell>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <TopBar title="Your pickup" back="/orders" backLabel="Back to orders" />
        <div className="flex flex-col gap-3.5 px-4 pb-4 pt-1.5">
          {already && (
            <div role="status" className="rounded-2xl bg-wait-bg p-3.5 text-[13px] leading-normal text-wait-fg">
              You already have a bag from this outlet tonight, so here it is. It’s one bag per outlet each night.
            </div>
          )}
          {result.loading ? (
            <PageSkeleton />
          ) : !result.data ? (
            <ErrorState message={errorMessage(result.error)} onRetry={result.reload} />
          ) : result.data.order.status === "paid" ? (
            <PickupCode order={result.data.order} offline={result.data.offline} />
          ) : (
            <OrderState order={result.data.order} />
          )}
        </div>
      </div>
    </CustomerShell>
  );
}
