"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AreaPicker, ListingCard, useCities } from "@/components/customer";
import { Illo } from "@/components/Illo";
import { LinkButton, Logo } from "@/components/ui";
import { brand } from "@/config/brand";
import { api, type City } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { usePlace } from "@/lib/location";

const STEPS = [
  { title: "Reserve a bag", short: "We hold it for 5 minutes while you pay.", long: "Pick a bag from tonight’s listings. We hold it for 5 minutes while you pay." },
  { title: "Pay online", short: "UPI, card or netbanking. Get a pickup code.", long: "UPI, card or netbanking. You get a short pickup code by WhatsApp and SMS." },
  { title: "Collect this evening", short: "Show the code at the counter. No delivery.", long: "Show your code at the counter during the pickup window." },
];

const FAQ = [
  ["What’s in a Surprise Bag?", "Whatever didn’t sell today, so it changes daily. It’s only veg or allergen-free if the vendor marks it. Want to know exactly? Choose a Fixed box."],
  ["What if I miss my pickup?", "The food can’t be held, so missed pickups are forfeited. We remind you before your window opens."],
  ["What if the vendor cancels?", "You’re refunded in full, automatically, to the way you paid."],
  ["Is there delivery?", "No. Every order is collected in person, which keeps prices low."],
];

function useCityBags(cities: City[] | undefined) {
  return useQuery(
    async () => {
      const lists = await Promise.all((cities ?? []).map((city) => api.getDrops({ city: city.slug })));
      return Object.fromEntries((cities ?? []).map((city, i) => [city.slug, lists[i]]));
    },
    [cities?.length ?? 0],
    { enabled: !!cities },
  );
}

