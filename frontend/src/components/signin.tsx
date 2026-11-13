"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import { api, errorCode, errorMessage, isMock, type VerifyResult } from "@/lib/api";
import { clock, phoneDisplay } from "@/lib/format";
import { useSecondsLeft } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const RESEND_SECONDS = 30;

/**
 * Phone number, then the 6-digit code, in place, for flows that shouldn't send people to another
 * page (checkout). The session is refreshed before `onSignedIn` runs.
 */
export function PhoneSignIn({ onSignedIn, hint }: { onSignedIn: (result: VerifyResult) => void | Promise<void>; hint?: string }) {
  const { refresh } = useSession();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<string | null>(null);
  const resendLeft = useSecondsLeft(resendAt);
  const digits = phone.replace(/\D/g, "");

  async function send(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.sendOtp(`+91${digits}`);
      setStep("code");
      setCode("");
      setResendAt(new Date(Date.now() + RESEND_SECONDS * 1000).toISOString());
    } catch (err) {
      setError(errorCode(err) === "rate_limited" ? "Too many tries. Wait a few minutes and try again." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.verifyOtp(`+91${digits}`, value);
      await refresh();
      await onSignedIn(result);
    } catch (err) {
      setError(errorCode(err) === "otp_invalid" ? "That code isn’t right. Check the SMS and try again." : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section aria-label="Sign in" className="flex flex-col gap-3 rounded-[22px] p-4 shadow-card">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-medium">{step === "phone" ? "Your mobile number" : "Enter the code"}</h2>
        <span className="text-[13px] leading-normal text-muted">
          {step === "phone" ? (hint ?? "We’ll text a 6-digit code. Your pickup code comes to this number too.") : `We sent it by SMS to ${phoneDisplay(digits)}.`}
        </span>
      </div>

      {step === "phone" ? (
        <form onSubmit={send} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <span className="flex h-14 items-center rounded-2xl bg-fill px-4 text-base font-medium">+91</span>
            <input
              aria-label="Mobile number"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={11}
              placeholder="10-digit number"
              value={phone}
              onChange={(event) => setPhone(event.target.value.replace(/[^\d ]/g, ""))}
              className="tabular h-14 min-w-0 flex-1 rounded-2xl bg-fill px-4 text-[17px] font-medium text-ink"
            />
          </div>
          <Button type="submit" variant="dark" size="md" disabled={digits.length !== 10 || busy}>
            {busy ? "Sending…" : "Send code"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            aria-label="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            value={code}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(next);
              if (next.length === 6) void verify(next);
            }}
            className="tabular h-16 rounded-2xl bg-fill px-5 text-[28px] font-bold tracking-[0.45em] text-ink"
          />
          <div className="flex items-center justify-between text-[13px] text-muted">
            {resendLeft ? (
              <span className="tabular">Resend in {clock(resendLeft)}</span>
            ) : (
              <button type="button" onClick={() => send()} disabled={busy} className="min-h-11 font-medium text-ink underline">
                Resend code
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setStep("phone");
                setCode("");
                setError(null);
              }}
              className="min-h-11 font-medium text-ink underline"
            >
              Change number
            </button>
          </div>
          {busy && <span className="text-[13px] text-muted">Checking…</span>}
        </div>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      {isMock && <p className="rounded-2xl bg-fill-2 p-3 text-xs leading-normal text-muted">Mock mode: any 10-digit number and any 6-digit code work. 000000 fails.</p>}
    </section>
  );
}
