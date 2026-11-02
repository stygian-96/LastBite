"use client";

import Link from "next/link";
import { useState } from "react";
import { bagKind, CustomerShell, outletHref } from "@/components/customer";
import { Illo } from "@/components/Illo";
import { Button, Chip, ErrorState, LinkButton, Notice, Sheet, Skeleton, SlowBanner, StatusChip, Tabs } from "@/components/ui";
import { api, errorMessage, type IssueReason, type Order } from "@/lib/api";
import { rupees, shortDate, timeRange } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const REASONS: { id: IssueReason; label: string }[] = [
  { id: "bag_not_ready", label: "Bag not ready" },
  { id: "quality", label: "Food quality" },
  { id: "allergen", label: "Allergen issue" },
  { id: "code_rejected", label: "Code not accepted" },
  { id: "other", label: "Something else" },
];

function ActiveCard({ order }: { order: Order }) {
  if (order.status === "held") {
    return (
      <Link href={`/checkout/${order.id}`} className="flex flex-col gap-2.5 rounded-[22px] p-4 no-underline shadow-card">
        <div className="flex items-center justify-between">
          <StatusChip tone="wait">On hold · not paid</StatusChip>
          <span className="text-xs text-muted">#{order.number}</span>
        </div>
        <span className="text-[15px] font-medium">{order.name}</span>
        <span className="text-[13px] font-medium">Finish paying ›</span>
      </Link>
    );
  }
  return (
    <Link href={`/orders/${order.id}`} className="flex flex-col gap-3 rounded-[22px] bg-dark p-4 text-white no-underline">
      <div className="flex items-center justify-between">
        <StatusChip tone="coral">Paid · pickup tonight</StatusChip>
        <span className="text-xs text-dark-sub">#{order.number}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex size-14 flex-none items-center justify-center rounded-[14px] bg-dark-2">
          <Illo kind={bagKind(order)} size={44} />
        </span>
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">{order.name}</span>
          <span className="text-xs text-dark-sub">
            {order.brandName} · today {timeRange(order.pickupStartAt, order.pickupEndAt)}
          </span>
        </span>
        <span className="rounded-xl bg-coral px-2.5 py-1.5 text-center text-on-coral">
          <span className="block text-[10px] font-bold">CODE</span>
          <span className="text-xl font-black tracking-[0.04em]">{order.pickupCode}</span>
        </span>
      </div>
      <span className="text-[13px] font-medium">Show pickup code ›</span>
    </Link>
  );
}

function RefundCard({ order }: { order: Order }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[22px] p-4 shadow-card">
      <div className="flex items-center justify-between">
        <StatusChip tone="wait">Refund in progress</StatusChip>
        <span className="text-xs text-muted">#{order.number}</span>
      </div>
      <span className="text-[15px] font-medium">
        {order.name} · {order.brandName}
      </span>
      <span className="text-[13px] leading-normal text-body">
        {order.brandName} cancelled. {rupees(order.refund!.amountPaise)} is on its way back to you, usually within 5–7 working days.
      </span>
    </div>
  );
}

function pastStatus(order: Order) {
  if (order.status === "collected") return { label: "Collected", tone: "info" as const, note: `You saved ${rupees(order.valuePaise - order.pricePaise)}.` };
  if (order.status === "no_show") {
    return { label: "No-show", tone: "warn" as const, note: "Not collected in time, so it was forfeited. No refund for missed pickups." };
  }
  if (order.status === "cancelled" && order.refund?.status === "processed") {
    return { label: "Refunded", tone: "ok" as const, note: `Vendor cancelled. ${rupees(order.refund.amountPaise)} refunded.` };
  }
  return { label: "Cancelled", tone: "warn" as const, note: "Vendor cancelled." };
}

function Stars({ value, onPick }: { value: number; onPick: (stars: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Rate pickup" className="flex items-center gap-0.5">
      <span className="mr-1.5 text-[13px] text-muted">Rate pickup</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          disabled={value > 0}
          onClick={() => onPick(n)}
          className="flex h-11 w-9 items-center justify-center"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill={n <= value ? "#FF6B5B" : "#E0E0E0"} />
          </svg>
        </button>
      ))}
    </div>
  );
}

