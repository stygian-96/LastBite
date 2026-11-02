const IST = "Asia/Kolkata";

// Some API times come as Postgres text ("2026-11-02 15:00:00+00"), which Safari can't parse.
export function toDate(value: string | number): Date {
  if (typeof value === "number") return new Date(value);
  return new Date(value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
}

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
    .format(toDate(iso))
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
    .format(toDate(iso))
    .replace(",", "");
}

export function dayRange(startDay: string, endDay: string): string {
  const format = (day: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", ...options }).format(new Date(`${day}T00:00:00Z`));
  return `${format(startDay, { day: "numeric", month: "short" })} – ${format(endDay, { day: "numeric", month: "short" })}`;
}

// IST calendar date as YYYY-MM-DD.
export function istDay(when: string | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(toDate(when));
}

export function clock(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
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

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function hourText(hhmm: string) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const twelve = hour % 12 || 12;
  return `${twelve}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour < 12 ? "am" : "pm"}`;
}

// Opening hours are stored per weekday. Null when the outlet is shut today.
export function hoursToday(hours: Partial<Record<(typeof DAY_KEYS)[number], string[][]>> | null, now: number): string | null {
  const weekday = new Date(new Date(now).toLocaleString("en-US", { timeZone: IST })).getDay();
  const slots = hours?.[DAY_KEYS[weekday]];
  if (!slots?.length) return null;
  return slots.map(([open, close]) => `${hourText(open)}–${hourText(close)}`).join(", ");
}
