"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Chip, ErrorState, LinkButton, Logo, PageSkeleton, Sheet, StatusChip } from "@/components/ui";
import { api, errorCode, errorDetails, errorMessage, type CancelReason, type VendorOrder, type VendorOutlet } from "@/lib/api";
import { rupees, time } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { readJson, writeJson } from "@/lib/storage";
import { FormError } from "./forms";

const TABS = [
  { href: "/vendor", label: "Today", d: "M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3L4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  { href: "/vendor/orders", label: "Orders", d: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h4" },
  { href: "/vendor/listings", label: "Listings", d: "M4 7l8-4 8 4-8 4-8-4zM4 12l8 4 8-4M4 17l8 4 8-4" },
  { href: "/vendor/earnings", label: "Earnings", d: "M7 5h10M7 9h10M10 5c3 0 5 2 5 4s-2 4-5 4H7l7 7" },
];

const KEY = "lb_vendor_outlet";

function OutletSwitcher({ outlets, value, onChange }: { outlets: VendorOutlet[]; value: VendorOutlet; onChange: (id: string) => void }) {
  if (outlets.length < 2) {
    return (
      <span className="truncate text-[13px] text-muted">
        {value.brandName ? `${value.brandName} · ` : ""}
        {value.branchName}
      </span>
    );
  }
  return (
    <>
      <label htmlFor="outlet" className="sr-only">
        Outlet
      </label>
      <select id="outlet" value={value.id} onChange={(event) => onChange(event.target.value)} className="h-10 w-full max-w-[260px] rounded-full border border-[#e6e6e6] bg-white px-3 text-[13px] font-medium">
        {outlets.map((outlet) => (
          <option key={outlet.id} value={outlet.id}>
            {outlet.brandName ? `${outlet.brandName} · ` : ""}
            {outlet.branchName}
          </option>
        ))}
      </select>
    </>
  );
}

// Dashboard frame: bottom bar on mobile, sidebar on desktop, and one selected outlet.
export function VendorShell({ title, children }: { title: string; children: (outlet: VendorOutlet, outlets: VendorOutlet[]) => ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { me, loading } = useSession();
  const query = useQuery(() => api.getVendorOutlets(), [me?.id], { enabled: !!me });
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !me) router.replace(`/signin?next=${encodeURIComponent(path)}`);
  }, [loading, me, path, router]);

  useEffect(() => {
    const first = setTimeout(() => setPicked(readJson<string>(KEY)), 0);
    return () => clearTimeout(first);
  }, []);

  if (loading || !me || query.loading) return <PageSkeleton />;
  if (query.error) return <ErrorState message={errorMessage(query.error)} onRetry={query.reload} />;

  const outlets = (query.data ?? []).filter((o) => o.status === "live" || o.status === "suspended");
  if (outlets.length === 0) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 p-4 pt-10">
        <h1 className="text-2xl font-bold">No live outlet yet</h1>
        <p className="text-sm text-muted">Your dashboard opens once your application is approved.</p>
        <LinkButton href="/partner/status">See your application</LinkButton>
      </div>
    );
  }

  const outlet = outlets.find((o) => o.id === picked) ?? outlets[0];
  const pick = (id: string) => {
    setPicked(id);
    writeJson(KEY, id);
  };

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden w-60 flex-none flex-col gap-5 border-r border-[#f0f0f0] p-5 lg:flex">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <Logo size="sm" />
          <span className="text-sm text-muted">partner</span>
        </Link>
        <OutletSwitcher outlets={outlets} value={outlet} onChange={pick} />
        <nav aria-label="Dashboard" className="flex flex-col gap-1">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={path === tab.href ? "page" : undefined}
              className={`flex min-h-11 items-center rounded-xl px-3 text-sm no-underline ${path === tab.href ? "bg-dark font-medium text-white" : ""}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[18px] lg:px-8 lg:pt-7">
          <h1 className="text-2xl font-bold">{title}</h1>
          <div className="min-w-0 lg:hidden">
            <OutletSwitcher outlets={outlets} value={outlet} onChange={pick} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-3.5 px-4 pb-4 pt-1 lg:max-w-5xl lg:px-8">{children(outlet, outlets)}</div>

        <nav aria-label="Vendor" className="sticky bottom-0 z-10 grid grid-cols-4 rounded-t-3xl bg-white px-2 pb-5 pt-2 shadow-nav lg:hidden">
          {TABS.map((tab) => {
            const on = path === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={on ? "page" : undefined}
                className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-xs no-underline ${on ? "font-medium text-ink" : "text-muted"}`}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={on ? "#111111" : "#6B6B6B"} strokeWidth={on ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={tab.d} />
                </svg>
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </main>
    </div>
  );
}

