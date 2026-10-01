/**
 * The location briefing (docs/APPS.md "location briefing (changed, expected, missing)") and the "sources disagree"
 * explanations, as plain sentences with units, datums and sources. Pure: the card renders the lists as given.
 */
import { cfs, ft, kcfs, localDay, localTime, signedFt } from "./format";
import {
  CATEGORY_WORDS,
  change24h,
  forecastDrift,
  forecastPeak,
  latestAt,
  thresholdList,
  type Alert,
  type SeriesPoint,
  type Site,
  type SiteStatus,
  type Snapshot,
  type SourceConflict,
  type UsgsSeries,
} from "./model";
import { forecastSourceLabel, type SiteReview } from "./review";

export type Briefing = { changed: string[]; expected: string[]; missing: string[] };

export type BriefingInput = {
  site: Site;
  asOfMs: number;
  live: boolean;
  zone: string;
  status: SiteStatus | null;
  forecast: Snapshot | null;
  previous: Snapshot | null;
  usgs: UsgsSeries;
  /** USGS series over the whole chart window (after the as-of time too): tells "never measured" from "not held then". */
  usgsWindow?: UsgsSeries;
  alerts: readonly Alert[] | null;
  /** When the alerts were checked (the as-of time, or the live query time). */
  alertsCheckedMs: number;
  weather: { airC: SeriesPoint | null; windMs: SeriesPoint | null } | null;
  review: SiteReview | null;
};

export function briefing(input: BriefingInput): Briefing {
  const { site, asOfMs, live, zone, status, forecast, previous, usgs, alerts, weather, review } = input;
  const changed: string[] = [];
  const expected: string[] = [];
  const missing: string[] = [];
  const at = (ms: number) => localTime(ms, zone);

  // What changed.
  const obs = status?.observation;
  if (obs && obs.stageFt !== null) {
    const cat = status?.category ? ` (${CATEGORY_WORDS[status.category]})` : "";
    changed.push(`NWPS stage ${ft(obs.stageFt)} at ${at(Date.parse(obs.observedAt))}${cat}.`);
  }
  const change = change24h(usgs.stageFt, asOfMs, site.tidal);
  if (change) changed.push(`USGS gauge height ${signedFt(change.ft)} over 24 h${change.method === "mean" ? " (24 h means, tidal)" : ""}.`);
  else {
    const first = usgs.stageFt[0];
    missing.push(first ? `24 h stage change: USGS history starts ${at(first.t)}, less than a day before this time.` : "24 h stage change: no USGS gauge height held for this period.");
  }
  const peak = forecastPeak(forecast);
  if (forecast) {
    const issued = `${at(Date.parse(forecast.issuedAt))} (${forecastSourceLabel(forecast.source)})`;
    const drift = forecastDrift(forecast, previous);
    if (drift) changed.push(`Forecast issued ${issued}; against the issuance of ${localDay(Date.parse(previous!.issuedAt), zone)} it moved at most ${signedFt(drift.ft, 1)} (for ${at(drift.at)}).`);
    else changed.push(`Forecast issued ${issued}.`);
  }

  // What is expected.
  const action = thresholdList(status?.thresholds).find((t) => t.key === "actionFt")?.ft ?? null;
  if (peak) {
    const vs = action === null ? "no action stage known" : peak.ft >= action ? `at or above action stage ${ft(action, 1)}` : `${ft(action - peak.ft, 1)} below action stage ${ft(action, 1)}`;
    expected.push(`Forecast peak ${ft(peak.ft, 1)} on ${localDay(peak.at, zone)}, ${vs} (NWPS datum).`);
  }
  if (forecast?.horizonEnd ?? forecast?.validTo) expected.push(`The forecast runs to ${at(Date.parse((forecast.horizonEnd ?? forecast.validTo)!))}.`);
  if (alerts) {
    if (alerts.length === 0) expected.push(`No active NWS alerts at the location (checked for ${at(input.alertsCheckedMs)}).`);
    else for (const a of alerts.slice(0, 3)) expected.push(`NWS ${a.event}${a.expires ? ` until ${at(Date.parse(a.expires))}` : ""}.`);
  }
  if (live && weather && (weather.airC || weather.windMs)) {
    const parts = [weather.airC ? `${weather.airC.v.toFixed(0)} °C air` : null, weather.windMs ? `wind ${weather.windMs.v.toFixed(1)} m/s` : null].filter(Boolean);
    expected.push(`NWS gridpoint forecast near now: ${parts.join(", ")} (modelled).`);
  }

  // What is missing.
  for (const r of review?.reasons ?? []) if (r.kind === "gap") missing.push(r.text);
  const usgsFlow = latestAt(usgs.dischargeCfs, asOfMs);
  const nwpsFlow = obs?.flowKcfs;
  const estimate = typeof nwpsFlow === "number" ? ` NWS estimate ${kcfs(nwpsFlow)} (NWPS).` : "";
  const flow = flowAvailability(input.usgsWindow ?? usgs, usgs);
  if (flow === "not_measured") missing.push(`Flow: not measured at this gauge (USGS).${estimate}`);
  else if (flow === "none_held") missing.push(`Flow: no USGS discharge held at this time.${estimate}`);
  else if (flow === "no_readings") missing.push(`Flow: no USGS readings in this window.${estimate}`);
  else if (usgsFlow && site.tidal) {
    changed.push(`USGS discharge ${cfs(usgsFlow.v)} at ${at(usgsFlow.t)}; tidal site, so one reading swings within the hour.`);
  }
  if (!live) missing.push("Weather forecasts are not replayed; the NWS gridpoint forecast is shown live only.");
  if (!forecast && !review?.reasons.some((r) => r.rule === "missing_forecast")) missing.push("No river forecast was held at this time.");
  return { changed, expected, missing };
}

/**
 * Whether the USGS gauge measures flow: it reported gauge height over the window but never discharge
 * (`not_measured`, KRZL1, BLRL1, AEXL1); discharge exists in the window but none by the as-of time (`none_held`);
 * nothing from USGS at all, so we cannot tell (`no_readings`); or there is a value (`held`).
 */
export function flowAvailability(window: UsgsSeries, known: UsgsSeries): "not_measured" | "none_held" | "no_readings" | "held" {
  if (window.dischargeCfs.length === 0) return window.stageFt.length > 0 ? "not_measured" : "no_readings";
  return known.dischargeCfs.length === 0 ? "none_held" : "held";
}

/** Plain explanation of a source conflict, for the "sources disagree" chip. */
export function conflictText(c: SourceConflict, zone: string): { title: string; detail: string } {
  if (c.kind === "stage") {
    return {
      title: "Sources disagree: stage",
      detail:
        `USGS gauge height ${ft(c.usgsFt)} and NWPS stage ${ft(c.nwpsFt)} near ${localTime(c.atMs, zone)} differ by ${ft(Math.abs(c.differenceFt))}. ` +
        "They are read on different datums or at different gauges, so they are not averaged; flood categories use NWPS stage only.",
    };
  }
  return {
    title: "Sources disagree: flow",
    detail:
      `USGS discharge ${cfs(c.usgsCfs)} and NWPS flow ${cfs(c.nwpsCfs)} near ${localTime(c.atMs, zone)} differ ${c.ratio.toFixed(1)}×. ` +
      "Neither is adjusted or blended; each flow number is shown with its source.",
  };
}
