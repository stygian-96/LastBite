"use client";

import { useRouter } from "next/navigation";
import { useState, type ComponentProps, type ReactNode } from "react";
import { Button, Field } from "@/components/ui";
import { api, errorMessage, type Diet, type FoodCategory, type Listing, type ListingInput, type ListingType } from "@/lib/api";

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-[13px] leading-normal text-danger">
      {message}
    </p>
  );
}

export function TextArea({ label, id, ...props }: ComponentProps<"textarea"> & { label: string; id: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-muted">
        {label}
      </label>
      <textarea id={id} rows={2} className="resize-none rounded-2xl bg-fill px-4 py-3 text-[15px] text-ink" {...props} />
    </div>
  );
}

export function Choice({ on, className = "", ...props }: ComponentProps<"button"> & { on: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`min-h-11 rounded-2xl border-[1.5px] px-3.5 text-sm font-medium ${on ? "border-coral bg-tint" : "border-line bg-white"} ${className}`}
      {...props}
    />
  );
}

export function FilePick({
  label,
  hint,
  file,
  accept = "image/jpeg,image/png,image/webp,image/heic,application/pdf",
  onPick,
}: {
  label: string;
  hint?: string;
  file: File | null;
  accept?: string;
  onPick: (file: File | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="relative flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed border-[#cfcfcf] px-3 text-center text-sm font-medium">
        {file ? `✓ ${file.name}` : label}
        <input type="file" accept={accept} onChange={(event) => onPick(event.target.files?.[0] ?? null)} className="sr-only" />
      </label>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  min = 1,
  children,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  children?: ReactNode;
}) {
  const round = "flex size-14 flex-none items-center justify-center rounded-full bg-fill text-2xl font-medium disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-3">
      <button type="button" aria-label="One less" disabled={value <= min} onClick={() => onChange(value - 1)} className={round}>
        −
      </button>
      <span className="flex flex-col items-center">
        <span aria-live="polite" className="tabular text-[40px] font-black leading-none">
          {value}
        </span>
        {children}
      </span>
      <button type="button" aria-label="One more" onClick={() => onChange(value + 1)} className={round}>
        +
      </button>
    </div>
  );
}

const TYPES: { id: ListingType; label: string; hint: string }[] = [
  { id: "surprise_bag", label: "Surprise Bag", hint: "Contents vary. Easiest for mixed leftovers." },
  { id: "fixed_box", label: "Fixed item / box", hint: "Customers know exactly what they get." },
];
const DIETS: { id: Diet; label: string }[] = [
  { id: "veg", label: "Veg" },
  { id: "egg", label: "Contains egg" },
  { id: "nonveg", label: "Non-veg" },
  { id: "mixed", label: "Mixed, can’t guarantee" },
];
const FOODS: { id: FoodCategory; label: string }[] = [
  { id: "bakery", label: "Bakery" },
  { id: "cafe", label: "Café" },
  { id: "meals", label: "Meals" },
  { id: "desserts", label: "Desserts" },
];
const ALLERGENS = ["gluten", "dairy", "egg", "nuts", "sesame", "soy"];

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

