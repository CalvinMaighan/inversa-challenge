/**
 * Carp text formatting: times in the app's zone (Louisiana, America/Chicago) with the zone abbreviation, UTC on
 * request, and numbers with their unit and datum. Every number the carp UI shows goes through here, so a unit is
 * never dropped.
 */

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(opts)}`;
  let f = fmts.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...opts });
    fmts.set(key, f);
  }
  return f;
}

const valid = (ms: number | null | undefined): ms is number => typeof ms === "number" && Number.isFinite(ms);
export const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** `Sep 30, 3:00 PM CDT`, assembled from parts so every ICU build writes the same text. */
export function localTime(ms: number | null | undefined, zone: string): string {
  if (!valid(ms)) return "unknown time";
  const parts = fmt(zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(ms);
  const p = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("month")} ${p("day")}, ${p("hour")}:${p("minute")} ${p("dayPeriod")} ${p("timeZoneName")}`;
}

/** `3:00 PM` (no date, no zone). */
export function localClock(ms: number, zone: string): string {
  return fmt(zone, { hour: "numeric", minute: "2-digit" }).format(ms);
}

/** `Sep 30` in the zone. */
export function localDay(ms: number, zone: string): string {
  return fmt(zone, { month: "short", day: "numeric" }).format(ms);
}

/** `2026-09-30 20:00Z`. */
export function utcTime(ms: number | null | undefined): string {
  if (!valid(ms)) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** `3 h ago`, `2 d ago`, `in 5 h`, against `nowMs`. */
export function ago(ms: number | null | undefined, nowMs: number): string {
  if (!valid(ms)) return "unknown";
  const d = nowMs - ms;
  const abs = Math.abs(d);
  const words = abs < 90 * 60_000 ? `${Math.max(1, Math.round(abs / 60_000))} min` : abs < 48 * 3_600_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
  return d >= 0 ? `${words} ago` : `in ${words}`;
}

const fixed = (v: number, digits: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(digits));

/** `4.05 ft`; `—` for no value. */
export function ft(v: number | null | undefined, digits = 2): string {
  return valid(v) ? `${fixed(v, digits)} ft` : "—";
}

/** `+0.49 ft` / `−0.09 ft` (true minus sign). */
export function signedFt(v: number | null | undefined, digits = 2): string {
  if (!valid(v)) return "—";
  const s = Math.abs(v).toFixed(digits);
  return v > 0 ? `+${s} ft` : v < 0 ? `−${s} ft` : `${s} ft`;
}

/** `118,000 cfs`. */
export function cfs(v: number | null | undefined): string {
  return valid(v) ? `${Math.round(v).toLocaleString("en-US")} cfs` : "—";
}

/** `8.18 kcfs (8,180 cfs)`: NWPS publishes thousands of cubic feet per second; the cfs form makes it comparable. */
export function kcfs(v: number | null | undefined): string {
  return valid(v) ? `${v.toFixed(2)} kcfs (${Math.round(v * 1000).toLocaleString("en-US")} cfs)` : "—";
}

/** Offset of `zone` from UTC at `ms`, in ms (CDT: −5 h). */
export function zoneOffsetMs(ms: number, zone: string): number {
  const parts = fmt(zone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant of a wall-clock time in `zone` (`y-m-d h:00` local), DST-aware. */
export function zonedInstant(y: number, month: number, d: number, h: number, zone: string): number {
  const guess = Date.UTC(y, month - 1, d, h);
  const first = guess - zoneOffsetMs(guess, zone);
  return guess - zoneOffsetMs(first, zone);
}

/** "Yesterday afternoon" in the app's zone: 3 PM local the day before `nowMs`. */
export function yesterdayAfternoon(nowMs: number, zone: string): number {
  const parts = fmt(zone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(nowMs);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const today = Date.UTC(n("year"), n("month") - 1, n("day"));
  const y = new Date(today - 86_400_000);
  return zonedInstant(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), 15, zone);
}
