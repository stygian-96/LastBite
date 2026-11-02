"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { bagKind, MiniOrderCard } from "@/components/customer";
import { Button, Field, LinkButton, Notice, PageSkeleton, TopBar } from "@/components/ui";
import { HOLD_SECONDS } from "@/config/brand";
import { api, errorCode, errorDetails, errorMessage } from "@/lib/api";
import { clock, rupees, timeRange } from "@/lib/format";
import { useQuery, useSecondsLeft } from "@/lib/hooks";
import { completePayment, isTestPayment } from "@/lib/payment";
import { useSession } from "@/lib/session";

const METHODS = [
  { id: "upi", label: "UPI", hint: "Any UPI app" },
  { id: "card", label: "Card", hint: "Debit / credit" },
  { id: "netbanking", label: "Netbanking", hint: "All banks" },
];

const CONFIRM_POLL_MS = 2000;
const CONFIRM_PATIENCE_MS = 60_000;

export default function Checkout() {
  const { id } = useParams<{ id: string }>();
  const dropId = useSearchParams().get("drop");
  const router = useRouter();
  const { me, loading: sessionLoading, setMe } = useSession();

  const [phase, setPhase] = useState<"pay" | "confirming" | "pending">("pay");
  const [ack, setAck] = useState(false);
  const [method, setMethod] = useState("upi");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [holdEnded, setHoldEnded] = useState(false);
  const [againError, setAgainError] = useState<string | null>(null);

  const order = useQuery(() => api.getOrder(id), [id], { pollMs: phase === "pay" ? undefined : CONFIRM_POLL_MS });
  const left = useSecondsLeft(order.data?.holdExpiresAt);
  const status = order.data?.status;
  const expired = holdEnded || status === "expired" || (phase === "pay" && left === 0);

  useEffect(() => {
    if (!sessionLoading && !me) router.replace(`/signin?order=${id}${dropId ? `&drop=${dropId}` : ""}`);
  }, [sessionLoading, me, id, dropId, router]);

  useEffect(() => {
    if (status === "paid" || status === "collected") router.replace(`/orders/${id}`);
  }, [status, id, router]);

  useEffect(() => {
    if (phase !== "confirming") return;
    const timer = setTimeout(() => setPhase("pending"), CONFIRM_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      if (me && !me.name) setMe(await api.updateProfile({ name: name.trim() }));
      const info = await api.payOrder(id, { allergenAck: true });
      await completePayment(id, info);
      setPhase("confirming");
      order.reload();
    } catch (err) {
      if (errorCode(err) === "hold_expired") setHoldEnded(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function holdAgain() {
    if (!dropId) return;
    setBusy(true);
    setAgainError(null);
    try {
      const fresh = await api.reserve(dropId);
      setHoldEnded(false);
      router.replace(`/checkout/${fresh.id}?drop=${dropId}`);
    } catch (err) {
      const code = errorCode(err);
      const existing = errorDetails(err).existingOrderId;
      if (code === "already_ordered" && existing) router.replace(`/orders/${existing}?already=1`);
      else setAgainError(code === "sold_out" || code === "not_on_sale" ? "Someone got there first. It’s sold out now." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await api.releaseHold(id).catch(() => undefined);
    router.push(dropId ? `/listing/${dropId}` : "/browse");
  }

  if (order.loading || sessionLoading) return <PageSkeleton />;
  if (!order.data) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3 p-4 pt-10">
        <Notice big="—" band="not found" title="We can’t find this order">
          <p className="text-[13px] text-body">{errorMessage(order.error)}</p>
          <LinkButton href="/browse" size="md">
            See tonight’s bags
          </LinkButton>
        </Notice>
      </div>
    );
  }

  const item = order.data;
  const window = timeRange(item.pickupStartAt, item.pickupEndAt);

  if (phase !== "pay" && status === "held") {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
        <TopBar title="Checkout" />
        <div className="flex flex-col gap-3.5 px-4 pt-6">
          <Notice big="…" band="waiting for your bank" tone="wait" title="Waiting for confirmation">
            <p className="text-[13px] leading-normal text-body">
              Don’t pay again. Most banks confirm in under a minute. If it fails, any money taken returns in 5–7 working days.
            </p>
            {phase === "pending" && (
              <Button size="md" variant="quiet" onClick={order.reload}>
                Check status
              </Button>
            )}
          </Notice>
        </div>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
        <TopBar title="Checkout" back="/browse" icon="close" backLabel="Back to browsing" />
        <div className="flex flex-col gap-3.5 px-5 pt-[30px]">
          <div className="flex flex-col gap-2 rounded-[22px] bg-dark p-[22px] text-white">
            <span className="text-[40px] font-black text-coral">0:00</span>
            <h2 className="text-[22px] font-medium">Your hold has ended</h2>
            <p className="text-sm leading-normal text-dark-sub">The bag went back on sale. You haven’t been charged.</p>
          </div>
          {againError && (
            <p role="alert" className="text-[13px] text-danger">
              {againError}
            </p>
          )}
          {dropId && !againError && (
            <Button onClick={holdAgain} disabled={busy}>
              Hold it again if still available
            </Button>
          )}
          <LinkButton href="/browse" variant="quiet" size="md">
            Back to browsing
          </LinkButton>
        </div>
      </div>
    );
  }

  const needsName = !!me && !me.name;
  const ready = ack && (!needsName || name.trim().length > 1);
  const secondsLeft = left ?? HOLD_SECONDS;
  const danger = secondsLeft <= 60;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <TopBar title="Checkout" onBack={cancel} icon="close" backLabel="Cancel and go back" />
      <div className="flex flex-1 flex-col gap-3.5 px-4 pb-4 pt-1">
        <section role="timer" aria-label={`Hold ends in ${clock(secondsLeft)}`} className="flex flex-col gap-2.5 rounded-[22px] bg-dark p-[18px] text-white">
          <div className="flex items-center justify-between">
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-medium">Held for you</span>
              <span className="text-xs text-dark-sub">Pay before the timer ends</span>
            </span>
            <span className={`tabular text-[40px] font-black ${danger ? "text-coral" : "text-white"}`}>{clock(secondsLeft)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-dark-2">
            <div className={`h-full rounded-full ${danger ? "bg-coral" : "bg-white"}`} style={{ width: `${Math.round((secondsLeft / HOLD_SECONDS) * 100)}%` }} />
          </div>
        </section>

        <MiniOrderCard kind={bagKind(item)} title={`${item.name} × 1`} sub={`${item.brandName} · ${item.branchName}`} price={item.pricePaise} was={item.valuePaise} />

        <div className="rounded-2xl bg-fill px-3.5 py-3 text-[13px] leading-normal text-body">
          <strong className="font-medium text-ink">Collect today, {window}.</strong> In person, no delivery. Missed pickups are forfeited; if the vendor cancels you’re refunded automatically.
        </div>

        {needsName && (
          <Field
            id="name"
            label="Your name"
            hint="Staff use it to find your order at the counter."
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}

        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-[13px] leading-normal">
          <input type="checkbox" checked={ack} onChange={() => setAck(!ack)} className="m-0 size-[22px] flex-none accent-coral" />
          <span>
            I understand {item.type === "surprise_bag" ? "contents vary, " : ""}veg status isn’t guaranteed
            {item.allergens.length > 0 ? `, and it may contain ${item.allergens.join(", ")}` : ""}.
          </span>
        </label>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-base font-medium">Pay with</legend>
          <div className="grid grid-cols-3 gap-2">
            {METHODS.map((option) => (
              <label
                key={option.id}
                className={`relative flex h-16 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-2xl border-[1.5px] text-sm font-medium ${
                  method === option.id ? "border-coral bg-tint" : "border-line bg-white"
                }`}
              >
                <input type="radio" name="method" checked={method === option.id} onChange={() => setMethod(option.id)} className="sr-only" />
                {option.label}
                <span className="text-[11px] font-normal text-muted">{option.hint}</span>
              </label>
            ))}
          </div>
          <span className="text-xs text-muted">{isTestPayment ? "Test mode: payment always succeeds and no money moves." : "Processed securely by Razorpay."}</span>
        </fieldset>

        {error && (
          <div role="alert" className="flex flex-col gap-1 rounded-2xl bg-warn-bg p-3.5 text-[13px] leading-normal text-warn-fg">
            <strong className="text-sm font-medium">Payment didn’t go through</strong>
            {error} You weren’t charged. Your bag is still held for {clock(secondsLeft)}.
          </div>
        )}
      </div>

      <div className="sticky bottom-0 bg-white px-4 pb-6 pt-3">
        <Button className="w-full" disabled={!ready || busy} onClick={pay}>
          {!ready
            ? needsName && ack
              ? "Add your name to pay"
              : "Tick the box above to pay"
            : busy
              ? "Paying…"
              : `Pay ${rupees(item.pricePaise)} with ${METHODS.find((m) => m.id === method)!.label}`}
        </Button>
      </div>
    </div>
  );
}