export function ListingForm({
  outletId,
  listing,
  submitLabel,
  onSaved,
}: {
  outletId: string;
  listing?: Listing | null;
  submitLabel: string;
  onSaved: (listing: Listing) => void;
}) {
  const [type, setType] = useState<ListingType>(listing?.type ?? "surprise_bag");
  const [name, setName] = useState(listing?.name ?? "");
  const [description, setDescription] = useState(listing?.description ?? "");
  const [food, setFood] = useState<FoodCategory>(listing?.foodCategory ?? "bakery");
  const [diet, setDiet] = useState<Diet>(listing?.diet ?? "veg");
  const [allergens, setAllergens] = useState<string[]>(listing?.allergens ?? []);
  const [value, setValue] = useState(listing ? String(listing.valuePaise / 100) : "");
  const [price, setPrice] = useState(listing ? String(listing.pricePaise / 100) : "");
  const [quantity, setQuantity] = useState(listing?.defaultQuantity ?? 6);
  const [start, setStart] = useState(listing?.pickupStart.slice(0, 5) ?? "20:30");
  const [end, setEnd] = useState(listing?.pickupEnd.slice(0, 5) ?? "21:30");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valueRupees = Number(value) || 0;
  const priceRupees = Number(price) || 0;
  const discount = valueRupees > 0 ? Math.round((1 - priceRupees / valueRupees) * 100) : 0;
  const ready = name.trim() && description.trim() && priceRupees > 0 && priceRupees <= valueRupees && start !== end;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const photoKey = photo ? await api.uploadFile(photo, "photo") : undefined;
      const body: ListingInput = {
        type,
        name: name.trim(),
        description: description.trim(),
        foodCategory: food,
        diet,
        allergens,
        valuePaise: Math.round(valueRupees * 100),
        pricePaise: Math.round(priceRupees * 100),
        defaultQuantity: quantity,
        pickupStart: start,
        pickupEnd: end,
        repeatDays: listing?.repeatDays ?? ALL_DAYS,
        ...(photoKey ? { photoKey } : {}),
      };
      onSaved(listing ? await api.updateListing(listing.id, body) : await api.createListing(outletId, body));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Listing type" className="grid grid-cols-2 gap-2">
        {TYPES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={type === option.id}
            onClick={() => setType(option.id)}
            className={`flex flex-col gap-1 rounded-2xl border-[1.5px] p-3 text-left ${type === option.id ? "border-coral bg-tint" : "border-line"}`}
          >
            <strong className="text-sm font-medium">{option.label}</strong>
            <span className="text-xs leading-snug text-muted">{option.hint}</span>
          </button>
        ))}
      </div>

      <Field id="listing-name" label="Name" placeholder={type === "surprise_bag" ? "Bakery Surprise Bag" : "Four Croissants Box"} value={name} onChange={(event) => setName(event.target.value)} />
      <TextArea id="listing-about" label={type === "surprise_bag" ? "What to expect" : "What they get"} placeholder="Usually 4–6 of today’s bakes: bread, croissants, a cake slice or cookies." value={description} onChange={(event) => setDescription(event.target.value)} />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium text-muted">Category</legend>
        <div className="flex flex-wrap gap-2">
          {FOODS.map((option) => (
            <Choice key={option.id} on={food === option.id} onClick={() => setFood(option.id)}>
              {option.label}
            </Choice>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium text-muted">Dietary</legend>
        <div className="flex flex-wrap gap-2">
          {DIETS.map((option) => (
            <Choice key={option.id} on={diet === option.id} onClick={() => setDiet(option.id)}>
              {option.label}
            </Choice>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium text-muted">Allergens it may contain</legend>
        <div className="flex flex-wrap gap-2">
          {ALLERGENS.map((item) => {
            const on = allergens.includes(item);
            return (
              <Choice key={item} on={on} onClick={() => setAllergens(on ? allergens.filter((a) => a !== item) : [...allergens, item])}>
                {item[0].toUpperCase() + item.slice(1)}
              </Choice>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-2.5">
        <Field id="listing-value" label="Usual value ₹" inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))} />
        <Field id="listing-price" label="Selling price ₹" inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value.replace(/\D/g, ""))} />
      </div>
      {valueRupees > 0 && priceRupees > 0 && (
        <span className={`text-[13px] ${priceRupees > valueRupees ? "text-danger" : discount < 50 ? "text-[#9a3412]" : "text-ok-fg"}`}>
          {priceRupees > valueRupees
            ? "The selling price can’t be above the usual value."
            : discount < 50
              ? `${discount}% off. We recommend at least 50% off so bags sell.`
              : `${discount}% off. Customers see “worth ₹${valueRupees}”.`}
        </span>
      )}

      <div className="flex flex-col gap-2 rounded-2xl bg-fill p-3.5">
        <span className="flex flex-col">
          <span className="text-[15px] font-medium">Usual quantity per evening</span>
          <span className="text-xs text-muted">You confirm the real number daily</span>
        </span>
        <Stepper value={quantity} onChange={setQuantity} />
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Field id="listing-start" label="Pickup from" type="time" value={start} onChange={(event) => setStart(event.target.value)} />
        <Field id="listing-end" label="Pickup until" type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
      </div>

      <FilePick label="Take or upload a photo" hint="Optional. We’ll show an illustration if you skip it." accept="image/jpeg,image/png,image/webp,image/heic" file={photo} onPick={setPhoto} />

      <FormError message={error} />
      <Button onClick={save} disabled={!ready || busy}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </div>
  );
}

// Sends signed-out visitors to sign-in and returns here afterwards.
export function useRedirectToSignIn() {
  const router = useRouter();
  return (next: string) => router.replace(`/signin?next=${encodeURIComponent(next)}`);
}
