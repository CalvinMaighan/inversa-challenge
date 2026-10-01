/**
 * Carp domain logic, pure: which forecast was knowable at a time, observation series by source, conflicts between
 * sources, freshness, flood categories and the location briefing. Shapes follow api/schema.graphql (C3/C4).
 *
 * Rules kept here, from docs/evidence/carp-data-proof.md:
 * - flood categories come from NWPS stage only; USGS gauge height is for history and change (another datum at
 *   KRZL1, another physical gauge at MCGL1 and BTRL1);
 * - flow is always labelled with its source and never blended (USGS cfs vs NWPS kcfs disagree 5–7× at Monroe);
 * - a forecast older than 36 h is stale, an observation older than 6 h is stale; stale inputs leave the review
 *   with a stated reason;
 * - at Morgan City (tidal) change uses 24 h means.
 */

import { altitudeToFit } from "client/state/view";

export type FloodCategory ="NONE" | "ACTION" | "MINOR" | "MODERATE" | "MAJOR";
export type Freshness = "FRESH" | "AGING" | "STALE" | "MISSING";
export type ForecastSource = "NWPS_LIVE" | "IEM_ARCHIVE" | "NWS_GRIDPOINT";

export type ForecastPoint = { validAt: string; stageFt: number | null; flowKcfs: number | null; category: FloodCategory | null };

export type Snapshot = {
  id: string;
  site: string;
  product: string;
  issuedAt: string;
  ingestedAt: string;
  source: ForecastSource;
  revision: number;
  validFrom: string | null;
  validTo: string | null;
  horizonEnd: string | null;
  peakStageFt: number | null;
  peakAt: string | null;
  peakCategory: FloodCategory | null;
  points: ForecastPoint[];
};

export type Thresholds = { actionFt: number | null; minorFt: number | null; moderateFt: number | null; majorFt: number | null };

export type SiteObservation = { observedAt: string; ingestedAt: string; source: ForecastSource; stageFt: number | null; flowKcfs: number | null };

export type SiteConflict = { kind: string; detail: string; forecastFt: number | null; observedFt: number | null; differenceFt: number | null };

export type SiteStatus = {
  site: string;
  asOf: string;
  observation: SiteObservation | null;
  stageFt: number | null;
  category: FloodCategory | null;
  thresholds: Thresholds | null;
  observationFreshness: Freshness;
  conflicts: SiteConflict[];
  activeAlerts: number;
};

export type VerifyPoint = { validAt: string; forecastFt: number | null; observedAt: string | null; observedFt: number | null; errorFt: number | null; missing: boolean };

export type GqlReading = {
  param: string;
  value: number | null;
  observedAt: string;
  origin: string;
  flag?: string;
  station: { id: string; source: string; name?: string; lat: number; lon: number };
};

export type Alert = { id: string; event: string; severity: string; headline: string | null; onset: string | null; expires: string | null };

export type SeriesPoint = { t: number; v: number };

/** A configured carp location (spec/apps/carp.json `locations[]`), keyed by its NWPS lid. */
export type Site = { lid: string; id: string; name: string; lat: number; lon: number; usgs: string | null; note: string; tidal: boolean };

export const FEET_PER_METRE = 1 / 0.3048;
export const HOUR = 3_600_000;
/** Forecasts: fresh ≤ 24 h since issuance, aging ≤ 36 h, then stale (the same bands as the API). */
export const FORECAST_STALE_H = 36;
/** Observations: fresh ≤ 2 h, aging ≤ 6 h, then stale. */
export const OBS_STALE_H = 6;
/** Two stage sources this far apart at the same hour disagree (datum or gauge). */
export const STAGE_CONFLICT_FT = 0.5;
/** Two flow sources this many times apart disagree. */
export const FLOW_CONFLICT_RATIO = 1.5;

const CATEGORY_ORDER: readonly FloodCategory[] = ["NONE", "ACTION", "MINOR", "MODERATE", "MAJOR"];
export const categoryRank = (c: FloodCategory | null | undefined): number => (c ? CATEGORY_ORDER.indexOf(c) : -1);

export const CATEGORY_WORDS: Record<FloodCategory, string> = { NONE: "below action stage", ACTION: "action stage", MINOR: "minor flood", MODERATE: "moderate flood", MAJOR: "major flood" };

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Locations of a conditions app config with an NWPS lid. */
export function sitesOf(locations: readonly { id: string; name: string; lat: number; lon: number; usgs?: string | null; nwps?: string | null; note?: string }[]): Site[] {
  return locations
    .filter((l) => typeof l.nwps === "string" && l.nwps.length > 0)
    .map((l) => ({ lid: l.nwps!, id: l.id, name: l.name, lat: l.lat, lon: l.lon, usgs: l.usgs ?? null, note: l.note ?? "", tidal: /tidal/i.test(l.note ?? "") }));
}

