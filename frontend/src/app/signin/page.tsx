"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { bagKind, MiniOrderCard } from "@/components/customer";
import { Illo, type IlloKind } from "@/components/Illo";
import { Button, Logo, TopBar } from "@/components/ui";
import { api, errorCode, errorMessage, isMock } from "@/lib/api";
import { clock, phoneDisplay, timeRange } from "@/lib/format";
import { useQuery, useSecondsLeft } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const RESEND_SECONDS = 30;

/** What the desktop panel says, by why someone is signing in. */
const PANEL: Record<"partner" | "order" | "customer", { kind: IlloKind; title: string; body: string }> = {
  partner: {
    kind: "bakery",
    title: "Tonight’s leftovers, sold before you close",
    body: "Sign in to apply, carry on with your application, or open your dashboard. One number, one code, every time.",
  },
  order: {
    kind: "meals",
    title: "Your bag is waiting",
    body: "Sign in once to pay and get your pickup code. We’ll keep it held while you do.",
  },
  customer: {
    kind: "cafe",
    title: "Good food at closing-time prices",
    body: "Reserve what bakeries, cafés and kitchens near you have left tonight, and collect it on your way home.",
  },
};

export default function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const orderId = params.get("order");
  const dropId = params.get("drop");
  // Only a path on this site, so a crafted link can't send someone elsewhere after signing in.
  const asked = params.get("next");
  const next = asked && asked.startsWith("/") && !asked.startsWith("//") ? asked : null;
  const partner = !!next && (next.startsWith("/partner") || next.startsWith("/vendor"));
  const { me, loading, refresh } = useSession();

  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<string | null>(null);

  const order = useQuery(() => api.getOrder(orderId!), [orderId], { enabled: !!orderId });
  const holdLeft = useSecondsLeft(order.data?.holdExpiresAt);
  const resendLeft = useSecondsLeft(resendAt);
  const digits = phone.replace(/\D/g, "");
  const validPhone = digits.length === 10;
  const checkoutUrl = (id: string) => `/checkout/${id}${dropId ? `?drop=${dropId}` : ""}`;

  // Already signed in: nothing to do here.
  useEffect(() => {
    if (!loading && me && step === "phone" && !busy) router.replace(orderId ? checkoutUrl(orderId) : (next ?? "/browse"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, me]);

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.sendOtp(`+91${digits}`);
      setStep("otp");
      setResendAt(new Date(Date.now() + RESEND_SECONDS * 1000).toISOString());
    } catch (err) {
      setError(errorCode(err) === "rate_limited" ? "Too many tries. Wait a few minutes and try again." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.verifyOtp(`+91${digits}`, otp);
      await refresh();
      if (result.existingOrderId) router.replace(`/orders/${result.existingOrderId}?already=1`);
      else if (result.attachedOrderId) router.replace(checkoutUrl(result.attachedOrderId));
      // The hold ran out before sign-in finished: checkout says so and offers to hold it again.
      else if (orderId) router.replace(checkoutUrl(orderId));
      else router.replace(next ?? "/browse");
    } catch (err) {
      setError(errorCode(err) === "otp_invalid" ? "That code isn’t right. Check the SMS and try again." : errorMessage(err));
      setBusy(false);
    }
  }

  async function goBack() {
    if (orderId) await api.releaseHold(orderId).catch(() => undefined);
    router.push(dropId ? `/listing/${dropId}` : partner ? "/partner" : "/browse");
  }

  const isPhone = step === "phone";
  const held = order.data?.status === "held" ? order.data : null;

  const panel = PANEL[orderId ? "order" : partner ? "partner" : "customer"];

  // Phones get the single column; from lg the form sits beside a panel saying what signing in is for.
  return (
    <div className="flex min-h-dvh lg:grid lg:grid-cols-2">
      <aside className="relative hidden flex-col gap-16 overflow-hidden bg-dark p-12 text-white lg:flex">
        <Link href={partner ? "/partner" : "/"} className="text-white no-underline">
          <Logo />
        </Link>
        <div className="relative z-10 flex max-w-md flex-col gap-4">
          <h2 className="text-[36px] font-bold leading-[1.08] tracking-tight xl:text-[46px]">{panel.title}</h2>
          <p className="text-[17px] leading-relaxed text-dark-sub">{panel.body}</p>
        </div>
        <div aria-hidden className="absolute -bottom-28 -right-20 flex size-[380px] items-center justify-center rounded-full bg-dark-2 xl:size-[460px]">
          <Illo kind={panel.kind} size={260} />
        </div>
      </aside>

    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col lg:justify-center lg:py-10">
      <div className="lg:hidden">
        <TopBar title="Sign in" onBack={goBack} />
      </div>
      <div className="hidden px-4 lg:block">
        <button type="button" onClick={goBack} className="min-h-11 text-sm font-medium text-muted underline-offset-4 hover:underline">
          {orderId ? "Cancel and go back" : partner ? "Back to partner page" : "Back to browsing"}
        </button>
      </div>
      <form onSubmit={isPhone ? sendCode : verify} className="flex flex-1 flex-col lg:flex-none">
        <div className="flex flex-1 flex-col gap-[22px] px-4 py-3">
          <div className="flex flex-col gap-2">
            <h1 className="text-[26px] font-bold tracking-tight">
              {isPhone ? (orderId ? "Sign in to pay" : partner ? "Sign in to your partner account" : "Sign in") : "Enter the code"}
            </h1>
            <p className="text-[15px] leading-normal text-muted">
              {!isPhone
                ? `We sent it by SMS to ${phoneDisplay(digits)}.`
                : orderId
                  ? "Your bag is held for 5 minutes, including this step. You only sign in once."
                  : partner
                    ? "New here? Use the number you’ll run the outlet with. We’ll take you to your application, or to where you left off."
                    : "We’ll send a 6-digit code by SMS. You only sign in once."}
            </p>
          </div>

          {isPhone ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="phone" className="text-[13px] font-medium text-muted">
                Mobile number
              </label>
              <div className="flex gap-2">
                <span className="flex h-14 items-center rounded-2xl bg-fill px-4 text-base font-medium">+91</span>
                <input
                  id="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={11}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value.replace(/[^\d ]/g, ""))}
                  placeholder="10-digit number"
                  className="tabular h-14 min-w-0 flex-1 rounded-2xl bg-fill px-4 text-[17px] font-medium text-ink"
                />
              </div>
              <span className="text-[13px] text-muted">
                {partner ? "For order alerts and the evening “how many tonight?” message." : "Only for your pickup code and refund updates. No spam."}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="otp" className="text-[13px] font-medium text-muted">
                6-digit code
              </label>
              <input
                id="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="••••••"
                className="tabular h-16 rounded-2xl bg-fill px-5 text-[28px] font-bold tracking-[0.45em] text-ink"
              />
              <div className="flex items-center justify-between text-[13px] text-muted">
                {resendLeft ? (
                  <span className="tabular">Resend in {clock(resendLeft)}</span>
                ) : (
                  <button type="button" onClick={() => sendCode()} className="min-h-11 font-medium text-ink underline">
                    Resend code
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setStep("phone");
                    setOtp("");
                    setError(null);
                  }}
                  className="min-h-11 font-medium text-ink underline"
                >
                  Change number
                </button>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}

          {held && (
            <div className="flex flex-col gap-2">
              <MiniOrderCard kind={bagKind(held)} title={held.name} sub={`${held.brandName} · today ${timeRange(held.pickupStartAt, held.pickupEndAt)}`} price={held.pricePaise} />
              {holdLeft !== null && <span className="tabular text-center text-[13px] text-muted">Held for {clock(holdLeft)}</span>}
            </div>
          )}

          {isMock && <p className="rounded-2xl bg-fill-2 p-3 text-xs leading-normal text-muted">Mock mode: any 10-digit number and any 6-digit code work. 000000 fails.</p>}
        </div>

        <div className="flex flex-col gap-2.5 px-4 pb-6 pt-3">
          {isPhone ? (
            <Button type="submit" disabled={!validPhone || busy}>
              {busy ? "Sending…" : "Send code"}
            </Button>
          ) : (
            <Button type="submit" disabled={otp.length < 6 || busy}>
              {otp.length < 6 ? "Enter all 6 digits" : busy ? "Checking…" : "Verify and continue"}
            </Button>
          )}
          <span className="text-center text-xs text-muted">
            By continuing you agree to our <Link href="/help">Terms and Privacy policy</Link>.
          </span>
        </div>
      </form>
    </div>
    </div>
  );
}
