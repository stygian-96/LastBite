"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormError } from "@/components/forms";
import { Button, ErrorState, LinkButton, PageSkeleton, StatusChip } from "@/components/ui";
import { brand } from "@/config/brand";
import { api, errorDetails, errorMessage, type Fix, type OutletStatus } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const COPY: Partial<Record<OutletStatus, { chip: string; tone: "wait" | "coral" | "ok" | "warn" | "info"; title: string; body: string }>> = {
  draft: { chip: "Not submitted", tone: "info", title: "Finish your application", body: "Pick up where you left off. Your progress is saved." },
  in_review: { chip: "Under review", tone: "wait", title: "We’re checking your documents", body: "Usually 1–2 working days. We’ll message you on WhatsApp as soon as it’s done." },
  changes_needed: { chip: "Changes needed", tone: "coral", title: "Almost there: a fix is needed", body: "Fix the items below and we’ll re-check them within a few hours." },
  live: { chip: "Live", tone: "ok", title: `You’re live on ${brand.name}!`, body: "Customers can now see you. Set tonight’s quantity to start selling." },
  suspended: { chip: "Suspended", tone: "warn", title: "Your outlet is paused", body: "Contact us to sort this out. Orders already paid for are still valid." },
  closed: { chip: "Closed", tone: "info", title: "This outlet is closed", body: "Your history stays here." },
};

const TIMELINE = ["Submitted", "Under review", "Changes needed", "Approved", "Live"];

function reached(status: OutletStatus) {
  if (status === "in_review") return 1;
  if (status === "changes_needed") return 2;
  if (status === "draft") return -1;
  return 5;
}

// Which onboarding step fixes each backend code.
function fixStep(code: string) {
  if (code.startsWith("fssai") || code.startsWith("pan_")) return 3;
  if (code.startsWith("bank_proof") || code.startsWith("payout")) return 4;
  if (code.startsWith("listing")) return 5;
  if (code.startsWith("agreement")) return 6;
  return 2;
}

export default function Status() {
  const router = useRouter();
  const { me, loading } = useSession();
  const outlets = useQuery(() => api.getVendorOutlets(), [me?.id], { enabled: !!me });
  const outlet = outlets.data?.find((o) => o.status !== "live") ?? outlets.data?.[0];
  const status = useQuery(() => api.getOutletStatus(outlet!.id), [outlet?.id], { enabled: !!outlet, pollMs: 30_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitFixes, setSubmitFixes] = useState<Fix[]>([]);

  useEffect(() => {
    if (!loading && !me) router.replace("/signin?next=/partner/status");
  }, [loading, me, router]);

  async function resubmit() {
    setBusy(true);
    setError(null);
    try {
      await api.submitOutlet(outlet!.id);
      await status.reload();
    } catch (err) {
      setSubmitFixes(errorDetails(err).fixes ?? []);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading || outlets.loading || (outlet && status.loading)) return <PageSkeleton />;
  if (outlets.error) return <ErrorState message={errorMessage(outlets.error)} onRetry={outlets.reload} />;

  if (!outlet) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 p-4 pt-10">
        <h1 className="text-2xl font-bold">No application yet</h1>
        <p className="text-sm text-muted">It takes about 10 minutes.</p>
        <LinkButton href="/partner/apply/1">Start your application</LinkButton>
      </div>
    );
  }

  const current = status.data?.status ?? outlet.status;
  const copy = COPY[current]!;
  const fixes = submitFixes.length > 0 ? submitFixes : (status.data?.fixes ?? []);
  const step = reached(current);
  const isLive = current === "live";
  const canResubmit = current === "changes_needed" && fixes.length === 0;
  const resume = Math.min(6, Math.max(2, outlet.onboardingStep + (outlet.onboardingStep >= 5 ? 1 : 0)));

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <div className="flex flex-col px-4 pb-2.5 pt-[18px]">
        <span className="text-[13px] text-muted">Application</span>
        <span className="text-[15px] font-medium">
          {outlet.brandName ? `${outlet.brandName} · ` : ""}
          {outlet.branchName}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-1">
        <section className="flex flex-col items-start gap-2.5 rounded-[22px] bg-dark p-5 text-white">
          <StatusChip tone={copy.tone}>{copy.chip}</StatusChip>
          <h1 className="text-2xl font-bold">{copy.title}</h1>
          <span className="text-sm leading-normal text-dark-sub">{copy.body}</span>
        </section>

        {current !== "live" && fixes.length > 0 && (
          <section role="alert" className="flex flex-col gap-2.5 rounded-[22px] bg-warn-bg p-4">
            <span className="text-xs font-bold tracking-[0.06em] text-warn-fg">
              {fixes.length} {fixes.length === 1 ? "THING" : "THINGS"} TO FIX
            </span>
            {fixes.map((fix) => (
              <div key={fix.code} className="flex items-center justify-between gap-3">
                <span className="text-sm leading-snug text-[#7a1a12]">{fix.message}</span>
                <Link href={`/partner/apply/${fixStep(fix.code)}`} className="flex-none text-[13px] font-medium text-ink underline">
                  Fix
                </Link>
              </div>
            ))}
          </section>
        )}

        {step >= 0 && (
          <ol aria-label="Progress" className="flex flex-col">
            {TIMELINE.map((label, index) => {
              const skipped = index === 2 && current !== "changes_needed";
              const done = index < step && !skipped;
              const now = index === step;
              const warn = index === 2 && current === "changes_needed";
              return (
                <li key={label} className="flex min-h-12 items-center gap-3">
                  <span
                    className={`flex size-7 flex-none items-center justify-center rounded-full text-xs font-bold ${
                      warn || now ? "bg-coral text-on-coral" : done ? "bg-dark text-white" : "bg-line text-muted"
                    }`}
                  >
                    {warn ? "!" : done ? "✓" : index + 1}
                  </span>
                  <span className={`text-sm ${done || now || warn ? "font-medium text-ink" : "text-muted"}`}>{label}</span>
                </li>
              );
            })}
          </ol>
        )}
        <FormError message={error} />
      </div>

      <div className="sticky bottom-0 flex flex-col gap-2 bg-white px-4 pb-6 pt-3">
        {isLive ? (
          <LinkButton href="/vendor">Set tonight’s quantity</LinkButton>
        ) : current === "draft" ? (
          <LinkButton href={`/partner/apply/${resume}`}>Continue application</LinkButton>
        ) : canResubmit ? (
          <Button onClick={resubmit} disabled={busy}>
            Send for review again
          </Button>
        ) : current === "in_review" ? (
          <LinkButton href="/browse" variant="quiet">
            Back to the site
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}
