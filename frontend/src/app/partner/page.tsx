"use client";

import Link from "next/link";
import { Illo } from "@/components/Illo";
import { LinkButton, Logo } from "@/components/ui";
import { COMMISSION_PERCENT } from "@/config/brand";
import { api } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const SAMPLE_PRICE = 14900;
const SAMPLE_CUT = Math.round((SAMPLE_PRICE * COMMISSION_PERCENT) / 100);

const WHY = [
  ["Paid upfront", "No cash, no chasing"],
  ["No delivery", "They come to you"],
  ["New faces", "Who come back"],
];

const STEPS = [
  "Apply in about 10 minutes",
  "We check your documents in 1–2 working days",
  "Each evening, set tonight’s quantity",
  "Check codes at the counter; get paid weekly",
];

export default function Partner() {
  const { me } = useSession();
  const outlets = useQuery(() => api.getVendorOutlets(), [me?.id], { enabled: !!me });
  const hasApplication = !!outlets.data?.length;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <div className="flex items-center justify-between px-4 pb-2.5 pt-[18px]">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <Logo size="sm" />
          <span className="text-sm text-muted">partners</span>
        </Link>
        {hasApplication && (
          <Link href="/partner/status" className="flex min-h-11 items-center rounded-full bg-fill px-3.5 text-[13px] font-medium no-underline">
            Continue application
          </Link>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-1">
        <section className="relative flex flex-col gap-2 overflow-hidden rounded-[26px] bg-dark p-6 pr-[120px] text-white">
          <div className="absolute -bottom-6 -right-8 flex size-[170px] items-center justify-center rounded-full bg-dark-2">
            <Illo kind="bakery" size={130} />
          </div>
          <h1 className="relative text-[28px] font-bold leading-[1.1] tracking-tight">Turn tonight’s leftovers into sales</h1>
          <p className="relative text-sm leading-normal text-dark-sub">Set how many bags you have in under a minute. Customers pay first and collect at your counter.</p>
        </section>

        <div className="grid grid-cols-3 gap-2">
          {WHY.map(([title, sub]) => (
            <div key={title} className="flex flex-col gap-0.5 rounded-2xl bg-fill p-3">
              <strong className="text-sm font-medium">{title}</strong>
              <span className="text-xs text-muted">{sub}</span>
            </div>
          ))}
        </div>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-[17px] font-medium">How it works</h2>
          <ol className="flex flex-col gap-2">
            {STEPS.map((step, index) => (
              <li key={step} className="flex items-center gap-3 text-sm">
                <span className="flex size-8 flex-none items-center justify-center rounded-full bg-coral text-[13px] font-bold text-on-coral">{index + 1}</span>
                {step}
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-2.5 rounded-[22px] p-4 shadow-card">
          <h2 className="text-[17px] font-medium">Simple fees</h2>
          <span className="text-sm leading-normal text-body">
            No joining fee. We keep <strong className="font-medium text-ink">{COMMISSION_PERCENT}%</strong> of each bag sold, and payment charges are passed on at cost. Payouts every Tuesday for the week before.
          </span>
          <div className="tabular flex flex-col gap-1.5 text-sm">
            <span className="flex justify-between">
              <span>You sell a bag for</span>
              <span>{rupees(SAMPLE_PRICE)}</span>
            </span>
            <span className="flex justify-between">
              <span>Commission {COMMISSION_PERCENT}%</span>
              <span>− {rupees(SAMPLE_CUT)}</span>
            </span>
            <span className="flex justify-between font-medium">
              <span>You receive (before payment charges)</span>
              <span>{rupees(SAMPLE_PRICE - SAMPLE_CUT)}</span>
            </span>
          </div>
          <span className="text-xs text-muted">Commission shown is a sample rate.</span>
        </section>

        <section className="flex flex-col gap-1.5 rounded-[18px] bg-fill p-4">
          <h2 className="text-[15px] font-medium">Keep these handy</h2>
          <span className="text-[13px] leading-normal text-body">FSSAI licence · PAN · GSTIN (only if registered) · Bank account and a cancelled cheque or passbook photo · A photo of your counter</span>
        </section>
      </div>

      <div className="sticky bottom-0 bg-white px-4 pb-6 pt-3">
        <LinkButton href="/partner/apply/1">Get started</LinkButton>
      </div>
    </div>
  );
}
