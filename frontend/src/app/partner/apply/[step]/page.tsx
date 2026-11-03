"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useCities } from "@/components/customer";
import { Choice, FilePick, FormError, ListingForm, TextArea } from "@/components/forms";
import { BackIcon, Button, Field, PageSkeleton, Tabs } from "@/components/ui";
import { AGREEMENT_VERSION, COMMISSION_PERCENT } from "@/config/brand";
import { api, errorCode, errorMessage, type OpeningHours, type OutletCategory, type OutletStatusView, type VendorOutlet } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

const TOTAL_STEPS = 6;

// PAN needs the payout account, which needs the bank details from the next step.
// Held in memory only, so a PAN never sits in browser storage.
let panDraft: { pan: string; fileKey: string | null } | null = null;

type StepProps = {
  outlet: VendorOutlet | null;
  status: OutletStatusView | null;
  next: () => void;
};

function Header({ step }: { step: number }) {
  return (
    <div className="flex flex-col gap-3 px-4 pb-3 pt-[18px]">
      <div className="flex items-center justify-between">
        <Link href={step === 1 ? "/partner" : `/partner/apply/${step - 1}`} aria-label="Back" className="flex size-11 items-center justify-center rounded-full border border-line">
          <BackIcon />
        </Link>
        <span className="tabular text-sm font-medium">
          Step {step} of {TOTAL_STEPS}
        </span>
        <Link href="/partner/status" className="flex min-h-11 items-center rounded-full bg-fill px-3.5 text-[13px] font-medium no-underline">
          Save &amp; exit
        </Link>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={TOTAL_STEPS} aria-valuenow={step} aria-label="Onboarding progress" className="grid grid-cols-6 gap-[5px]">
        {Array.from({ length: TOTAL_STEPS }, (_, index) => (
          <span key={index} className={`h-1.5 rounded-full ${index < step ? "bg-coral" : "bg-line"}`} />
        ))}
      </div>
      <span className="text-xs text-muted">Progress saves automatically. Come back any time.</span>
    </div>
  );
}

function Screen({ title, sub, children, footer }: { title: string; sub: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-1">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">{title}</h1>
          <span className="text-sm leading-normal text-muted">{sub}</span>
        </div>
        {children}
      </div>
      {footer && <div className="sticky bottom-0 bg-white px-4 pb-6 pt-3">{footer}</div>}
    </>
  );
}

function Account({ next }: StepProps) {
  const { me, refresh } = useSession();
  const [name, setName] = useState(me?.name ?? "");
  const [email, setEmail] = useState(me?.email ?? "");
  const signedInDigits = me?.phone.replace(/^\+91/, "") ?? "";
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, "");
  // The number is verified only when it is the one signed in; a changed number needs its own OTP.
  const verified = !!me && digits === signedInDigits;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.sendOtp(`+91${digits}`);
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    try {
      await api.verifyOtp(`+91${digits}`, code);
      await refresh();
      setSent(false);
      setOtp("");
    } catch (err) {
      setError(errorCode(err) === "otp_invalid" ? "That code isn’t right. Check the SMS and try again." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile({ name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) });
      await refresh();
      next();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const ready = verified && name.trim().length > 1;

  return (
    <Screen
      title="About you"
      sub="The owner or manager we can reach about orders and payouts."
      footer={
        <Button className="w-full" disabled={!ready || busy} onClick={save}>
          {verified ? "Continue" : "Verify your number to continue"}
        </Button>
      }
    >
      <Field id="owner" label="Owner’s full name" hint="Should match the name on your PAN." autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
        <div className="flex flex-col gap-2">
          <label htmlFor="owner-phone" className="text-[13px] font-medium text-muted">
            Mobile number
          </label>
          <div className="flex gap-2">
            <span className="flex h-14 items-center rounded-2xl bg-fill px-4 font-medium">+91</span>
            <input
              id="owner-phone"
              type="tel"
              inputMode="numeric"
              maxLength={11}
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value.replace(/[^\d ]/g, ""));
                setSent(false);
                setOtp("");
              }}
              className="tabular h-14 min-w-0 flex-1 rounded-2xl bg-fill px-4 font-medium"
            />
            {verified && (
              <span className="flex h-14 flex-none items-center rounded-2xl bg-[#dcfce7] px-3 text-[13px] font-medium text-[#166534]">Verified</span>
            )}
            {!verified && !sent && (
              <button type="button" disabled={digits.length !== 10 || busy} onClick={send} className="h-14 flex-none rounded-2xl bg-dark px-4 text-sm font-medium text-white disabled:bg-[#f0f0f0] disabled:text-muted">
                Send OTP
              </button>
            )}
          </div>
          <span className="text-[13px] text-muted">You’ll get the daily “how many tonight?” prompt here on WhatsApp.</span>
        </div>
      {!verified && sent && (
        <Field
          id="owner-otp"
          label="6-digit code sent by SMS"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={otp}
          onChange={(event) => {
            const code = event.target.value.replace(/\D/g, "").slice(0, 6);
            setOtp(code);
            if (code.length === 6) verify(code);
          }}
        />
      )}
      <Field id="owner-email" label="Email" type="email" autoComplete="email" hint="For weekly statements and your partner agreement." value={email} onChange={(event) => setEmail(event.target.value)} />
      <FormError message={error} />
    </Screen>
  );
}

