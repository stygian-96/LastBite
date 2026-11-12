"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useCities } from "@/components/customer";
import { Choice, FilePick, FormError, ListingForm, TextArea } from "@/components/forms";
import { BackIcon, Button, Field, PageSkeleton, Tabs } from "@/components/ui";
import { AGREEMENT_VERSION, COMMISSION_PERCENT } from "@/config/brand";
import {
  api,
  errorCode,
  errorMessage,
  type OpeningHours,
  type OutletCategory,
  type OutletStatusView,
  type PayoutAccount,
  type SectionKey,
  type VendorOutlet,
} from "@/lib/api";
import { phoneDisplay } from "@/lib/format";
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
  /** An approved section the vendor chose to change, from their application page. */
  reopen?: SectionKey | null;
};

const APPLICATION_PAGE = "/vendor/application";

function sectionOf(status: OutletStatusView | null, key: SectionKey) {
  return status?.sections.find((s) => s.key === key) ?? { key, state: "missing" as const };
}

/** The outlet's own payout account, for showing what is saved. Its secrets never come back, only last 4 digits. */
function useAccount(outlet: VendorOutlet | null): PayoutAccount | null {
  const accounts = useQuery(() => api.getPayoutAccounts(outlet!.brandId), [outlet?.brandId], { enabled: !!outlet?.payoutAccountId });
  return accounts.data?.find((a) => a.id === outlet?.payoutAccountId) ?? null;
}

function Approved({ what, reopen }: { what: string; reopen: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl bg-ok-bg p-3.5 text-[13px] leading-normal text-ok-fg">
      <strong className="font-medium">🔒 {what} approved</strong>
      <span>
        Need to change it?{" "}
        <Link href={reopen} className="font-medium text-ink underline">
          Change it
        </Link>{" "}
        and we’ll check it again.
      </span>
    </div>
  );
}

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
        <Link href={APPLICATION_PAGE} className="flex min-h-11 items-center rounded-full bg-fill px-3.5 text-[13px] font-medium no-underline">
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Screen
      title="About you"
      sub="The owner or manager we can reach about orders and payouts."
      footer={
        <Button className="w-full" disabled={name.trim().length < 2 || busy} onClick={save}>
          {busy ? "Saving…" : "Continue"}
        </Button>
      }
    >
      <Field id="owner" label="Owner’s full name" hint="Should match the name on your PAN." autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-muted">Mobile number</span>
        <div className="flex h-14 items-center justify-between gap-2 rounded-2xl bg-fill px-4">
          <span className="tabular font-medium">{me ? phoneDisplay(me.phone) : ""}</span>
          <span className="rounded-xl bg-[#dcfce7] px-2.5 py-1 text-[13px] font-medium text-[#166534]">Verified</span>
        </div>
        <span className="text-[13px] text-muted">The number you signed in with. You’ll get the daily “how many tonight?” prompt here on WhatsApp.</span>
      </div>
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