/**
 * Camera that frames a set of sites with a margin (the data proof recommends fitting bounds over fixed zooms). With
 * `hud` (a wide screen) the box also reaches under the board (left) and the timeline (bottom), so no site sits
 * behind them.
 */
export function frameSites(sites: readonly Pick<Site, "lat" | "lon">[], hud = true) {
  const lats = sites.map((s) => s.lat);
  const lons = sites.map((s) => s.lon);
  const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons), 0.5);
  const bbox = {
    west: Math.min(...lons) - 0.15 * span - (hud ? 0.45 * span : 0),
    east: Math.max(...lons) + 0.15 * span,
    south: Math.min(...lats) - 0.12 * span - (hud ? 0.4 * span : 0),
    north: Math.max(...lats) + 0.12 * span,
  };
  return { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2, altitudeM: altitudeToFit(bbox), heading: 0, pitch: -90 };
}

// ---- forecasts ---------------------------------------------------------------------------------

/** River stage forecasts only: the NWS gridpoint (weather) snapshots share the store but carry no stage. */
export function isRiverForecast(s: Pick<Snapshot, "source" | "product">): boolean {
  return s.source !== "NWS_GRIDPOINT";
}

/**
 * When a snapshot became knowable to us: an archive copy at its issuance (it was public then), a live capture
 * when we stored it (C3 `ForecastView.snapshot`).
 */
export function knowableAt(s: Pick<Snapshot, "source" | "issuedAt" | "ingestedAt">): number {
  const issued = ms(s.issuedAt);
  return s.source === "IEM_ARCHIVE" ? issued : Math.max(issued, ms(s.ingestedAt));
}

/**
 * The river forecast in force at `asOfMs`: the latest issuance knowable by then, newest revision; a live capture
 * wins over the archive copy of the same issuance.
 */
export function forecastAsOf(history: readonly Snapshot[], asOfMs: number): Snapshot | null {
  let best: Snapshot | null = null;
  for (const s of history) {
    if (!isRiverForecast(s) || knowableAt(s) > asOfMs) continue;
    if (!best) {
      best = s;
      continue;
    }
    const d = ms(s.issuedAt) - ms(best.issuedAt);
    if (d > 0 || (d === 0 && (s.revision > best.revision || (s.revision === best.revision && s.source === "NWPS_LIVE" && best.source !== "NWPS_LIVE")))) best = s;
  }
  return best;
}

/** Issuances before `snapshot` (distinct issuance times, newest first), river forecasts knowable by `asOfMs`. */
export function earlierIssuances(history: readonly Snapshot[], snapshot: Snapshot, asOfMs: number): Snapshot[] {
  const seen = new Set<number>([ms(snapshot.issuedAt)]);
  const out: Snapshot[] = [];
  for (const s of [...history].sort((a, b) => ms(b.issuedAt) - ms(a.issuedAt))) {
    const t = ms(s.issuedAt);
    if (!isRiverForecast(s) || seen.has(t) || t > ms(snapshot.issuedAt) || knowableAt(s) > asOfMs) continue;
    seen.add(t);
    out.push(s);
  }
  return out;
}

export function freshnessOfForecast(s: Snapshot | null, asOfMs: number): Freshness {
  if (!s) return "MISSING";
  const age = (asOfMs - ms(s.issuedAt)) / HOUR;
  return age <= 24 ? "FRESH" : age <= FORECAST_STALE_H ? "AGING" : "STALE";
}

export function freshnessOfObservation(observedMs: number | null, asOfMs: number): Freshness {
  if (observedMs === null || !Number.isFinite(observedMs)) return "MISSING";
  const age = (asOfMs - observedMs) / HOUR;
  return age <= 2 ? "FRESH" : age <= OBS_STALE_H ? "AGING" : "STALE";
}

/** Stage points of a forecast, as a series. */
export function forecastSeries(s: Snapshot | null): SeriesPoint[] {
  return (s?.points ?? []).filter((p) => finite(p.stageFt)).map((p) => ({ t: ms(p.validAt), v: p.stageFt! }));
}

/** Highest forecast stage, with time and category (computed from the points when the API left the peak out). */
export function forecastPeak(s: Snapshot | null): { ft: number; at: number; category: FloodCategory | null } | null {
  if (!s) return null;
  if (finite(s.peakStageFt)) return { ft: s.peakStageFt, at: ms(s.peakAt), category: s.peakCategory };
  let best: ForecastPoint | null = null;
  for (const p of s.points) if (finite(p.stageFt) && (!best || p.stageFt > best.stageFt!)) best = p;
  return best ? { ft: best.stageFt!, at: ms(best.validAt), category: best.category } : null;
}

