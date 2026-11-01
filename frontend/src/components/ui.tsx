"use client";

import Link from "next/link";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { brand } from "@/config/brand";
import type { Diet } from "@/lib/api";

const BUTTON = {
  primary: "bg-coral text-on-coral disabled:bg-[#f0f0f0] disabled:text-muted",
  dark: "bg-dark text-white disabled:bg-[#f0f0f0] disabled:text-muted",
  quiet: "bg-fill text-ink disabled:text-muted",
  outline: "border-[1.5px] border-ink bg-white text-ink disabled:border-line disabled:text-muted",
  danger: "bg-warn-bg text-warn-fg",
};

const SIZE = { lg: "min-h-14 px-6 text-base", md: "min-h-11 px-5 text-sm" };

type Look = { variant?: keyof typeof BUTTON; size?: keyof typeof SIZE };

function look({ variant = "primary", size = "lg" }: Look, className = "") {
  return `flex items-center justify-center gap-2 rounded-full text-center font-medium no-underline ${BUTTON[variant]} ${SIZE[size]} ${className}`;
}

export function Button({ variant, size, className, type = "button", ...props }: ComponentProps<"button"> & Look) {
  return <button type={type} className={look({ variant, size }, className)} {...props} />;
}

export function LinkButton({ variant, size, className, ...props }: ComponentProps<typeof Link> & Look) {
  return <Link className={look({ variant, size }, className)} {...props} />;
}

export function ExternalButton({ variant, size, className, ...props }: ComponentProps<"a"> & Look) {
  return <a target="_blank" rel="noreferrer" className={look({ variant, size }, className)} {...props} />;
}

const ROUND = "flex size-11 flex-none items-center justify-center rounded-full border border-line bg-white";

export function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function TopBar({
  title,
  back,
  onBack,
  icon = "back",
  backLabel = "Back",
  right,
}: {
  title: string;
  back?: string;
  onBack?: () => void;
  icon?: "back" | "close";
  backLabel?: string;
  right?: ReactNode;
}) {
  const glyph = icon === "close" ? <CloseIcon /> : <BackIcon />;
  return (
    <div className="flex items-center justify-between px-4 pb-2.5 pt-[18px]">
      {onBack ? (
        <button type="button" aria-label={backLabel} onClick={onBack} className={ROUND}>
          {glyph}
        </button>
      ) : back ? (
        <Link href={back} aria-label={backLabel} className={ROUND}>
          {glyph}
        </Link>
      ) : (
        <span className="w-11" />
      )}
      <span className="text-[17px] font-medium">{title}</span>
      {right ?? <span className="w-11" />}
    </div>
  );
}

export function Logo({ size = "md" }: { size?: "md" | "sm" }) {
  const box = size === "md" ? "size-[34px] rounded-xl" : "size-[30px] rounded-[10px]";
  return (
    <span className={`flex items-center gap-2 font-black tracking-tight ${size === "md" ? "text-[22px]" : "text-xl"}`}>
      <span className={`flex items-end justify-center overflow-hidden bg-coral ${box}`}>
        <span className="mb-[9px] h-[10px] w-5 rounded-t-[10px] bg-dark" />
      </span>
      {brand.wordmark}
    </span>
  );
}

