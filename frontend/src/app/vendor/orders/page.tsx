"use client";

import { useState, type FormEvent } from "react";
import { ErrorState, Skeleton, SlowBanner } from "@/components/ui";
import { codeError, OrderList, VendorShell } from "@/components/vendor";
import { api, errorMessage, type Order, type VendorOutlet } from "@/lib/api";
import { useDebounced, useQuery } from "@/lib/hooks";

function Counter({ outlet }: { outlet: VendorOutlet }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Order | null>(null);
  const [problem, setProblem] = useState<{ title: string; body: string } | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const orders = useQuery(() => api.getVendorOrders(outlet.id, { q: q || undefined }), [outlet.id, q], { pollMs: 30_000 });

  async function check(event: FormEvent) {
    event.preventDefault();
    const typed = code.trim();
    setBusy(true);
    setDone(null);
    setProblem(null);
    try {
      setDone(await api.collectByCode(outlet.id, typed));
      setCode("");
      orders.reload();
    } catch (err) {
      setProblem(codeError(err, typed));
    } finally {
      setBusy(false);
    }
  }

  const list = orders.data ?? [];
  const left = list.filter((order) => order.status === "paid").length;

  return (
    <>
      <form onSubmit={check} className="flex flex-col gap-2.5 rounded-[22px] bg-dark p-4 text-white">
        <span className="text-[15px] font-medium">Check a pickup code</span>
        <div className="flex gap-2">
          <label htmlFor="code" className="sr-only">
            Pickup code
          </label>
          <input
            id="code"
            value={code}
            maxLength={4}
            autoCapitalize="characters"
            placeholder="K472"
            onChange={(event) => {
              setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
              setProblem(null);
            }}
            className="tabular h-14 min-w-0 flex-1 rounded-2xl bg-white px-4 text-2xl font-black tracking-[0.1em] text-ink placeholder:text-[#c9c9c9]"
          />
          <button type="submit" disabled={code.length !== 4 || busy} className="h-14 flex-none rounded-2xl bg-coral px-4 text-sm font-medium text-on-coral disabled:opacity-60">
            Hand over
          </button>
        </div>
        <span className="text-xs text-dark-sub">This marks the order collected if the code matches.</span>
        {done && (
          <div role="status" className="rounded-2xl bg-ok-bg p-3 text-[13px] text-ok-fg">
            <strong className="block text-sm font-medium">Valid · hand it over</strong>
            {done.name} × 1 · #{done.number}
          </div>
        )}
        {problem && (
          <div role="alert" className="rounded-2xl bg-warn-bg p-3 text-[13px] leading-normal text-warn-fg">
            <strong className="block text-sm font-medium">{problem.title}</strong>
            {problem.body}
          </div>
        )}
      </form>

      <div className="flex items-baseline justify-between pt-1">
        <h2 className="text-[17px] font-medium">Tonight</h2>
        <span className="tabular text-[13px] text-muted">{left} to collect</span>
      </div>
      <label htmlFor="find" className="sr-only">
        Find by customer name
      </label>
      <input
        id="find"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Find by customer name"
        className="h-11 rounded-full bg-fill px-4 text-sm"
      />

      {orders.slow && <SlowBanner onRetry={orders.reload} />}
      {orders.loading ? (
        <Skeleton className="h-32 rounded-[18px]" />
      ) : orders.error ? (
        <ErrorState message={errorMessage(orders.error)} onRetry={orders.reload} />
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{q ? "Nobody by that name tonight." : "No orders yet tonight."}</p>
      ) : (
        <OrderList orders={list} onChanged={orders.reload} />
      )}
    </>
  );
}

export default function VendorOrders() {
  return <VendorShell title="Orders">{(outlet) => <Counter key={outlet.id} outlet={outlet} />}</VendorShell>;
}
