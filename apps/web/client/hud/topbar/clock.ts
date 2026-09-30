/**
 * Clock text for the top bar. UTC is the ops reference; "local" is the region's own zone (South Florida,
 * America/New_York), not the viewer's browser zone, so a remote analyst and a field crew read the same time.
 */

export const REGION_TIME_ZONE = "America/New_York";

const utcFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const localFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: REGION_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short" });

export function formatClocks(ms: number): { utc: string; local: string; zone: string; date: string } {
  const d = new Date(ms);
  const parts = localFmt.formatToParts(d);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    utc: `${utcFmt.format(d)}Z`,
    local: `${pick("hour")}:${pick("minute")}:${pick("second")}`,
    zone: pick("timeZoneName"),
    date: dateFmt.format(d).toUpperCase(),
  };
}

/** The TIME cursor is on the live edge when it is at (or past) the window end. `at: null` also means live. */
export function isLive(time: { at: string | null; to: string }): boolean {
  if (!time.at) return true;
  return Date.parse(time.at) >= Date.parse(time.to);
}
