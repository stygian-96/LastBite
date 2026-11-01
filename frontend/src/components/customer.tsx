"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, type City, type Drop, type Order } from "@/lib/api";
import { initials, orderNumber, rupees, timeRange } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { usePlace } from "@/lib/location";
import { useSession } from "@/lib/session";
import { Illo, illoFor, type IlloKind } from "./Illo";
import { DietBadge, Logo, Sheet, Tabs } from "./ui";

export function useActiveOrders() {
  const { me } = useSession();
  return useQuery(() => api.getMyOrders("active"), [me?.id], { enabled: !!me });
}

export function useCities() {
  return useQuery(() => api.getCities(), []);
}

export function placeLabel(cities: City[] | undefined, city: string, areaId: string | null) {
  const found = cities?.find((c) => c.id === city);
  const area = found?.areas.find((a) => a.id === areaId);
  return { city: found?.name ?? "", area: area?.name ?? null };
}

function HomeIcon({ on }: { on: boolean }) {
  return on ? (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" fill="#111111" />
      <rect x="9" y="14" width="6" height="2" rx="1" fill="#FF6B5B" />
    </svg>
  ) : (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function OrdersIcon({ on }: { on: boolean }) {
  return on ? (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2" fill="#111111" />
      <path d="M9 8h6M9 12h6" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="9" y="15" width="6" height="2" rx="1" fill="#FF6B5B" />
    </svg>
  ) : (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  );
}

function ProfileIcon({ on }: { on: boolean }) {
  return on ? (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" fill="#111111" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6z" fill="#111111" />
      <rect x="9" y="17" width="6" height="2" rx="1" fill="#FF6B5B" />
    </svg>
  ) : (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" strokeLinecap="round" />
    </svg>
  );
}

function BottomNav({ activeCount }: { activeCount: number }) {
  const path = usePathname();
  const items = [
    { href: "/browse", label: "Home", on: path === "/browse", Icon: HomeIcon, badge: 0 },
    { href: "/orders", label: "Orders", on: path.startsWith("/orders"), Icon: OrdersIcon, badge: activeCount },
    { href: "/profile", label: "Profile", on: path === "/profile", Icon: ProfileIcon, badge: 0 },
  ];
  return (
    <nav aria-label="Main" className="sticky bottom-0 z-10 grid grid-cols-3 rounded-t-3xl bg-white px-3 pb-5 pt-2 shadow-nav lg:hidden">
      {items.map(({ href, label, on, Icon, badge }) => (
        <Link
          key={href}
          href={href}
          aria-current={on ? "page" : undefined}
          aria-label={badge ? `${label}, ${badge} active` : undefined}
          className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-xs no-underline ${on ? "font-medium text-ink" : "text-muted"}`}
        >
          <span className="relative flex">
            <Icon on={on} />
            {badge > 0 && (
              <span className="absolute -right-[9px] -top-1 flex h-4 min-w-4 items-center justify-center rounded-lg bg-coral text-[10px] font-bold text-on-coral">
                {badge}
              </span>
            )}
          </span>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function SiteHeader({ children }: { children?: ReactNode }) {
  const { me } = useSession();
  return (
    <header className="hidden flex-wrap items-center gap-4 border-b border-[#f0f0f0] px-6 py-4 lg:flex">
      <Link href="/" className="no-underline">
        <Logo size="sm" />
      </Link>
      <div className="flex flex-1 items-center gap-4">{children}</div>
      <Link href="/orders" className="flex min-h-11 items-center px-3.5 text-sm no-underline">
        Orders
      </Link>
      <Link
        href="/profile"
        aria-label="Profile"
        className="flex size-11 items-center justify-center rounded-full bg-coral font-bold text-on-coral no-underline"
      >
        {me ? initials(me.name) : <ProfileIcon on={false} />}
      </Link>
    </header>
  );
}

// Mobile bottom bar plus desktop header. Focused flows (details, checkout) pass nav={false}.
export function CustomerShell({
  children,
  nav = true,
  header,
}: {
  children: ReactNode;
  nav?: boolean;
  header?: ReactNode;
}) {
  const active = useActiveOrders();
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>{header}</SiteHeader>
      <main className="flex w-full flex-1 flex-col">{children}</main>
      {nav && <BottomNav activeCount={countable(active.data).length} />}
    </div>
  );
}

function countable(orders: Order[] | undefined) {
  return (orders ?? []).filter((o) => o.status === "paid" || o.status === "held");
}

export function ActiveOrderStrip() {
  const active = useActiveOrders();
  const order = active.data?.find((o) => o.status === "paid");
  if (!order) return null;
  return (
    <Link
      href={`/orders/${order.id}`}
      aria-label={`Show pickup code ${order.pickup_code}. Pickup ${timeRange(order.pickup_start_at, order.pickup_end_at)} at ${order.outlet.brand_name}`}
      className="sticky bottom-[84px] z-10 mx-3 mb-2 flex min-h-[60px] items-center gap-3 rounded-[18px] bg-dark py-2 pl-2 pr-3.5 text-white no-underline lg:bottom-4 lg:mx-auto lg:w-[400px]"
    >
      <span className="rounded-xl bg-coral px-2.5 py-2 text-[17px] font-bold tracking-[0.04em] text-on-coral">{order.pickup_code}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-sm font-medium">Pick up {timeRange(order.pickup_start_at, order.pickup_end_at)}</span>
        <span className="truncate text-xs text-dark-sub">{order.outlet.brand_name} · show code</span>
      </span>
      <span aria-hidden="true" className="text-xl">
        ›
      </span>
    </Link>
  );
}

export function bagsLeft(drop: Pick<Drop, "quantity" | "reserved_count">) {
  return Math.max(0, drop.quantity - drop.reserved_count);
}

export function leftText(left: number) {
  if (left === 0) return "Sold out";
  return left === 1 ? "Last one" : `${left} left`;
}

export function Photo({
  kind,
  src,
  alt,
  height,
  illo,
  rounded = "rounded-xl",
}: {
  kind: IlloKind;
  src?: string;
  alt: string;
  height: string;
  illo: number;
  rounded?: string;
}) {
  return (
    <span className={`relative block w-full overflow-hidden bg-fill-2 ${height} ${rounded}`}>
      {src ? (
        // Vendor photos come from signed links on another host.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="block size-full object-cover" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center">
          <Illo kind={kind} size={illo} />
        </span>
      )}
    </span>
  );
}

export function ListingCard({ drop }: { drop: Drop }) {
  const left = bagsLeft(drop);
  const kind = illoFor(drop.food_category, drop.outlet.category);
  const window = timeRange(drop.pickup_start_at, drop.pickup_end_at);
  return (
    <Link
      href={`/listing/${drop.id}`}
      aria-label={`${drop.name}, ${drop.outlet.brand_name}, ${rupees(drop.price_paise)}, pickup ${window}`}
      className={`flex flex-col gap-1.5 rounded-[18px] bg-white px-3 pb-3 pt-2.5 no-underline shadow-card lg:gap-2 lg:rounded-[20px] lg:p-3 ${left === 0 ? "opacity-55" : ""}`}
    >
      <span className="relative block">
        <Photo kind={kind} src={drop.photo_urls[0]} alt={drop.name} height="h-[104px] lg:h-[140px]" illo={96} />
        <span className="absolute left-1.5 top-1.5">
          <DietBadge diet={drop.diet} />
        </span>
      </span>
      <span className="truncate text-sm font-medium lg:text-base">{drop.name}</span>
      <span className="truncate text-xs text-muted lg:text-[13px]">
        {drop.outlet.brand_name} · {drop.outlet.area_name}
      </span>
      <span className="tabular text-xs lg:text-[13px]">Pickup {window}</span>
      <span className="flex items-center justify-between">
        <span className="tabular flex items-baseline gap-1.5">
          <span className="text-lg font-medium lg:text-xl lg:font-bold">{rupees(drop.price_paise)}</span>
          <s className="text-xs text-faint">{rupees(drop.value_paise)}</s>
        </span>
        <span className={`tabular text-xs font-medium ${left <= 2 ? "text-danger" : "text-ink"}`}>{leftText(left)}</span>
      </span>
    </Link>
  );
}

export function MiniOrderCard({
  kind,
  title,
  sub,
  price,
  was,
}: {
  kind: IlloKind;
  title: string;
  sub: string;
  price: number;
  was?: number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[18px] p-3 shadow-card">
      <span className="flex size-14 flex-none items-center justify-center rounded-[14px] bg-fill-2">
        <Illo kind={kind} size={44} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-medium">{title}</span>
        <span className="text-xs text-muted">{sub}</span>
      </span>
      <span className="tabular flex flex-col items-end">
        <span className="text-[17px] font-bold">{rupees(price)}</span>
        {was !== undefined && <s className="text-xs text-faint">{rupees(was)}</s>}
      </span>
    </div>
  );
}

export function AreaPicker({ onClose }: { onClose: () => void }) {
  const cities = useCities();
  const [place, setPlace] = usePlace();
  const [city, setCity] = useState(place.city);
  const areas = cities.data?.find((c) => c.id === city)?.areas ?? [];
  const pick = (areaId: string | null) => {
    setPlace({ city, areaId });
    onClose();
  };
  const row = "flex min-h-[52px] items-center justify-between border-b border-[#f0f0f0] px-1 text-left text-[15px]";
  return (
    <Sheet title="Where do you want to pick up?" onClose={onClose}>
      {cities.data && (
        <Tabs value={city} onChange={setCity} options={cities.data.map((c) => ({ id: c.id, label: c.name }))} />
      )}
      <div className="flex flex-col">
        <button type="button" className={row} onClick={() => pick(null)}>
          All areas
          {place.city === city && !place.areaId && <Tick />}
        </button>
        {areas.map((area) => (
          <button key={area.id} type="button" className={row} onClick={() => pick(area.id)}>
            {area.name}
            {place.city === city && place.areaId === area.id && <Tick />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function Tick() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-label="Selected">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function orderRef(order: Pick<Order, "number">) {
  return `#${orderNumber(order.number)}`;
}
