"use client";

import Link from "next/link";
import { useState } from "react";
import { FormError } from "@/components/forms";
import { Button, ErrorState, Skeleton, StatusChip } from "@/components/ui";
import { VendorShell } from "@/components/vendor";
import { api, errorDetails, errorMessage, type Fix, type OutletStatus, type SectionKey, type SectionState, type VendorOutlet } from "@/lib/api";
import { useQuery } from "@/lib/hooks";

const HERO: Partial<Record<OutletStatus, { chip: string; tone: "wait" | "coral" | "info" | "warn"; title: string; body: string }>> = {
  draft: { chip: "Not sent yet", tone: "info", title: "Finish and send your application", body: "Fill in anything missing below, then send it to us. Your progress is saved." },
  in_review: {
    chip: "Under review",
    tone: "wait",
    title: "We’re checking your application",
    body: "Usually 1–2 working days. It’s locked while we check; withdraw it if you need to change something.",
  },
  changes_needed: { chip: "Changes needed", tone: "coral", title: "A few things need fixing", body: "Fix what’s marked below, then send it back. Approved parts stay approved." },
  rejected: { chip: "Not approved", tone: "warn", title: "We can’t take this outlet on", body: "Reply to our WhatsApp message if you think this is a mistake." },
};

/** Where each part is edited: a step of the application, or the listings page. */
const SECTIONS: { key: SectionKey; title: string; what: string; href: string }[] = [
  { key: "details", title: "Outlet details", what: "Address, area, hours and contact", href: "/partner/apply/2" },
  { key: "licence", title: "FSSAI licence", what: "Number, expiry and the licence photo", href: "/partner/apply/3" },
  { key: "pan", title: "PAN", what: "Legal name, PAN number and the card photo", href: "/partner/apply/3" },
  { key: "bank", title: "Bank account", what: "Holder, account number, IFSC and proof", href: "/partner/apply/4" },
  { key: "listing", title: "Listings", what: "At least one bag customers can reserve", href: "/vendor/listings" },
  { key: "agreement", title: "Vendor agreement", what: "Signed once", href: "/partner/apply/6" },
];

const STATE: Record<SectionState, { label: string; tone: "ok" | "wait" | "coral" | "info" }> = {
  approved: { label: "Approved", tone: "ok" },
  waiting: { label: "Waiting for review", tone: "wait" },
  needs_fix: { label: "Needs fixing", tone: "coral" },
  missing: { label: "Missing", tone: "coral" },
  done: { label: "Done", tone: "info" },
};

const editHref = (href: string, reopen?: SectionKey) =>
  href.startsWith("/partner/") ? `${href}?back=application${reopen ? `&reopen=${reopen}` : ""}` : href;

function SectionRow({
  section,
  state,
  reason,
  editable,
}: {
  section: (typeof SECTIONS)[number];
  state: SectionState;
  reason?: string;
  editable: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const chip = STATE[state];
  const action = "flex min-h-10 flex-none items-center rounded-full border border-[#dddddd] px-3.5 text-[13px] font-medium text-ink no-underline";
  return (
    <li className={`flex flex-col gap-2.5 rounded-2xl border-[1.5px] p-3.5 ${state === "needs_fix" || state === "missing" ? "border-coral" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-[15px] font-medium">
            {state === "approved" && <span aria-hidden>🔒 </span>}
            {section.title}
          </strong>
          <span className="text-xs text-muted">{section.what}</span>
        </span>
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
        {editable && state !== "approved" && (
          <Link href={editHref(section.href)} className={`${action} ${state === "needs_fix" || state === "missing" ? "border-coral bg-coral text-on-coral" : ""}`}>
            {state === "needs_fix" || state === "missing" ? "Fix" : "Edit"}
          </Link>
        )}
        {editable && state === "approved" && !confirming && (
          <button type="button" className={action} onClick={() => setConfirming(true)}>
            Request a change
          </button>
        )}
      </div>
      {reason && (
        <p className="rounded-xl bg-warn-bg px-3 py-2 text-[13px] leading-normal text-warn-fg">
          <strong className="font-medium">From our team:</strong> {reason}
        </p>
      )}
      {confirming && (
        <div className="flex flex-col gap-2 rounded-xl bg-fill p-3 text-[13px] leading-normal">
          This part is already approved. If you change it, we’ll need to check it again before you can go live.
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={action} onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <Link href={editHref(section.href, section.key)} className={`${action} border-dark bg-dark text-white`}>
              Change it
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}

function Application({ outlet }: { outlet: VendorOutlet }) {
  const status = useQuery(() => api.getOutletStatus(outlet.id), [outlet.id], { pollMs: 30_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitFixes, setSubmitFixes] = useState<Fix[]>([]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setSubmitFixes([]);
    try {
      await action();
      await status.reload();
    } catch (err) {
      setSubmitFixes(errorDetails(err).fixes ?? []);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (status.error && !status.data) return <ErrorState message={errorMessage(status.error)} onRetry={status.reload} />;
  if (!status.data) return <Skeleton className="h-96 rounded-[22px]" />;

  const view = status.data;
  const hero = HERO[view.status] ?? HERO.in_review!;
  const editable = view.status === "draft" || view.status === "changes_needed";
  // The admin's note is shown on its own; the rest are what the checks still find.
  const missing = (submitFixes.length > 0 ? submitFixes : view.fixes).filter((f) => f.code !== "changes_requested");
  const canSend = editable && missing.length === 0;

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <section className="flex flex-col items-start gap-2.5 rounded-[22px] bg-dark p-5 text-white">
        <StatusChip tone={hero.tone}>{hero.chip}</StatusChip>
        <h2 className="text-2xl font-bold">{hero.title}</h2>
        <span className="text-sm leading-normal text-dark-sub">{hero.body}</span>
      </section>

      {view.changesReason && (
        <div role="alert" className="rounded-2xl bg-warn-bg p-3.5 text-[13px] leading-normal text-warn-fg">
          <strong className="font-medium">What we asked for:</strong> {view.changesReason}
        </div>
      )}
      {view.rejectionReason && (
        <div role="alert" className="rounded-2xl bg-warn-bg p-3.5 text-[13px] leading-normal text-warn-fg">
          <strong className="font-medium">Why:</strong> {view.rejectionReason}
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {SECTIONS.map((section) => {
          const found = view.sections.find((s) => s.key === section.key);
          return <SectionRow key={section.key} section={section} state={found?.state ?? "missing"} reason={found?.reason} editable={editable} />;
        })}
      </ul>

      {editable && missing.length > 0 && (
        <div className="flex flex-col gap-1 rounded-2xl bg-fill p-3.5 text-[13px] leading-normal">
          <strong className="font-medium">Still to do before you can send it</strong>
          {missing.map((fix) => (
            <span key={fix.code}>· {fix.message}</span>
          ))}
        </div>
      )}
      <FormError message={error} />

      {editable && (
        <Button disabled={!canSend || busy} onClick={() => act(() => api.submitOutlet(outlet.id))}>
          {busy ? "Sending…" : view.status === "changes_needed" ? "Send for review again" : "Send for review"}
        </Button>
      )}
      {view.status === "in_review" && (
        <Button variant="quiet" disabled={busy} onClick={() => act(() => api.withdrawOutlet(outlet.id))}>
          {busy ? "Withdrawing…" : "Withdraw to make changes"}
        </Button>
      )}
    </div>
  );
}

export default function VendorApplication() {
  return <VendorShell title="Application">{(outlet) => <Application key={outlet.id} outlet={outlet} />}</VendorShell>;
}
