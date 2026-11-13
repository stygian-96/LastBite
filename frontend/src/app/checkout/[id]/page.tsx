"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { outletHref } from "@/components/customer";
import { PhoneSignIn } from "@/components/signin";
import { Button, Field, LinkButton, Notice, PageSkeleton, TopBar } from "@/components/ui";
import { HOLD_SECONDS } from "@/config/brand";
import { api, errorCode, errorMessage, type Order, type VerifyResult } from "@/lib/api";
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

const step = "flex size-9 flex-none items-center justify-center rounded-full border-[1.5px] border-line bg-white text-lg font-medium disabled:opacity-40";

/** Every kind of bag in the hold, each with its own count, the total, and a way back for more. */
function OrderLines({ order, busy, onChange }: { order: Order; busy: boolean; onChange: (dropId: string, quantity: number) => void }) {
  const lines = order.items.filter((l) => l.status === "active");
  const more = outletHref(order);
  return (
    <section aria-label="Your order" className="flex flex-col gap-3 rounded-[18px] p-3.5 shadow-card">
      <span className="text-[13px] text-muted">
        {order.brandName} · {order.branchName}
      </span>
      <ul className="flex flex-col divide-y divide-[#f0f0f0]">
        {lines.map((line) => (
          <li key={line.dropId} className="flex flex-col gap-2 py-2.5 first:pt-0">
            <div className="flex items-start gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-[15px] font-medium">{line.name}</strong>
                <span className="text-xs text-muted">
                  {rupees(line.unitPricePaise)} each · pickup {timeRange(line.pickupStartAt, line.pickupEndAt)}
                </span>
              </span>
              <span className="tabular text-[15px] font-medium">{rupees(line.unitPricePaise * line.quantity)}</span>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" aria-label={`One fewer ${line.name}`} disabled={busy || line.quantity <= 1} onClick={() => onChange(line.dropId, line.quantity - 1)} className={step}>
                −
              </button>
              <span aria-live="polite" className="tabular w-6 text-center font-bold">
                {line.quantity}
              </span>
              <button
                type="button"
                aria-label={`One more ${line.name}`}
                disabled={busy || line.quantity >= line.maxQuantity}
                onClick={() => onChange(line.dropId, line.quantity + 1)}
                className={step}
              >
                +
              </button>
              {line.quantity >= line.maxQuantity && line.maxQuantity > 1 && <span className="text-xs text-muted">Most you can take</span>}
              {lines.length > 1 && (
                <button type="button" disabled={busy} onClick={() => onChange(line.dropId, 0)} className="ml-auto min-h-9 text-[13px] font-medium text-danger underline">
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-baseline justify-between border-t border-[#f0f0f0] pt-2.5">
        <span className="text-sm font-medium">
          {order.quantity} {order.quantity === 1 ? "bag" : "bags"}
        </span>
        <span className="tabular flex items-baseline gap-2">
          <s className="text-xs text-faint">{rupees(order.totalValuePaise)}</s>
          <span className="text-[17px] font-bold">{rupees(order.pricePaise)}</span>
        </span>
      </div>
      {more && (
        <Link href={more} className="self-start text-[13px] font-medium text-ink underline">
          + Add another bag from {order.brandName}
        </Link>
      )}
    </section>
  );
}

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
  const [changing, setChanging] = useState(false);
  const [quantityError, setQuantityError] = useState<string | null>(null);

  const order = useQuery(() => api.getOrder(id), [id], { pollMs: phase === "pay" ? undefined : CONFIRM_POLL_MS });
  const left = useSecondsLeft(order.data?.holdExpiresAt);
  const status = order.data?.status;
  const expired = holdEnded || status === "expired" || (phase === "pay" && left === 0);

  // Signing in happens on this page, so the hold timer and the bag stay in view.
  async function signedIn(result: VerifyResult) {
    if (result.existingOrderId) router.replace(`/orders/${result.existingOrderId}?already=1`);
    else if (result.attachedOrderId && result.attachedOrderId !== id) router.replace(`/checkout/${result.attachedOrderId}${dropId ? `?drop=${dropId}` : ""}`);
    // Attached, or the hold ran out meanwhile: the order shows which, and expiry offers to hold it again.
    else await order.reload();
  }

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

  async function changeLine(dropId: string, quantity: number) {
    setChanging(true);
    setQuantityError(null);
    try {
      order.setData(await api.changeItemQuantity(id, dropId, quantity));
    } catch (err) {
      if (errorCode(err) === "hold_not_active") setHoldEnded(true);
      else setQuantityError(errorMessage(err));
      order.reload();
    } finally {
      setChanging(false);
    }
  }

  async function holdAgain() {
    if (!dropId) return;
    setBusy(true);
    setAgainError(null);
    try {
      // Ask for the same number of bags; if that many have gone, fall back to one.
      const fresh = await api.reserve(dropId, order.data?.quantity ?? 1).catch((err: unknown) => {
        const code = errorCode(err);
        if (code === "over_limit" || code === "not_enough_left") return api.reserve(dropId, 1);
        throw err;
      });
      setHoldEnded(false);
      router.replace(`/checkout/${fresh.id}?drop=${dropId}`);
    } catch (err) {
      const code = errorCode(err);
      setAgainError(code === "sold_out" || code === "not_on_sale" ? "Someone got there first. It’s sold out now." : errorMessage(err));
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
            <p className="text-sm leading-normal text-dark-sub">
              {item.quantity > 1 ? "The bags went back on sale." : "The bag went back on sale."} You haven’t been charged.
            </p>
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

  const signedOut = !me;
  const needsName = !!me && !me.name;
  const ready = ack && (!needsName || name.trim().length > 1);
  const secondsLeft = left ?? HOLD_SECONDS;
  const danger = secondsLeft <= 60;

  const payButton = (
    <Button className="w-full" disabled={!ready || busy} onClick={pay}>
          {!ready
            ? needsName && ack
              ? "Add your name to pay"
              : "Tick the box above to pay"
            : busy
              ? "Paying…"
              : `Pay ${rupees(item.pricePaise)} with ${METHODS.find((m) => m.id === method)!.label}`}
    </Button>
  );

  // Phones: one column with Pay pinned to the bottom. Desktop: the order on the left, and paying in a
  // card on the right that stays in view.
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col lg:max-w-5xl">
      <TopBar title="Checkout" onBack={cancel} icon="close" backLabel="Cancel and go back" />
      <div className="flex flex-1 flex-col gap-3.5 px-4 pb-4 pt-1 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-8 lg:px-8 lg:pb-10 lg:pt-4">
        <div className="flex flex-col gap-3.5">
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
        <OrderLines order={item} busy={changing || busy} onChange={changeLine} />
        {quantityError && (
          <p role="alert" className="text-[13px] text-danger">
            {quantityError}
          </p>
        )}
        <div className="rounded-2xl bg-fill px-3.5 py-3 text-[13px] leading-normal text-body">
          <strong className="font-medium text-ink">Collect today, {window}.</strong> In person, no delivery. Missed pickups are forfeited; if the vendor cancels you’re refunded automatically.
        </div>
        </div>

        <div className="flex flex-col gap-3.5 lg:sticky lg:top-6 lg:rounded-[22px] lg:p-5 lg:shadow-card">
          <h2 className="hidden text-lg font-medium lg:block">{signedOut ? "Sign in to pay" : "Pay"}</h2>
        {signedOut && <PhoneSignIn onSignedIn={signedIn} hint="We’ll text a 6-digit code. Your bag stays held while you sign in, and your pickup code comes to this number." />}
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
        {!signedOut && (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-[13px] leading-normal">
          <input type="checkbox" checked={ack} onChange={() => setAck(!ack)} className="m-0 size-[22px] flex-none accent-coral" />
          <span>
            I understand {item.type === "surprise_bag" ? "contents vary, " : ""}veg status isn’t guaranteed
            {item.allergens.length > 0 ? `, and it may contain ${item.allergens.join(", ")}` : ""}.
          </span>
        </label>
        )}
        {!signedOut && (
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
        )}
        {error && (
          <div role="alert" className="flex flex-col gap-1 rounded-2xl bg-warn-bg p-3.5 text-[13px] leading-normal text-warn-fg">
            <strong className="text-sm font-medium">Payment didn’t go through</strong>
            {error} You weren’t charged. Your bag is still held for {clock(secondsLeft)}.
          </div>
        )}
          {!signedOut && <div className="hidden lg:block">{payButton}</div>}
        </div>
      </div>

      {!signedOut && <div className="sticky bottom-0 bg-white px-4 pb-6 pt-3 lg:hidden">{payButton}</div>}
    </div>
  );
}