const CATEGORIES: { id: OutletCategory; label: string }[] = [
  { id: "bakery", label: "Bakery" },
  { id: "cafe", label: "Café" },
  { id: "restaurant", label: "Restaurant" },
  { id: "sweets", label: "Sweet shop" },
  { id: "kitchen", label: "Kitchen / caterer" },
];

// Same hosts the backend accepts.
function isMapsUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return false;
    const underMaps = url.pathname === "/maps" || url.pathname.startsWith("/maps/");
    if (url.hostname === "maps.google.com" || url.hostname === "maps.app.goo.gl") return true;
    return (url.hostname === "www.google.com" || url.hostname === "goo.gl") && underMaps;
  } catch {
    return false;
  }
}

function everyDay(open: string, close: string): OpeningHours {
  const slot = [[open, close]];
  return { mon: slot, tue: slot, wed: slot, thu: slot, fri: slot, sat: slot, sun: slot };
}

function OutletStep({ outlet, next }: StepProps) {
  const cities = useCities();
  const [business, setBusiness] = useState(outlet?.brandName ?? "");
  const [category, setCategory] = useState<OutletCategory>(outlet?.category ?? "bakery");
  const [pickedCity, setCity] = useState<string | null>(null);
  const [areaId, setAreaId] = useState(outlet?.areaId ?? "");
  const [address, setAddress] = useState(outlet?.address ?? "");
  const [pincode, setPincode] = useState(outlet?.pincode ?? "");
  const [mapsUrl, setMapsUrl] = useState(outlet?.mapsUrl ?? "");
  const [instructions, setInstructions] = useState(outlet?.pickupInstructions ?? "");
  const firstHours = outlet?.openingHours?.mon?.[0];
  const [open, setOpen] = useState(firstHours?.[0] ?? "08:00");
  const [close, setClose] = useState(firstHours?.[1] ?? "22:00");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const city = pickedCity ?? cities.data?.find((c) => c.areas.some((a) => a.id === areaId))?.slug ?? "bengaluru";
  const areas = cities.data?.find((c) => c.slug === city)?.areas ?? [];
  const areaName = areas.find((a) => a.id === areaId)?.name;
  const mapsOk = isMapsUrl(mapsUrl);
  const missing = [
    !outlet && !business.trim() && "business name",
    !areaId && "area",
    !address.trim() && "address",
    !/^\d{6}$/.test(pincode) && "6-digit pincode",
    !mapsOk && "Google Maps link",
  ].filter(Boolean);
  const ready = missing.length === 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const row = outlet ?? (await api.startOutlet({ brandName: business.trim(), branchName: areaName ?? "Main", category }));
      const photoKey = photo ? await api.uploadFile(photo, "photo") : null;
      await api.saveOutlet(row.id, {
        step: 3,
        category,
        areaId,
        address: address.trim(),
        pincode,
        mapsUrl: mapsUrl.trim(),
        pickupInstructions: instructions.trim(),
        openingHours: everyDay(open, close),
        ...(photoKey ? { photoKeys: [...row.photoKeys, photoKey] } : {}),
      });
      next();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Screen
      title="Your outlet"
      sub="This is what customers see and where they come."
      footer={
        <div className="flex flex-col gap-2">
          {!ready && <span className="text-center text-[13px] text-muted">Still needed: {missing.join(", ")}</span>}
          <Button className="w-full" disabled={!ready || busy} onClick={save}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </div>
      }
    >
      {!outlet && <Field id="business" label="Business name" value={business} onChange={(event) => setBusiness(event.target.value)} />}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium text-muted">Category</legend>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((option) => (
            <Choice key={option.id} on={category === option.id} onClick={() => setCategory(option.id)}>
              {option.label}
            </Choice>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium text-muted">Area</legend>
        {cities.data && (
          <Tabs
            value={city}
            onChange={(value) => {
              setCity(value);
              setAreaId("");
            }}
            options={cities.data.map((c) => ({ id: c.slug, label: c.name }))}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {areas.map((area) => (
            <Choice key={area.id} on={areaId === area.id} onClick={() => setAreaId(area.id)}>
              {area.name}
            </Choice>
          ))}
        </div>
      </fieldset>

      <Field id="address" label="Address" autoComplete="street-address" value={address} onChange={(event) => setAddress(event.target.value)} />
      <Field id="pincode" label="Pincode" inputMode="numeric" maxLength={6} value={pincode} onChange={(event) => setPincode(event.target.value.replace(/\D/g, ""))} />
      <Field
        id="maps"
        label="Paste your Google Maps link"
        type="url"
        hint={mapsUrl && !mapsOk ? "Use the link from Share in Google Maps, starting https://maps.app.goo.gl/ or https://www.google.com/maps/." : "Open your shop in Google Maps, tap Share and paste the link. Customers use it for directions."}
        value={mapsUrl}
        onChange={(event) => setMapsUrl(event.target.value)}
      />
      <TextArea id="instructions" label="Pickup instructions for customers" placeholder="Side counter on the left. Show your code; no need to queue." value={instructions} onChange={(event) => setInstructions(event.target.value)} />

      <div className="grid grid-cols-2 gap-2.5">
        <Field id="open" label="Opens (Mon–Sun)" type="time" value={open} onChange={(event) => setOpen(event.target.value)} />
        <Field id="close" label="Closes (Mon–Sun)" type="time" value={close} onChange={(event) => setClose(event.target.value)} />
      </div>
      <FilePick label="Add a photo of your counter or food" hint="Helps customers find you." accept="image/jpeg,image/png,image/webp,image/heic" file={photo} onPick={setPhoto} />
      <FormError message={error} />
    </Screen>
  );
}

function DocCard({ title, why, badge, children }: { title: string; why: string; badge?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-[22px] p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-[17px] font-medium">{title}</h2>
        {badge && <span className="text-xs text-muted">{badge}</span>}
      </div>
      <span className="text-[13px] leading-normal text-muted">{why}</span>
      {children}
    </section>
  );
}

function Documents({ outlet, status, next }: StepProps) {
  const fixes = status?.fixes ?? [];
  const needsFssaiFile = !outlet || fixes.some((f) => f.code.startsWith("fssai_document"));
  const hasAccount = !!outlet?.payoutAccountId;
  const needsPanFile = !hasAccount || fixes.some((f) => f.code.startsWith("pan_document"));

  const [fssai, setFssai] = useState(outlet?.fssaiNumber ?? "");
  const [expiry, setExpiry] = useState(outlet?.fssaiExpiresOn ?? "");
  const [fssaiFile, setFssaiFile] = useState<File | null>(null);
  const [pan, setPan] = useState(panDraft?.pan ?? "");
  const [panFile, setPanFile] = useState<File | null>(null);
  const [registered, setRegistered] = useState(!!outlet?.gstin);
  const [gstin, setGstin] = useState(outlet?.gstin ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fssaiDigits = fssai.replace(/\D/g, "");
  const panOk = hasAccount || /^[A-Z]{5}\d{4}[A-Z]$/.test(pan);
  const gstOk = !registered || /^[0-9A-Z]{15}$/.test(gstin);
  const ready =
    fssaiDigits.length === 14 &&
    !!expiry &&
    (!needsFssaiFile || !!fssaiFile) &&
    panOk &&
    (!needsPanFile || !!panFile || !!panDraft?.fileKey) &&
    gstOk;

  async function save() {
    if (!outlet) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveOutlet(outlet.id, {
        step: 4,
        fssaiNumber: fssaiDigits,
        fssaiExpiresOn: expiry,
        ...(registered ? { gstin } : {}),
      });
      if (fssaiFile) await api.addDocument(outlet.id, { kind: "fssai", fileKey: await api.uploadFile(fssaiFile, "document") });
      const panKey = panFile ? await api.uploadFile(panFile, "document") : null;
      if (hasAccount) {
        if (panKey) await api.addDocument(outlet.id, { kind: "pan", fileKey: panKey, payoutAccountId: outlet.payoutAccountId! });
      } else {
        panDraft = { pan, fileKey: panKey ?? panDraft?.fileKey ?? null };
      }
      next();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Screen
      title="Documents"
      sub="Clear photos or PDFs. Only our verification team sees them."
      footer={
        <Button className="w-full" disabled={!ready || busy} onClick={save}>
          {busy ? "Uploading…" : "Continue"}
        </Button>
      }
    >
      <DocCard title="FSSAI licence" why="Why: selling food in India needs a valid licence. We show it on your listings so customers can trust you." badge={needsFssaiFile ? "Photo needed" : "Added"}>
        <Field id="fssai" label="14-digit licence number" inputMode="numeric" value={fssai} onChange={(event) => setFssai(event.target.value)} />
        <Field id="fssai-expiry" label="Expiry date" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
        {needsFssaiFile && <FilePick label="Upload FSSAI licence" file={fssaiFile} onPick={setFssaiFile} />}
      </DocCard>

      <DocCard title="PAN" why="Why: required by law for payouts and tax reporting. Business PAN, or owner’s PAN if you’re a sole proprietor." badge={needsPanFile ? "Photo needed" : "Added"}>
        {!hasAccount && <Field id="pan" label="PAN number" autoCapitalize="characters" maxLength={10} value={pan} onChange={(event) => setPan(event.target.value.toUpperCase())} />}
        {needsPanFile && <FilePick label="Upload PAN photo" file={panFile} onPick={setPanFile} />}
      </DocCard>

      <DocCard title="GST" why="Why: if you’re registered, we add your GSTIN to invoices. Not registered? That’s fine, skip it.">
        <div role="radiogroup" aria-label="GST registered?" className="grid grid-cols-2 gap-2">
          <Choice role="radio" aria-pressed={undefined} aria-checked={registered} on={registered} onClick={() => setRegistered(true)}>
            I’m registered
          </Choice>
          <Choice role="radio" aria-pressed={undefined} aria-checked={!registered} on={!registered} onClick={() => setRegistered(false)}>
            Not registered
          </Choice>
        </div>
        {registered && <Field id="gstin" label="GSTIN (15 characters)" maxLength={15} value={gstin} onChange={(event) => setGstin(event.target.value.toUpperCase())} />}
      </DocCard>
      <FormError message={error} />
    </Screen>
  );
}

function Payout({ outlet, status, next }: StepProps) {
  const { me } = useSession();
  const [holder, setHolder] = useState("");
  const [account, setAccount] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [nameOk, setNameOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saved = !!outlet?.payoutAccountId;
  const needsProof = !saved || !!status?.fixes.some((f) => f.code.startsWith("bank_proof_document"));
  const owner = me?.name ?? "";
  const business = outlet?.brandName ?? "";
  const typed = holder.trim().toLowerCase();
  const mismatch = !saved && typed.length > 2 && typed !== owner.toLowerCase() && typed !== business.toLowerCase() && !nameOk;
  const accountDigits = account.replace(/\s/g, "");
  const formOk = holder.trim() && /^\d{9,18}$/.test(accountDigits) && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc);
  const ready = saved ? !needsProof || !!proof : !!formOk && !!proof && !!panDraft && !mismatch;

  async function save() {
    if (!outlet) return;
    setBusy(true);
    setError(null);
    try {
      let accountId = outlet.payoutAccountId;
      if (!accountId) {
        const created = await api.createPayoutAccount({
          brandId: outlet.brandId,
          legalName: owner || holder.trim(),
          pan: panDraft!.pan,
          holderName: holder.trim(),
          accountNumber: accountDigits,
          ifsc,
        });
        accountId = created.id;
        await api.saveOutlet(outlet.id, { payoutAccountId: accountId });
        if (panDraft?.fileKey) await api.addDocument(outlet.id, { kind: "pan", fileKey: panDraft.fileKey, payoutAccountId: accountId });
        panDraft = null;
      }
      if (proof) await api.addDocument(outlet.id, { kind: "bank_proof", fileKey: await api.uploadFile(proof, "document"), payoutAccountId: accountId });
      await api.saveOutlet(outlet.id, { step: 5 });
      next();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Screen
      title="Where we pay you"
      sub="Weekly payouts every Tuesday. Why: we need a bank account in your business or owner’s name."
      footer={
        <Button className="w-full" disabled={!ready || busy} onClick={save}>
          {busy ? "Saving…" : "Continue"}
        </Button>
      }
    >
      {saved ? (
        <div className="rounded-2xl bg-ok-bg p-3.5 text-[13px] text-ok-fg">Your bank details are saved.</div>
      ) : !panDraft ? (
        <div role="alert" className="flex flex-col gap-2 rounded-2xl bg-wait-bg p-3.5 text-[13px] leading-normal text-wait-fg">
          <strong className="font-medium">We need your PAN first</strong>
          For safety we don’t keep it on this device, so it clears if the page reloads.
          <Link href="/partner/apply/3" className="font-medium underline">
            Go back to Documents
          </Link>
        </div>
      ) : (
        <>
          <Field id="holder" label="Account holder name (as on passbook)" value={holder} onChange={(event) => setHolder(event.target.value)} />
          {mismatch && (
            <div role="alert" className="flex flex-col gap-2 rounded-2xl bg-[#fdebdd] p-3.5 text-[13px] leading-normal text-[#9a3412]">
              <strong className="font-medium">This name doesn’t match your PAN or business</strong>
              Owner: {owner}
              {business ? ` · Business: ${business}` : ""}. Payouts to a mismatched account can bounce or be held for checks.
              <div className="flex flex-wrap gap-2">
                {owner && (
                  <button type="button" onClick={() => setHolder(owner)} className="min-h-10 rounded-full bg-white px-3.5 font-medium text-ink">
                    Use “{owner}”
                  </button>
                )}
                <button type="button" onClick={() => setNameOk(true)} className="min-h-10 rounded-full px-3.5 font-medium underline">
                  It’s correct
                </button>
              </div>
            </div>
          )}
          <Field id="account" label="Account number" inputMode="numeric" value={account} onChange={(event) => setAccount(event.target.value)} />
          <Field id="ifsc" label="IFSC" maxLength={11} value={ifsc} onChange={(event) => setIfsc(event.target.value.toUpperCase())} />
        </>
      )}
      {needsProof && (panDraft || saved) && <FilePick label="Cancelled cheque or passbook first page" hint="Why: confirms the account is really yours before we send money." file={proof} onPick={setProof} />}
      <FormError message={error} />
    </Screen>
  );
}

function FirstListing({ outlet, next }: StepProps) {
  const listings = useQuery(() => api.getListings(outlet!.id), [outlet?.id], { enabled: !!outlet });
  if (listings.loading) return <PageSkeleton />;
  return (
    <Screen title="Your first listing" sub="You can edit it any time. It goes live once you’re approved.">
      <ListingForm
        outletId={outlet!.id}
        listing={listings.data?.[0]}
        submitLabel="Continue"
        onSaved={async () => {
          await api.saveOutlet(outlet!.id, { step: 5 });
          next();
        }}
      />
    </Screen>
  );
}

function Agreement({ outlet }: StepProps) {
  const router = useRouter();
  const { me } = useSession();
  const [signature, setSignature] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = signature.trim().length > 2 && agree && !!outlet?.payoutAccountId;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.signAgreement(outlet!.payoutAccountId!, { signedName: signature.trim(), version: AGREEMENT_VERSION });
      await api.submitOutlet(outlet!.id);
      router.push("/partner/status");
    } catch (err) {
      if (errorCode(err) === "incomplete") router.push("/partner/status");
      else {
        setError(errorMessage(err));
        setBusy(false);
      }
    }
  }

  const today = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(new Date());

  return (
    <Screen
      title="Partner agreement"
      sub="The key points in plain words."
      footer={
        <Button className="w-full" disabled={!ready || busy} onClick={submit}>
          {ready ? (busy ? "Submitting…" : "Sign and submit") : "Sign and tick the box to submit"}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-0.5 rounded-2xl bg-fill p-3">
          <span className="text-xs text-muted">Commission</span>
          <span className="text-xl font-bold">{COMMISSION_PERCENT}%</span>
          <span className="text-xs text-muted">per bag sold (sample)</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-2xl bg-fill p-3">
          <span className="text-xs text-muted">Payouts</span>
          <span className="text-xl font-bold">Every Tuesday</span>
          <span className="text-xs text-muted">for Mon–Sun sales</span>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-[17px] font-medium">Food safety is on you</h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-normal text-body">
          <li>Only sell food made today and safe to eat tonight.</li>
          <li>Mark veg, egg and non-veg honestly, and list allergens.</li>
          <li>Keep your FSSAI licence valid; tell us if it changes.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[17px] font-medium">Cancellations and no-shows</h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-normal text-body">
          <li>If you cancel, the customer is refunded in full automatically.</li>
          <li>If a customer doesn’t show, you keep the payment.</li>
          <li>Frequent cancellations may pause your listings.</li>
        </ul>
      </section>

      <Field id="signature" label="Type your full name to sign" placeholder={me?.name ?? ""} hint={`Signed electronically on ${today} · IP and time are recorded.`} value={signature} onChange={(event) => setSignature(event.target.value)} />
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-[13px] leading-normal">
        <input type="checkbox" checked={agree} onChange={() => setAgree(!agree)} className="m-0 size-[22px] flex-none accent-coral" />
        <span>I’m authorised to sign for this business and agree to the partner agreement.</span>
      </label>
      {!outlet?.payoutAccountId && (
        <Link href="/partner/apply/4" className="text-[13px] font-medium text-danger underline">
          Add your payout account first
        </Link>
      )}
      <FormError message={error} />
    </Screen>
  );
}

const STEPS = [Account, OutletStep, Documents, Payout, FirstListing, Agreement];

export default function Apply() {
  const params = useParams<{ step: string }>();
  const step = Math.min(TOTAL_STEPS, Math.max(1, Number(params.step) || 1));
  const router = useRouter();
  const { me, loading } = useSession();
  const outlets = useQuery(() => api.getVendorOutlets(), [me?.id, step], { enabled: !!me });
  const outlet = outlets.data?.find((o) => o.status === "draft" || o.status === "changes_needed") ?? null;
  const status = useQuery(() => api.getOutletStatus(outlet!.id), [outlet?.id, step], { enabled: !!outlet });

  const needsOutlet = step > 2 && !outlet && !outlets.loading && !!me;
  const signedOut = step > 1 && !loading && !me;
  useEffect(() => {
    if (signedOut) router.replace("/partner/apply/1");
    else if (needsOutlet) router.replace("/partner/apply/2");
  }, [signedOut, needsOutlet, router]);

  // Step 1 stays mounted through its own sign-in, or the form would lose what was typed.
  const waiting = loading || (step > 1 && ((me && outlets.loading) || (outlet && status.loading))) || signedOut || needsOutlet;
  const Step = STEPS[step - 1];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <Header step={step} />
      {waiting ? (
        <PageSkeleton />
      ) : (
        <Step key={`${step}-${outlet?.id ?? "new"}`} outlet={outlet} status={status.data ?? null} next={() => router.push(`/partner/apply/${step + 1}`)} />
      )}
    </div>
  );
}