function PastCard({ order, onReport }: { order: Order; onReport: () => void }) {
  const [rating, setRating] = useState(order.rating ?? 0);
  const [rateError, setRateError] = useState<string | null>(null);
  const status = pastStatus(order);
  const vendor = outletHref(order);

  async function rate(stars: number) {
    setRating(stars);
    setRateError(null);
    try {
      await api.rateOrder(order.id, stars);
    } catch (err) {
      setRateError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[22px] p-3.5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="flex size-[52px] flex-none items-center justify-center rounded-[14px] bg-fill-2">
          <Illo kind={bagKind(order)} size={42} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-medium">{order.name}</span>
          <span className="text-xs text-muted">
            {order.brandName} · {shortDate(order.pickupStartAt)}
          </span>
        </span>
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
      </div>
      <span className="text-[13px] leading-[1.45] text-body">{status.note}</span>
      {order.status === "collected" && <Stars value={rating} onPick={rate} />}
      {rateError && <span className="text-xs text-danger">{rateError}</span>}
      <div className="flex gap-2">
        {vendor && (
          <LinkButton href={vendor} variant="quiet" size="md" className="flex-1">
            See vendor
          </LinkButton>
        )}
        {order.status !== "cancelled" && (
          <button type="button" onClick={onReport} className="h-11 flex-1 rounded-full border-[1.5px] border-line bg-white text-sm font-medium">
            Report a problem
          </button>
        )}
      </div>
    </div>
  );
}

function ReportSheet({ order, onClose }: { order: Order; onClose: () => void }) {
  const [reason, setReason] = useState<IssueReason>("bag_not_ready");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const photoKey = photo ? await api.uploadIssuePhoto(photo) : undefined;
      await api.reportIssue(order.id, { reason, description: description.trim() || undefined, photoKey });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Report a problem" onClose={onClose}>
      {sent ? (
        <>
          <p className="text-sm leading-normal text-body">Thanks. We’ll reply on WhatsApp within 24 hours.</p>
          <Button onClick={onClose}>Done</Button>
        </>
      ) : (
        <>
          <span className="text-[13px] text-muted">
            {order.name} · {order.brandName} · {shortDate(order.pickupStartAt)}
          </span>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((option) => (
              <Chip key={option.id} on={reason === option.id} onClick={() => setReason(option.id)}>
                {option.label}
              </Chip>
            ))}
          </div>
          <label htmlFor="what" className="text-[13px] font-medium text-muted">
            What happened?
          </label>
          <textarea
            id="what"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="A few words help us sort it faster"
            className="resize-none rounded-2xl bg-fill px-3.5 py-3 text-[15px]"
          />
          <label className="relative flex h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed border-[#cfcfcf] text-sm font-medium">
            {photo ? photo.name : "Add a photo (optional)"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              capture="environment"
              onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </label>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
          <Button onClick={send} disabled={busy}>
            {busy ? "Sending…" : "Send report"}
          </Button>
          <span className="text-center text-xs text-muted">We reply on WhatsApp within 24 hours.</span>
        </>
      )}
    </Sheet>
  );
}

export default function Orders() {
  const { me, loading } = useSession();
  const [tab, setTab] = useState<"active" | "past">("active");
  const [reporting, setReporting] = useState<Order | null>(null);
  const active = useQuery(() => api.getMyOrders("active"), [me?.id], { enabled: !!me });
  const past = useQuery(() => api.getMyOrders("past"), [me?.id], { enabled: !!me });

  const history = (past.data ?? []).filter((o) => o.status !== "expired");
  const refunding = history.filter((o) => o.refund && o.refund.status !== "processed");
  const finished = history.filter((o) => !refunding.includes(o));
  const activeList = active.data ?? [];

  return (
    <CustomerShell>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col">
        <div className="flex flex-col gap-3.5 px-4 pb-2.5 pt-[18px]">
          <h1 className="text-2xl font-bold">Your orders</h1>
          {me && (
            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { id: "active", label: `Active · ${activeList.length}` },
                { id: "past", label: "Past" },
              ]}
            />
          )}
        </div>

        <div className="flex flex-1 flex-col gap-3 px-4 pb-4 pt-1">
          {!loading && !me ? (
            <Notice big="0" band="orders so far" title="Your first bag is waiting">
              <p className="text-[13px] leading-normal text-body">Sign in to see reserved bags and pickup codes here.</p>
              <LinkButton href="/signin?next=/orders" size="md">
                Sign in
              </LinkButton>
            </Notice>
          ) : loading || active.loading || past.loading ? (
            <>
              {(active.slow || past.slow) && <SlowBanner onRetry={active.reload} />}
              <Skeleton className="h-40 rounded-[22px]" />
              <Skeleton className="h-32 rounded-[22px]" />
            </>
          ) : active.error || past.error ? (
            <ErrorState
              message={errorMessage(active.error ?? past.error)}
              onRetry={() => {
                active.reload();
                past.reload();
              }}
            />
          ) : tab === "active" ? (
            <>
              {activeList.map((order) => (
                <ActiveCard key={order.id} order={order} />
              ))}
              {refunding.length > 0 && <h2 className="mt-2 text-[17px] font-medium">Refunds</h2>}
              {refunding.map((order) => (
                <RefundCard key={order.id} order={order} />
              ))}
              {activeList.length === 0 && refunding.length === 0 && (
                <Notice big="0" band="active orders" title={history.length ? "Nothing on the go" : "Your first bag is waiting"}>
                  <p className="text-[13px] leading-normal text-body">Reserved bags and pickup codes will appear here.</p>
                  <LinkButton href="/browse" size="md">
                    See tonight’s bags
                  </LinkButton>
                </Notice>
              )}
            </>
          ) : finished.length > 0 ? (
            finished.map((order) => <PastCard key={order.id} order={order} onReport={() => setReporting(order)} />)
          ) : (
            <p className="py-8 text-center text-sm text-muted">Past orders will appear here.</p>
          )}
        </div>
      </div>
      {reporting && <ReportSheet order={reporting} onClose={() => setReporting(null)} />}
    </CustomerShell>
  );
}
