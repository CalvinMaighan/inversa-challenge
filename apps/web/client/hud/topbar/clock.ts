/**
 * Clock text for the top bar. UTC is the ops reference; "local" is the active app's own zone (config
 * `copy.timezone`: South Florida's America/New_York for python, Louisiana's America/Chicago for carp), not the
 * viewer's browser zone, so a remote analyst and a field crew read the same time.
 */
import { activeApp } from "client/state/app";
import { appTimeZone } from "shared/apps";

/** The active app's local zone. */
export function regionTimeZone(): string {
  return appTimeZone(activeApp());
}

const localFmts = new Map<string, Intl.DateTimeFormat>();
/** One formatter per use and zone (an app switch changes the zone); `use` names the caller's format. */
export function zoneFormatter(use: string, zone: string, make: (zone: string) => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const key = `${use}|${zone}`;
  let f = localFmts.get(key);
  if (!f) {
    f = make(zone);
    localFmts.set(key, f);
  }
  return f;
}

const utcFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const clockFmt = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" });
/** Fixed three-letter months: `Intl` abbreviates September as "Sept" in newer ICU and "Sep" in older, so the label would depend on the machine. */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const dateLabel = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`;

export function formatClocks(ms: number, zone: string = regionTimeZone()): { utc: string; local: string; zone: string; date: string } {
  const d = new Date(ms);
  const parts = zoneFormatter("clock", zone, clockFmt).formatToParts(d);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    utc: `${utcFmt.format(d)}Z`,
    local: `${pick("hour")}:${pick("minute")}:${pick("second")}`,
    zone: pick("timeZoneName"),
    date: dateLabel(d),
  };
}

/** A window whose end is older than this is a historical window (TIME moved back), not the live one. */
export const LIVE_WINDOW_SLACK_MS = 24 * 3_600_000;

/**
 * The TIME cursor is on the live edge when it is at (or past) the window end. `at: null` also means live.
 * With `nowMs`, the window must also end within `LIVE_WINDOW_SLACK_MS` of now: the end of a window moved to
 * last February is not live.
 */
export function isLive(time: { at: string | null; to: string }, nowMs?: number): boolean {
  if (nowMs !== undefined && Date.parse(time.to) < nowMs - LIVE_WINDOW_SLACK_MS) return false;
  if (!time.at) return true;
  return Date.parse(time.at) >= Date.parse(time.to);
}
