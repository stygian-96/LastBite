"use client";

import { useState } from "react";
import { FormError } from "@/components/forms";
import { ErrorState, Skeleton, StatusChip } from "@/components/ui";
import { VendorShell } from "@/components/vendor";
import { COMMISSION_PERCENT } from "@/config/brand";
import { api, errorMessage, type Payout, type VendorOutlet } from "@/lib/api";
import { dayRange, rupees, shortDate } from "@/lib/format";
import { useNow, useQuery } from "@/lib/hooks";

function nextTuesday(now: number) {
  const date = new Date(now);
  const daysAhead = (2 - date.getDay() + 7) % 7 || 7;
  return shortDate(new Date(now + daysAhead * 86_400_000).toISOString());
}

const PAYOUT_STATUS = {
  draft: { label: "Scheduled", tone: "wait" as const },
  held: { label: "On hold", tone: "warn" as const },
  released: { label: "On its way", tone: "wait" as const },
  paid: { label: "Paid", tone: "ok" as const },
};

function PayoutRow({ payout }: { payout: Payout }) {
  const [error, setError] = useState<string | null>(null);
  const status = PAYOUT_STATUS[payout.status];

  async function download() {
    setError(null);
    try {
      const csv = await api.getStatementCsv(payout.id);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `statement-${payout.periodStart}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-1 border-b border-[#f0f0f0] py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="tabular text-[17px] font-medium">{rupees(payout.netPaise)}</span>
          <span className="text-xs text-muted">{dayRange(payout.periodStart, payout.periodEnd)}</span>
        </span>
        <StatusChip tone={status.tone}>
          {status.label}
          {payout.paidAt ? ` ${shortDate(payout.paidAt)}` : ""}
        </StatusChip>
        {(payout.status === "paid" || payout.status === "released") && (
          <button type="button" aria-label={`Download statement for ${dayRange(payout.periodStart, payout.periodEnd)}`} onClick={download} className="min-h-11 text-[13px] font-medium underline">
            CSV
          </button>
        )}
      </div>
      <FormError message={error} />
    </div>
  );
}

function Money({ outlet }: { outlet: VendorOutlet }) {
  const accountId = outlet.payoutAccountId;
  const earnings = useQuery(() => api.getEarnings(accountId!), [accountId], { enabled: !!accountId });
  const now = useNow(60_000);

  if (!accountId) return <p className="text-sm text-muted">This outlet has no payout account yet.</p>;
  if (earnings.loading) return <Skeleton className="h-40 rounded-[22px]" />;
  if (!earnings.data) return <ErrorState message={errorMessage(earnings.error)} onRetry={earnings.reload} />;

  const { thisWeek, payouts } = earnings.data;
  const lines: [string, string][] = [
    ["Sales", rupees(thisWeek.grossPaise)],
    [`Commission ${COMMISSION_PERCENT}%`, `− ${rupees(thisWeek.commissionPaise)}`],
    ["Payment charges", `− ${rupees(thisWeek.feesPaise)}`],
  ];
  if (thisWeek.taxPaise) lines.push(["Tax withheld", `− ${rupees(thisWeek.taxPaise)}`]);
  if (thisWeek.adjustmentPaise) lines.push(["Adjustments", rupees(thisWeek.adjustmentPaise)]);

  return (
    <>
      <span className="text-[13px] text-muted">{outlet.brandName ? `${outlet.brandName} · ` : ""}paid weekly</span>
      <section className="flex flex-col gap-1 rounded-[22px] bg-dark p-5 text-white">
        <span className="text-[13px] text-dark-sub">Next payout{now === null ? "" : ` · ${nextTuesday(now)}`}</span>
        <span className="tabular text-[38px] font-black text-coral">{rupees(thisWeek.netPaise)}</span>
        <span className="text-[13px] text-dark-sub">{thisWeek.orders} bags so far</span>
      </section>

      <div className="grid gap-3.5 lg:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-[22px] p-4 shadow-card">
          <h2 className="text-[17px] font-medium">This week</h2>
          {lines.map(([label, value]) => (
            <span key={label} className="tabular flex justify-between text-sm">
              <span className="text-body">{label}</span>
              <span>{value}</span>
            </span>
          ))}
          <span className="tabular flex justify-between border-t border-line pt-2 text-[15px] font-medium">
            <span>You receive</span>
            <span>{rupees(thisWeek.netPaise)}</span>
          </span>
        </section>

        <section className="flex flex-col gap-1 rounded-[22px] p-4 shadow-card">
          <h2 className="text-[17px] font-medium">Past payouts</h2>
          {payouts.length > 0 ? payouts.map((payout) => <PayoutRow key={payout.id} payout={payout} />) : <p className="py-3 text-sm text-muted">Your first payout will appear here.</p>}
        </section>
      </div>
    </>
  );
}

export default function VendorEarnings() {
  return <VendorShell title="Earnings">{(outlet) => <Money key={outlet.id} outlet={outlet} />}</VendorShell>;
}