/**
 * How far a forecast moved against an earlier issuance: the largest change at a valid time both cover (a later
 * issuance reaches further out, so comparing peaks would count the extra days as drift). Null without overlap.
 */
export function forecastDrift(current: Snapshot | null, previous: Snapshot | null): { ft: number; at: number } | null {
  if (!current || !previous) return null;
  const before = new Map(forecastSeries(previous).map((p) => [p.t, p.v]));
  let best: { ft: number; at: number } | null = null;
  for (const p of forecastSeries(current)) {
    const v = before.get(p.t);
    if (v === undefined) continue;
    const d = p.v - v;
    if (!best || Math.abs(d) > Math.abs(best.ft)) best = { ft: d, at: p.t };
  }
  return best;
}

/**
 * Low and high of the last `n` issuances (this one included) at each of this forecast's valid times: how much
 * the forecast moved between issuances. Not a confidence interval; NWPS publishes none.
 */
export function issuanceSpread(snapshot: Snapshot | null, earlier: readonly Snapshot[], n = 3): { t: number; lo: number; hi: number }[] {
  if (!snapshot) return [];
  const others = earlier.slice(0, Math.max(0, n - 1)).map((s) => new Map(forecastSeries(s).map((p) => [p.t, p.v])));
  return forecastSeries(snapshot).map((p) => {
    let lo = p.v;
    let hi = p.v;
    for (const m of others) {
      const v = m.get(p.t);
      if (v !== undefined) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    return { t: p.t, lo, hi };
  });
}

// ---- observations ------------------------------------------------------------------------------

/** The site's USGS station among readings: source `usgs`, nearest within 0.08° of the NWPS point. */
export function usgsStationId(readings: readonly GqlReading[], site: Pick<Site, "lat" | "lon">): string | null {
  let best: { id: string; d: number } | null = null;
  for (const r of readings) {
    if (r.station.source !== "usgs") continue;
    const d = Math.hypot(r.station.lat - site.lat, r.station.lon - site.lon);
    if (d <= 0.08 && (!best || d < best.d)) best = { id: r.station.id, d };
  }
  return best?.id ?? null;
}

export type UsgsSeries = { stationId: string | null; stageFt: SeriesPoint[]; dischargeCfs: SeriesPoint[] };

/** USGS gauge height (stored in metres, shown in feet on the USGS datum) and discharge (cfs), oldest first. */
export function usgsSeries(readings: readonly GqlReading[], site: Pick<Site, "lat" | "lon">): UsgsSeries {
  const stationId = usgsStationId(readings, site);
  const stageFt: SeriesPoint[] = [];
  const dischargeCfs: SeriesPoint[] = [];
  for (const r of readings) {
    if (r.station.id !== stationId || !finite(r.value) || (r.flag && r.flag !== "OK")) continue;
    const t = ms(r.observedAt);
    if (r.param === "STAGE_M") stageFt.push({ t, v: r.value * FEET_PER_METRE });
    else if (r.param === "DISCHARGE_CFS") dischargeCfs.push({ t, v: r.value });
  }
  const byTime = (a: SeriesPoint, b: SeriesPoint) => a.t - b.t;
  return { stationId, stageFt: stageFt.sort(byTime), dischargeCfs: dischargeCfs.sort(byTime) };
}

/** Modelled NWS gridpoint weather (air °C, wind m/s) nearest `atMs`, for the site's grid cell. */
export function weatherAt(readings: readonly GqlReading[], site: Pick<Site, "lat" | "lon">, atMs: number): { airC: SeriesPoint | null; windMs: SeriesPoint | null } {
  const near = (param: string): SeriesPoint | null => {
    let best: SeriesPoint | null = null;
    for (const r of readings) {
      if (r.param !== param || r.station.source !== "nws-forecast" || !finite(r.value)) continue;
      if (Math.hypot(r.station.lat - site.lat, r.station.lon - site.lon) > 0.02) continue;
      const t = ms(r.observedAt);
      if (!best || Math.abs(t - atMs) < Math.abs(best.t - atMs)) best = { t, v: r.value };
    }
    return best && Math.abs(best.t - atMs) <= 6 * HOUR ? best : null;
  };
  return { airC: near("AIR_C"), windMs: near("WIND_MS") };
}

/** Newest point at or before `atMs`. */
export function latestAt(series: readonly SeriesPoint[], atMs: number): SeriesPoint | null {
  let best: SeriesPoint | null = null;
  for (const p of series) if (p.t <= atMs && (!best || p.t > best.t)) best = p;
  return best;
}

/** Point nearest `atMs` within `withinMs`. */
export function nearest(series: readonly SeriesPoint[], atMs: number, withinMs: number): SeriesPoint | null {
  let best: SeriesPoint | null = null;
  for (const p of series) if (Math.abs(p.t - atMs) <= withinMs && (!best || Math.abs(p.t - atMs) < Math.abs(best.t - atMs))) best = p;
  return best;
}

const mean = (xs: readonly SeriesPoint[]) => (xs.length ? xs.reduce((s, p) => s + p.v, 0) / xs.length : null);

/**
 * Stage change over the 24 h before `atMs`: newest value minus the value nearest 24 h earlier (within 1 h). At a
 * tidal site the mean of the last 24 h minus the mean of the 24 h before that. Null when history is too short.
 */
export function change24h(series: readonly SeriesPoint[], atMs: number, tidal = false): { ft: number; method: "instant" | "mean" } | null {
  if (tidal) {
    const last = series.filter((p) => p.t > atMs - 24 * HOUR && p.t <= atMs);
    const prev = series.filter((p) => p.t > atMs - 48 * HOUR && p.t <= atMs - 24 * HOUR);
    if (last.length < 12 || prev.length < 12) return null;
    return { ft: mean(last)! - mean(prev)!, method: "mean" };
  }
  const now = latestAt(series, atMs);
  if (!now || atMs - now.t > OBS_STALE_H * HOUR) return null;
  const then = nearest(series, now.t - 24 * HOUR, HOUR);
  return then ? { ft: now.v - then.v, method: "instant" } : null;
}

// ---- conflicts ---------------------------------------------------------------------------------

export type SourceConflict =
  | { kind: "stage"; usgsFt: number; nwpsFt: number; differenceFt: number; atMs: number }
  | { kind: "flow"; usgsCfs: number; nwpsCfs: number; ratio: number; atMs: number };

/** USGS gauge height vs NWPS stage within an hour of each other, `STAGE_CONFLICT_FT` or more apart. */
export function stageConflict(usgsStage: readonly SeriesPoint[], nwps: { t: number; ft: number } | null): SourceConflict | null {
  if (!nwps) return null;
  const u = nearest(usgsStage, nwps.t, HOUR);
  if (!u) return null;
  const d = u.v - nwps.ft;
  return Math.abs(d) >= STAGE_CONFLICT_FT ? { kind: "stage", usgsFt: u.v, nwpsFt: nwps.ft, differenceFt: d, atMs: nwps.t } : null;
}

/** USGS discharge vs NWPS flow within an hour, `FLOW_CONFLICT_RATIO` times or more apart. */
export function flowConflict(usgsCfs: readonly SeriesPoint[], nwps: { t: number; kcfs: number } | null): SourceConflict | null {
  if (!nwps || !(nwps.kcfs > 0)) return null;
  const u = nearest(usgsCfs, nwps.t, HOUR);
  if (!u || !(u.v > 0)) return null;
  const nwpsCfs = nwps.kcfs * 1000;
  const ratio = Math.max(u.v, nwpsCfs) / Math.min(u.v, nwpsCfs);
  return ratio >= FLOW_CONFLICT_RATIO ? { kind: "flow", usgsCfs: u.v, nwpsCfs, ratio, atMs: nwps.t } : null;
}

// ---- thresholds --------------------------------------------------------------------------------

export const THRESHOLD_KEYS = [
  ["actionFt", "Action"],
  ["minorFt", "Minor flood"],
  ["moderateFt", "Moderate flood"],
  ["majorFt", "Major flood"],
] as const;

/** Defined thresholds, lowest first (NWPS `-9999` arrives as null and is left out). */
export function thresholdList(t: Thresholds | null | undefined): { key: (typeof THRESHOLD_KEYS)[number][0]; label: string; ft: number }[] {
  if (!t) return [];
  return THRESHOLD_KEYS.filter(([k]) => finite(t[k]) && t[k]! > -999).map(([k, label]) => ({ key: k, label, ft: t[k]! }));
}

export function categoryOf(stageFt: number | null | undefined, t: Thresholds | null | undefined): FloodCategory | null {
  const list = thresholdList(t);
  if (!finite(stageFt) || list.length === 0) return null;
  let c: FloodCategory = "NONE";
  for (const { key, ft } of list) if (stageFt >= ft) c = key === "actionFt" ? "ACTION" : key === "minorFt" ? "MINOR" : key === "moderateFt" ? "MODERATE" : "MAJOR";
  return c;
}