export function useTonightOrders(outletId: string) {
  return useQuery(() => api.getVendorOrders(outletId), [outletId], { pollMs: 30_000 });
}

const REASONS: { id: CancelReason; label: string }[] = [
  { id: "ran_out", label: "Ran out" },
  { id: "quality", label: "Quality issue" },
  { id: "closing_early", label: "Closing early" },
];

export function CancelSheet({
  title,
  body,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  onConfirm: (reason: CancelReason) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<CancelReason>("ran_out");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <span className="text-[13px] leading-normal text-muted">{body}</span>
      <div className="flex flex-wrap gap-2">
        {REASONS.map((option) => (
          <Chip key={option.id} on={reason === option.id} onClick={() => setReason(option.id)}>
            {option.label}
          </Chip>
        ))}
      </div>
      <FormError message={error} />
      <Button variant="danger" onClick={confirm} disabled={busy}>
        Cancel and refund
      </Button>
      <Button variant="quiet" onClick={onClose}>
        Keep it
      </Button>
    </Sheet>
  );
}

const ORDER_STATUS = {
  paid: { label: "To collect", tone: "wait" as const },
  collected: { label: "Collected", tone: "ok" as const },
  no_show: { label: "No-show", tone: "info" as const },
};

export function OrderList({ orders, onChanged }: { orders: VendorOrder[]; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState<VendorOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <FormError message={error} />
      {orders.map((order) => {
        const status = ORDER_STATUS[order.status];
        return (
          <div key={order.id} className="flex flex-col gap-2.5 rounded-[18px] p-3 shadow-card">
            <div className="flex items-center gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-medium">{order.customerLabel}</span>
                <span className="truncate text-xs text-muted">
                  {order.dropName} × 1 · #{order.number}
                </span>
              </span>
              <StatusChip tone={status.tone}>
                {status.label}
                {order.collectedAt ? ` ${time(order.collectedAt)}` : ""}
              </StatusChip>
            </div>
            {order.status === "paid" && (
              <div className="flex gap-2">
                <button type="button" onClick={() => act(() => api.collectOrder(order.id))} className="h-11 flex-[2] rounded-full bg-dark text-sm font-medium text-white">
                  Mark collected
                </button>
                <button type="button" onClick={() => act(() => api.markNoShow(order.id))} className="h-11 flex-1 rounded-full bg-fill text-sm font-medium">
                  No-show
                </button>
                <button type="button" onClick={() => setCancelling(order)} className="h-11 flex-1 rounded-full bg-fill text-sm font-medium text-danger">
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}
      {cancelling && (
        <CancelSheet
          title={`Cancel ${cancelling.customerLabel}’s order?`}
          body={`They get a full ${rupees(cancelling.pricePaise)} refund automatically and a WhatsApp message. Pick a reason:`}
          onConfirm={async (reason) => {
            await api.cancelOrder(cancelling.id, reason);
            onChanged();
          }}
          onClose={() => setCancelling(null)}
        />
      )}
    </div>
  );
}

export function codeError(err: unknown, code: string): { title: string; body: string } {
  const kind = errorCode(err);
  if (kind === "code_not_found") {
    return { title: `No order “${code}” tonight`, body: "Check for a mistyped letter, or find the customer’s name below. Don’t hand over without a match." };
  }
  if (kind === "already_collected") {
    const at = errorDetails(err).collectedAt;
    return { title: "Already collected", body: `${at ? `Collected at ${time(at)}. ` : ""}This code can’t be used twice.` };
  }
  return { title: "We couldn’t check that code", body: errorMessage(err) };
}