export function Chip({ on, className = "", ...props }: ComponentProps<"button"> & { on: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`min-h-10 flex-none rounded-full border px-3.5 text-[13px] font-medium ${
        on ? "border-dark bg-dark text-white" : "border-[#e6e6e6] bg-white text-ink"
      } ${className}`}
      {...props}
    />
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div
      role="tablist"
      className="grid rounded-full bg-fill p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === value}
          onClick={() => onChange(option.id)}
          className={`h-11 rounded-full text-[15px] font-medium ${option.id === value ? "bg-ink text-white" : "text-ink"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  on,
  onChange,
  label,
  hint,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex min-h-14 w-full items-center gap-3 border-b border-[#f0f0f0] px-0.5 py-2 text-left"
    >
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[15px]">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
      <span className={`relative h-7 w-12 flex-none rounded-full ${on ? "bg-coral" : "bg-[#cfcfcf]"}`}>
        <span className={`absolute top-[3px] size-[22px] rounded-full bg-white shadow ${on ? "left-[23px]" : "left-[3px]"}`} />
      </span>
    </button>
  );
}

// Native dialog: focus trap, Esc and the backdrop come for free.
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(event) => event.target === ref.current && onClose()}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-[28px] bg-white p-0 text-ink backdrop:bg-black/45 lg:inset-0 lg:m-auto lg:h-fit lg:max-w-md lg:rounded-[28px]"
    >
      <div className="flex flex-col gap-3.5 px-4 pb-7 pt-5">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="flex size-11 items-center justify-center rounded-full bg-fill">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

export function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] lg:gap-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5" aria-hidden="true">
          <Skeleton className="h-[104px] rounded-[14px] lg:h-[140px]" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-2.5 w-1/2" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4" aria-hidden="true">
      <Skeleton className="h-11 w-11 rounded-full" />
      <Skeleton className="h-52 rounded-[22px]" />
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-24 rounded-[18px]" />
    </div>
  );
}

export function SlowBanner({ onRetry }: { onRetry?: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-[14px] bg-dark px-3.5 py-3 text-[13px] text-white">
      <span className="size-2 flex-none rounded-full bg-coral" />
      <span className="flex-1">Slow network. Still trying to load this.</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-medium underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Notice big="!" band="Something went wrong" tone="warn" title="We couldn’t load this">
      <p className="text-[13px] leading-normal text-body">{message}</p>
      {onRetry && (
        <Button size="md" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Notice>
  );
}

const TONE = {
  dark: "bg-dark text-coral",
  light: "bg-fill text-ink",
  warn: "bg-warn-bg text-warn-fg",
  wait: "bg-wait-bg text-wait-fg",
  ok: "bg-ok-bg text-ok-fg",
};

const TONE_SUB = {
  dark: "text-dark-sub",
  light: "text-body",
  warn: "text-[#7a1a12]",
  wait: "text-[#5c3a06]",
  ok: "text-[#14532d]",
};

// The design's edge-state card: big value, what it means, one next step.
export function Notice({
  big,
  band,
  tone = "light",
  title,
  children,
}: {
  big: string;
  band: string;
  tone?: keyof typeof TONE;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-3xl bg-white p-4 shadow-card">
      <div className={`flex h-[76px] items-center gap-3 rounded-2xl px-4 ${TONE[tone]}`}>
        <span className="tabular text-3xl font-black">{big}</span>
        <span className={`text-[13px] leading-[1.35] ${TONE_SUB[tone]}`}>{band}</span>
      </div>
      <strong className="text-[17px] font-bold">{title}</strong>
      {children}
    </div>
  );
}

const STATUS = {
  warn: "bg-warn-bg text-warn-fg",
  wait: "bg-wait-bg text-wait-fg",
  info: "bg-[#f0f0f0] text-[#333333]",
  ok: "bg-ok-bg text-ok-fg",
  coral: "bg-coral text-on-coral",
};

export function StatusChip({ tone, children }: { tone: keyof typeof STATUS; children: ReactNode }) {
  return <span className={`whitespace-nowrap rounded-full px-2.5 py-[5px] text-xs font-medium ${STATUS[tone]}`}>{children}</span>;
}

const DIET: Record<Diet, { label: string; long: string; color: string; triangle?: boolean }> = {
  veg: { label: "Veg", long: "Veg", color: "#1B7F3B" },
  egg: { label: "Egg", long: "Contains egg", color: "#B45309" },
  nonveg: { label: "Non-veg", long: "Non-veg", color: "#A1341B", triangle: true },
  mixed: { label: "Varies", long: "Veg not guaranteed", color: "#6B6B6B" },
};

export function DietMark({ diet }: { diet: Diet }) {
  const { color, triangle } = DIET[diet];
  return (
    <span className="flex size-3 flex-none items-center justify-center rounded-[2px] border-[1.5px]" style={{ borderColor: color }}>
      <span
        className="size-1.5"
        style={{
          background: color,
          borderRadius: triangle ? 0 : "50%",
          clipPath: triangle ? "polygon(50% 0, 100% 100%, 0 100%)" : undefined,
        }}
      />
    </span>
  );
}

export function DietBadge({ diet }: { diet: Diet }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white px-[7px] py-[3px] text-[11px] font-medium text-ink">
      <DietMark diet={diet} />
      {DIET[diet].label}
    </span>
  );
}

export function dietLong(diet: Diet) {
  return DIET[diet].long;
}

export function Field({ label, hint, id, ...props }: ComponentProps<"input"> & { label: string; hint?: string; id: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-muted">
        {label}
      </label>
      <input
        id={id}
        className="h-14 w-full rounded-2xl border-none bg-fill px-4 text-base text-ink placeholder:text-faint"
        {...props}
      />
      {hint && <span className="text-[13px] text-muted">{hint}</span>}
    </div>
  );
}
