import { brand } from "@/config/brand";

const IST = "Asia/Kolkata";

// Money from the API is integer paise.
export function rupees(paise: number): string {
  const whole = paise % 100 === 0;
  return (
    "₹" +
    (paise / 100).toLocaleString("en-IN", {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

function parts(iso: string) {
  const text = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(iso))
    .toLowerCase();
  const [clockText, meridiem] = text.split(/\s+/);
  return { clock: clockText, meridiem };
}

export function time(iso: string): string {
  const { clock: clockText, meridiem } = parts(iso);
  return `${clockText} ${meridiem}`;
}

export function timeRange(startIso: string, endIso: string): string {
  const start = parts(startIso);
  const end = parts(endIso);
  return start.meridiem === end.meridiem
    ? `${start.clock}–${end.clock} ${end.meridiem}`
    : `${start.clock} ${start.meridiem}–${end.clock} ${end.meridiem}`;
}

export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(new Date(iso))
    .replace(",", "");
}

// IST calendar date as YYYY-MM-DD.
export function istDay(when: string | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date(when));
}

export function clock(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

export function orderNumber(number: number): string {
  return `${brand.orderPrefix}-${number}`;
}

export function phoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

export function phoneMasked(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);
  return `+91 ${digits.slice(0, 5)} •••${digits.slice(8)}`;
}

// "Priya Sharma" -> "Priya S."
export function shortName(name: string | null): string {
  if (!name) return "";
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

export function initials(name: string | null): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/);
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (words[0][0] + last).toUpperCase();
}