export default function Landing() {
  const cities = useCities();
  const bags = useCityBags(cities.data);
  const [place, setPlace] = usePlace();
  const [picking, setPicking] = useState(false);
  const router = useRouter();

  const count = (slug: string) => bags.data?.[slug]?.reduce((sum, drop) => sum + drop.remaining, 0) ?? 0;
  const total = cities.data?.reduce((sum, city) => sum + count(city.slug), 0) ?? 0;
  const cityName = cities.data?.find((c) => c.slug === place.city)?.name ?? "";
  const tonight = (bags.data?.[place.city] ?? []).filter((d) => !place.area || d.area === place.area).slice(0, 4);
  const sample = tonight[0];

  return (
    <>
      {/* Mobile welcome */}
      <div className="flex min-h-dvh flex-col lg:hidden">
        <div className="flex items-center justify-between px-4 pb-2.5 pt-[18px]">
          <Logo />
          <div role="group" aria-label="City" className="flex rounded-full border border-line p-1">
            {cities.data?.map((city) => (
              <button
                key={city.slug}
                type="button"
                aria-pressed={city.slug === place.city}
                onClick={() => setPlace({ city: city.slug, area: null })}
                className={`min-h-10 rounded-full px-3.5 text-[13px] font-medium ${city.slug === place.city ? "bg-dark text-white" : "text-ink"}`}
              >
                {city.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-1.5">
          <section className="relative flex h-[330px] flex-none flex-col justify-between overflow-hidden rounded-[26px] bg-dark px-5 py-6 text-white">
            <div className="absolute -bottom-10 -right-[50px] flex size-[250px] items-center justify-center rounded-full bg-dark-2">
              <Illo kind="bakery" size={200} />
            </div>
            <span className="tabular relative inline-flex items-center gap-2 self-start rounded-full bg-white/10 px-3 py-1.5 text-[13px]">
              <span className="size-2 rounded-full bg-coral" />
              {count(place.city)} bags left in {cityName} tonight
            </span>
            <div className="relative flex max-w-[230px] flex-col gap-2.5">
              <h1 className="text-[32px] font-bold leading-[1.08] tracking-tight">Good food at closing-time prices</h1>
              <p className="text-sm leading-normal text-dark-sub">Bakeries, cafés and restaurants list what’s left. You collect it on your way home.</p>
            </div>
          </section>

          <ol className="flex flex-col gap-2">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex items-center gap-3.5 rounded-[18px] bg-fill p-3">
                <span className="flex size-10 flex-none items-center justify-center rounded-full bg-coral font-bold text-on-coral">{index + 1}</span>
                <span className="flex flex-col gap-0.5">
                  <strong className="text-[15px] font-medium">{step.title}</strong>
                  <span className="text-[13px] text-muted">{step.short}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="sticky bottom-0 flex flex-col items-center gap-1.5 bg-white px-4 pb-6 pt-2.5">
          <Link href="/browse" className="flex h-14 w-full flex-col items-center justify-center rounded-full bg-coral leading-tight text-on-coral no-underline">
            <span className="text-base font-medium">See what’s left tonight</span>
            <span className="text-[11px]">No account needed to browse</span>
          </Link>
          <Link href="/partner" className="flex min-h-10 items-center text-sm text-muted no-underline">
            Own a bakery or café?&nbsp;<strong className="font-medium text-ink underline">Become a partner</strong>
          </Link>
        </div>
      </div>

      {/* Desktop landing */}
      <div className="hidden lg:block">
        <header className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-6 py-[18px]">
          <Logo />
          <nav aria-label="Main" className="flex items-center gap-1.5 text-[15px]">
            <Link href="/browse" className="flex min-h-11 items-center px-3 no-underline">
              Browse
            </Link>
            <a href="#how" className="flex min-h-11 items-center px-3 no-underline">
              How it works
            </a>
            <Link href="/partner" className="flex min-h-11 items-center px-3 no-underline">
              For partners
            </Link>
            <LinkButton href="/browse" size="md">
              See tonight’s bags
            </LinkButton>
          </nav>
        </header>

        <section className="mx-auto max-w-[1200px] px-6 pt-2">
          <div className="relative flex items-center gap-8 overflow-hidden rounded-[32px] bg-dark px-12 py-14 text-white">
            <div className="relative flex flex-[1_1_420px] flex-col gap-5">
              <span className="tabular inline-flex items-center gap-2 self-start rounded-full bg-white/10 px-3.5 py-2 text-sm">
                <span className="size-2 rounded-full bg-coral" />
                {total} bags left tonight in Bengaluru &amp; Hyderabad
              </span>
              <h1 className="text-[clamp(36px,5vw,60px)] font-black leading-[1.04] tracking-tight">Good food at closing-time prices</h1>
              <p className="max-w-[520px] text-lg leading-[1.55] text-dark-sub">
                Bakeries, cafés and restaurants list what’s left each evening. Reserve, pay online, and collect it on your way home. No delivery.
              </p>
              <div className="flex max-w-[520px] gap-2">
                <button
                  type="button"
                  onClick={() => setPicking(true)}
                  className="h-14 flex-1 truncate rounded-full bg-white px-[22px] text-left text-base text-ink"
                >
                  {place.area ? `${place.area}, ${cityName}` : `All areas, ${cityName || "choose a city"}`}
                </button>
                <button type="button" onClick={() => router.push("/browse")} className="h-14 rounded-full bg-coral px-[26px] text-base font-medium text-on-coral">
                  Find bags
                </button>
              </div>
            </div>
            <div aria-hidden="true" className="relative h-[340px] flex-[1_1_340px]">
              <div className="absolute right-0 top-0 size-[340px] rounded-full bg-dark-2" />
              <div className="absolute right-10 top-[30px]">
                <Illo kind="bakery" size={270} />
              </div>
              {sample && (
                <span className="absolute bottom-[30px] left-2.5 flex flex-col gap-0.5 rounded-[20px] bg-white px-[18px] py-3.5 text-ink shadow-[0_10px_30px_rgba(0,0,0,0.3)]">
                  <span className="text-[13px] text-muted">{sample.name}</span>
                  <span className="text-2xl font-black">
                    {rupees(sample.pricePaise)} <s className="text-sm font-normal text-faint">{rupees(sample.valuePaise)}</s>
                  </span>
                </span>
              )}
            </div>
          </div>
        </section>

        <section id="how" className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 pt-16">
          <h2 className="text-[34px] font-bold">How it works</h2>
          <div className="grid grid-cols-3 gap-4">
            {STEPS.map((step, index) => (
              <div key={step.title} className="flex flex-col gap-2.5 rounded-3xl bg-fill p-6">
                <span className="flex size-11 items-center justify-center rounded-full bg-coral text-lg font-black text-on-coral">{index + 1}</span>
                <strong className="text-xl font-bold">{step.title}</strong>
                <span className="text-[15px] leading-[1.55] text-body">{step.long}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 pt-16">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[34px] font-bold">Tonight in {place.area ?? cityName}</h2>
            <Link href="/browse" className="text-base font-medium">
              See all {count(place.city)} ›
            </Link>
          </div>
          <div className="grid grid-cols-4 gap-4">
            {tonight.map((drop) => (
              <ListingCard key={drop.id} drop={drop} />
            ))}
          </div>
        </section>

        <section className="mx-auto grid max-w-[1200px] grid-cols-2 gap-4 px-6 pt-16">
          {cities.data?.map((city) => (
            <Link
              key={city.slug}
              href="/browse"
              onClick={() => setPlace({ city: city.slug, area: null })}
              className="flex flex-col gap-2 rounded-3xl bg-fill p-7 no-underline"
            >
              <strong className="text-[26px] font-bold">{city.name}</strong>
              <span className="text-[15px] text-body">{city.areas.map((area) => area.name).join(" · ")}</span>
              <span className="text-sm font-medium text-[#9a3412]">{count(city.slug)} bags tonight ›</span>
            </Link>
          ))}
        </section>

        <section className="mx-auto max-w-[1200px] px-6 pt-16">
          <div className="flex items-center justify-between gap-6 rounded-[32px] bg-coral p-10 text-on-coral">
            <div className="flex flex-col gap-2.5">
              <h2 className="text-[34px] font-black">Run a bakery, café or restaurant?</h2>
              <span className="text-[17px] leading-normal">Sell tonight’s surplus. Set a quantity in under a minute; customers pay before they arrive.</span>
            </div>
            <LinkButton href="/partner" variant="dark" className="flex-none">
              Become a partner
            </LinkButton>
          </div>
        </section>

        <section className="mx-auto flex max-w-[820px] flex-col gap-2.5 px-6 pt-16">
          <h2 className="mb-2.5 text-[34px] font-bold">Questions</h2>
          {FAQ.map(([question, answer], index) => (
            <details key={question} open={index === 0} className="rounded-[18px] bg-fill px-5">
              <summary className="flex min-h-[60px] items-center text-[17px] font-medium">{question}</summary>
              <p className="mb-[18px] text-[15px] leading-relaxed text-body">{answer}</p>
            </details>
          ))}
        </section>

        <footer className="mx-auto flex max-w-[1200px] justify-between gap-4 px-6 pb-10 pt-14 text-sm text-body">
          <span>
            © 2026 {brand.name} · Bengaluru &amp; Hyderabad
          </span>
          <nav aria-label="Footer" className="flex gap-[18px]">
            <Link href="/help">Refund policy and help</Link>
            <Link href="/partner">Partners</Link>
          </nav>
        </footer>
      </div>

      {picking && <AreaPicker onClose={() => setPicking(false)} />}
    </>
  );
}
