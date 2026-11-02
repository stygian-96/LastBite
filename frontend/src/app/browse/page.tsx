"use client";

import { useState } from "react";
import { ActiveOrderStrip, AreaPicker, cityName, CustomerShell, ListingCard, useCities } from "@/components/customer";
import { Illo, type IlloKind } from "@/components/Illo";
import { Button, CardGridSkeleton, Chip, ErrorState, Notice, SlowBanner } from "@/components/ui";
import { api, errorMessage, type FoodCategory } from "@/lib/api";
import { useDebounced, useQuery } from "@/lib/hooks";
import { usePlace } from "@/lib/location";

const CATEGORIES: { id: FoodCategory | "all"; label: string; kind: IlloKind }[] = [
  { id: "all", label: "All", kind: "bakery" },
  { id: "bakery", label: "Bakery", kind: "bakery" },
  { id: "cafe", label: "Café", kind: "cafe" },
  { id: "meals", label: "Meals", kind: "meals" },
  { id: "desserts", label: "Desserts", kind: "desserts" },
];

function SearchIcon({ color = "#111111" }: { color?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  );
}

export default function Browse() {
  const cities = useCities();
  const [place, setPlace] = usePlace();
  const [picking, setPicking] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<FoodCategory | "all">("all");
  const [veg, setVeg] = useState(false);
  const [early, setEarly] = useState(false);
  const [cheap, setCheap] = useState(false);
  const search = useDebounced(q.trim());

  const drops = useQuery(
    () =>
      api.getDrops({
        city: place.city,
        area: place.area ?? undefined,
        category: category === "all" ? undefined : category,
        veg,
        pickup_by: early ? "21:00" : undefined,
        max_price: cheap ? 15000 : undefined,
        q: search || undefined,
      }),
    [place, category, veg, early, cheap, search],
  );

  const filtered = category !== "all" || !!search || veg || early || cheap;
  const reset = () => {
    setCategory("all");
    setQ("");
    setVeg(false);
    setEarly(false);
    setCheap(false);
  };

  const city = cityName(cities.data, place.city);
  const where = place.area ?? city;
  const list = drops.data ?? [];
  const bags = list.reduce((sum, drop) => sum + drop.remaining, 0);
  const heading = search
    ? `Results for “${search}”`
    : category === "all"
      ? `Tonight in ${where}`
      : `${CATEGORIES.find((c) => c.id === category)!.label} tonight`;

  const picker = (
    <button
      type="button"
      onClick={() => setPicking(true)}
      className="flex min-h-11 flex-col items-start gap-0.5 lg:h-11 lg:flex-row lg:items-center lg:rounded-full lg:border lg:border-[#e6e6e6] lg:px-3.5"
    >
      <span className="text-xs text-muted lg:hidden">Pickup in</span>
      <span className="flex items-center gap-1.5 text-[15px] font-medium lg:text-sm">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 22s-7-6.4-7-12a7 7 0 0 1 14 0c0 5.6-7 12-7 12z" fill="#FF6B5B" />
          <circle cx="12" cy="10" r="2.6" fill="#111111" />
        </svg>
        {place.area ? `${place.area}, ${city}` : `All areas, ${city}`}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2.2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </button>
  );

  const searchBox = (
    <div className="flex h-[50px] items-center gap-2.5 rounded-2xl bg-fill pl-3.5 pr-1.5 lg:h-11 lg:flex-1 lg:rounded-full">
      <SearchIcon color="#6B6B6B" />
      <label htmlFor="search" className="sr-only">
        Search
      </label>
      <input
        id="search"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder="Search bags, vendors, areas"
        className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
      />
      {q && (
        <button type="button" aria-label="Clear" onClick={() => setQ("")} className="size-[38px] rounded-xl bg-white text-base font-medium lg:size-8 lg:rounded-full">
          ×
        </button>
      )}
    </div>
  );

  const chips = (
    <>
      <Chip on={veg} onClick={() => setVeg(!veg)}>
        Veg only
      </Chip>
      <Chip on={early} onClick={() => setEarly(!early)}>
        Pickup by 9 pm
      </Chip>
      <Chip on={cheap} onClick={() => setCheap(!cheap)}>
        Under ₹150
      </Chip>
    </>
  );

  return (
    <CustomerShell
      header={
        <>
          {picker}
          {searchBox}
        </>
      }
    >
      <div className="flex items-center justify-between px-4 pb-2.5 pt-[18px] lg:hidden">
        {picker}
        <button
          type="button"
          aria-label="Search"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen(!searchOpen);
            setQ("");
          }}
          className={`flex size-11 items-center justify-center rounded-full border border-line ${searchOpen ? "bg-coral" : "bg-white"}`}
        >
          <SearchIcon />
        </button>
      </div>
      {searchOpen && <div className="mx-4 mb-2 lg:hidden">{searchBox}</div>}

      <div className="flex-1 pb-4">
        <div role="tablist" aria-label="Category" className="no-scrollbar flex gap-2.5 overflow-x-auto px-4 pb-1 pt-2 lg:hidden">
          {CATEGORIES.map(({ id, label, kind }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={category === id}
              onClick={() => setCategory(id)}
              className={`flex h-[78px] w-[72px] flex-none flex-col items-center justify-center gap-1 rounded-[18px] border text-xs shadow-[0_2px_8px_rgba(0,0,0,0.04)] ${
                category === id ? "border-coral bg-coral text-on-coral" : "border-[#f0f0f0] bg-white text-ink"
              }`}
            >
              <Illo kind={kind} size={34} />
              {label}
            </button>
          ))}
        </div>

        <div role="group" aria-label="Filters" className="no-scrollbar flex gap-2 overflow-x-auto px-4 pt-2.5 lg:hidden">
          {chips}
        </div>

        <div className="hidden flex-wrap items-center gap-2 border-b border-[#f0f0f0] px-6 py-3.5 lg:flex">
          {CATEGORIES.map(({ id, label }) => (
            <Chip key={id} on={category === id} onClick={() => setCategory(id)}>
              {label}
            </Chip>
          ))}
          {chips}
        </div>

        <div className="mx-auto w-full max-w-[1400px]">
          <div className="flex items-baseline justify-between px-4 pb-2.5 pt-3.5 lg:px-6 lg:pt-5">
            <h2 className="text-lg font-medium">{heading}</h2>
            <span className="flex items-baseline gap-3">
              {!drops.loading && !drops.error && <span className="tabular text-[13px] text-muted">{bags} {bags === 1 ? "bag" : "bags"}</span>}
              {filtered && (
                <button type="button" onClick={reset} className="min-h-8 text-[13px] text-muted underline">
                  Clear
                </button>
              )}
            </span>
          </div>

          <div className="flex flex-col gap-3 px-4 lg:px-6">
            {drops.slow && <SlowBanner onRetry={drops.reload} />}
            {drops.loading ? (
              <CardGridSkeleton count={6} />
            ) : drops.error ? (
              <ErrorState message={errorMessage(drops.error)} onRetry={drops.reload} />
            ) : list.length === 0 ? (
              filtered ? (
                <div className="flex flex-col items-center gap-2 rounded-[18px] bg-fill px-4 py-7 text-center">
                  <span className="text-base font-medium">Nothing matches</span>
                  <span className="text-[13px] text-muted">New bags usually appear 5–8 pm.</span>
                  <Button size="md" onClick={reset}>
                    Show everything
                  </Button>
                </div>
              ) : (
                <div className="mx-auto w-full max-w-md">
                  <Notice big="0" band={`bags in ${where} right now`} title="Nothing here yet tonight">
                    <p className="text-[13px] leading-normal text-body">Most vendors list between 5 and 8 pm. Try another area, or check back soon.</p>
                    {place.area && (
                      <Button size="md" onClick={() => setPlace({ city: place.city, area: null })}>
                        See all of {city}
                      </Button>
                    )}
                  </Notice>
                </div>
              )
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] lg:gap-4">
                {list.map((drop) => (
                  <ListingCard key={drop.id} drop={drop} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ActiveOrderStrip />
      {picking && <AreaPicker onClose={() => setPicking(false)} />}
    </CustomerShell>
  );
}