function Documents({ outlet, status, next, reopen }: StepProps) {
  const licence = sectionOf(status, "licence");
  const panSection = sectionOf(status, "pan");
  const hasAccount = !!outlet?.payoutAccountId;
  const account = useAccount(outlet);
  const licenceLocked = licence.state === "approved" && reopen !== "licence";
  const panLocked = hasAccount && panSection.state === "approved" && reopen !== "pan";

  const [fssai, setFssai] = useState(outlet?.fssaiNumber ?? "");
  const [expiry, setExpiry] = useState(outlet?.fssaiExpiresOn ?? "");
  const [fssaiFile, setFssaiFile] = useState<File | null>(null);
  const [pan, setPan] = useState(panDraft?.pan ?? "");
  const [legalName, setLegalName] = useState<string | null>(null);
  const [panFile, setPanFile] = useState<File | null>(null);
  const [registered, setRegistered] = useState(!!outlet?.gstin);
  const [gstin, setGstin] = useState(outlet?.gstin ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fssaiDigits = fssai.replace(/\D/g, "");
  const licenceChanged = fssaiDigits !== (outlet?.fssaiNumber ?? "") || expiry !== (outlet?.fssaiExpiresOn ?? "");
  // A flagged part is fixed by new details, a new photo, or both. A missing one needs its photo.
  const licenceOk =
    licenceLocked ||
    (fssaiDigits.length === 14 && !!expiry && (licence.state === "missing" ? !!fssaiFile : licence.state !== "needs_fix" || licenceChanged || !!fssaiFile));
  const panValid = /^[A-Z]{5}\d{4}[A-Z]$/.test(pan);
  const name = legalName ?? account?.legalName ?? "";
  const panChanged = hasAccount && pan.length > 0;
  const panOk = !hasAccount
    ? panValid && (!!panFile || !!panDraft?.fileKey)
    : panLocked ||
      ((pan.length === 0 || (panValid && name.trim().length > 0)) &&
        (panSection.state === "missing" ? !!panFile : panSection.state !== "needs_fix" || panChanged || !!panFile));
  const gstOk = !registered || /^[0-9A-Z]{15}$/.test(gstin);
  const ready = licenceOk && panOk && gstOk;

  async function save() {
    if (!outlet) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveOutlet(outlet.id, {
        step: 4,
        ...(licenceLocked ? {} : { fssaiNumber: fssaiDigits, fssaiExpiresOn: expiry }),
        ...(registered ? { gstin } : {}),
      });
      if (fssaiFile && !licenceLocked) await api.addDocument(outlet.id, { kind: "fssai", fileKey: await api.uploadFile(fssaiFile, "document") });
      const panKey = panFile ? await api.uploadFile(panFile, "document") : null;
      if (hasAccount) {
        if (panChanged && !panLocked) await api.fixPanDetails(outlet.payoutAccountId!, { legalName: name.trim(), pan });
        if (panKey && !panLocked) await api.addDocument(outlet.id, { kind: "pan", fileKey: panKey, payoutAccountId: outlet.payoutAccountId! });
      } else {
        panDraft = { pan, fileKey: panKey ?? panDraft?.fileKey ?? null };
      }
      next();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const flagged = (reason?: string) =>
    reason ? (
      <p className="rounded-xl bg-warn-bg px-3 py-2 text-[13px] leading-normal text-warn-fg">
        <strong className="font-medium">From our team:</strong> {reason}
      </p>
    ) : null;

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
      <DocCard title="FSSAI licence" why="Why: selling food in India needs a valid licence. We show it on your listings so customers can trust you." badge={licence.state === "missing" ? "Photo needed" : undefined}>
        {flagged(licence.state === "needs_fix" ? licence.reason : undefined)}
        {licenceLocked ? (
          <>
            <span className="text-sm">
              {outlet?.fssaiNumber} · valid to {outlet?.fssaiExpiresOn}
            </span>
            <Approved what="Licence" reopen="/partner/apply/3?back=application&reopen=licence" />
          </>
        ) : (
          <>
            <Field id="fssai" label="14-digit licence number" inputMode="numeric" value={fssai} onChange={(event) => setFssai(event.target.value)} />
            <Field id="fssai-expiry" label="Expiry date" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
            <FilePick
              label={licence.state === "missing" ? "Upload FSSAI licence" : "Upload a new licence photo (optional)"}
              hint={licence.state === "needs_fix" ? "Fix the number or date above, upload a clearer photo, or both." : undefined}
              file={fssaiFile}
              onPick={setFssaiFile}
            />
          </>
        )}
      </DocCard>

      <DocCard title="PAN" why="Why: required by law for payouts and tax reporting. Business PAN, or owner’s PAN if you’re a sole proprietor." badge={!hasAccount || panSection.state === "missing" ? "Photo needed" : undefined}>
        {flagged(panSection.state === "needs_fix" ? panSection.reason : undefined)}
        {panLocked ? (
          <>
            <span className="text-sm">
              {account ? `${account.legalName} · •••• ${account.panLast4}` : "Saved"}
            </span>
            <Approved what="PAN" reopen="/partner/apply/3?back=application&reopen=pan" />
          </>
        ) : (
          <>
            {hasAccount && (
              <>
                <Field id="legal-name" label="Legal name (as on PAN)" value={name} onChange={(event) => setLegalName(event.target.value)} />
                {account && <span className="-mt-2 text-xs text-muted">Saved PAN ends in {account.panLast4}. Type the full number only to change it.</span>}
              </>
            )}
            <Field
              id="pan"
              label={hasAccount ? "New PAN number (optional)" : "PAN number"}
              autoCapitalize="characters"
              maxLength={10}
              value={pan}
              onChange={(event) => setPan(event.target.value.toUpperCase())}
            />
            <FilePick label={!hasAccount || panSection.state === "missing" ? "Upload PAN photo" : "Upload a new PAN photo (optional)"} file={panFile} onPick={setPanFile} />
          </>
        )}
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

function Payout({ outlet, status, next, reopen }: StepProps) {
  const { me } = useSession();
  const saved = !!outlet?.payoutAccountId;
  const savedAccount = useAccount(outlet);
  const bank = sectionOf(status, "bank");
  const bankLocked = saved && bank.state === "approved" && reopen !== "bank";
  const [holderEdit, setHolder] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [ifscEdit, setIfsc] = useState<string | null>(null);
  const holder = holderEdit ?? savedAccount?.holderName ?? "";
  const ifsc = ifscEdit ?? savedAccount?.ifsc ?? "";
  const [proof, setProof] = useState<File | null>(null);
  const [nameOk, setNameOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsProof = !saved || bank.state === "missing";
  const owner = me?.name ?? "";
  const business = outlet?.brandName ?? "";
  const typed = holder.trim().toLowerCase();
  const mismatch = !saved && typed.length > 2 && typed !== owner.toLowerCase() && typed !== business.toLowerCase() && !nameOk;
  const accountDigits = account.replace(/\s/g, "");
  const formOk = holder.trim() && /^\d{9,18}$/.test(accountDigits) && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc);
  // Saved details change together: the full account number again, with holder and IFSC.
  const edited = saved && (account.length > 0 || holderEdit !== null || ifscEdit !== null);
  const fixOk = !edited || !!formOk;
  const ready = saved
    ? bankLocked || (fixOk && (needsProof ? !!proof : bank.state !== "needs_fix" || edited || !!proof))
    : !!formOk && !!proof && !!panDraft && !mismatch;

  async function save() {
    if (!outlet) return;
    setBusy(true);
    setError(null);
    try {
      let accountId = outlet.payoutAccountId;
      if (accountId && edited && !bankLocked) {
        await api.fixBankDetails(accountId, { holderName: holder.trim(), accountNumber: accountDigits, ifsc });
      }
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
      if (proof && !bankLocked) await api.addDocument(outlet.id, { kind: "bank_proof", fileKey: await api.uploadFile(proof, "document"), payoutAccountId: accountId });
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
      {bank.state === "needs_fix" && bank.reason && (
        <p className="rounded-xl bg-warn-bg px-3 py-2 text-[13px] leading-normal text-warn-fg">
          <strong className="font-medium">From our team:</strong> {bank.reason}
        </p>
      )}
      {bankLocked ? (
        <>
          {savedAccount && (
            <span className="text-sm">
              {savedAccount.holderName} · {savedAccount.ifsc} · ••{savedAccount.accountLast4}
            </span>
          )}
          <Approved what="Bank account" reopen="/partner/apply/4?back=application&reopen=bank" />
        </>
      ) : saved ? (
        <>
          <Field id="holder" label="Account holder name (as on passbook)" value={holder} onChange={(event) => setHolder(event.target.value)} />
          <Field
            id="account"
            label="Account number"
            inputMode="numeric"
            placeholder={savedAccount ? `Saved: ••${savedAccount.accountLast4}` : undefined}
            value={account}
            onChange={(event) => setAccount(event.target.value)}
          />
          <Field id="ifsc" label="IFSC" maxLength={11} value={ifsc} onChange={(event) => setIfsc(event.target.value.toUpperCase())} />
          <span className="-mt-2 text-xs text-muted">
            {edited && !formOk
              ? "To change any bank detail, type the full account number again, with the holder name and IFSC."
              : "Leave these as they are to keep your saved account."}
          </span>
        </>
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
      {!bankLocked && (panDraft || saved) && (
        <FilePick
          label={needsProof ? "Cancelled cheque or passbook first page" : "Upload a new cheque or passbook photo (optional)"}
          hint={bank.state === "needs_fix" ? "Fix the details above, upload a clearer photo, or both." : "Why: confirms the account is really yours before we send money."}
          file={proof}
          onPick={setProof}
        />
      )}
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
      router.push(APPLICATION_PAGE);
    } catch (err) {
      if (errorCode(err) === "incomplete") router.push(APPLICATION_PAGE);
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
  const search = useSearchParams();
  // From the application page: save returns there, and an approved part may be opened to change.
  const backToApplication = search.get("back") === "application";
  const reopen = search.get("reopen") as SectionKey | null;
  const { me, loading } = useSession();
  const outlets = useQuery(() => api.getVendorOutlets(), [me?.id, step], { enabled: !!me });
  const outlet = outlets.data?.find((o) => o.status === "draft" || o.status === "changes_needed") ?? null;
  const status = useQuery(() => api.getOutletStatus(outlet!.id), [outlet?.id, step], { enabled: !!outlet });

  // Only a real answer of "no application" starts a new one; a failed load must not.
  const needsOutlet = step > 2 && !outlet && !!outlets.data && !!me;
  // Sign in first, then the form; signing in brings the vendor back to this step.
  const signedOut = !loading && !me;
  useEffect(() => {
    if (signedOut) router.replace(`/signin?next=${encodeURIComponent(`/partner/apply/${step}${window.location.search}`)}`);
    else if (needsOutlet) router.replace("/partner/apply/2");
  }, [signedOut, needsOutlet, router, step]);

  const waiting = loading || (me && outlets.loading) || (step > 1 && outlet && status.loading) || signedOut || needsOutlet;
  const Step = STEPS[step - 1];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <Header step={step} />
      {outlets.error && !outlets.data && step > 1 ? (
        <div className="flex flex-col gap-3 px-4 pt-6">
          <p className="text-sm text-muted">We couldn’t load your application. Check your connection and try again.</p>
          <Button size="md" variant="quiet" onClick={outlets.reload}>
            Try again
          </Button>
        </div>
      ) : waiting ? (
        <PageSkeleton />
      ) : (
        <Step
          key={`${step}-${outlet?.id ?? "new"}-${reopen ?? ""}`}
          outlet={outlet}
          status={status.data ?? null}
          reopen={reopen}
          next={() => router.push(backToApplication ? APPLICATION_PAGE : `/partner/apply/${step + 1}`)}
        />
      )}
    </div>
  );
}
