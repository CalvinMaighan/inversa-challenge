/**
 * Lionfish Watch (leaf UL): pure model for the survey-priority HUD. Everything here works on plain records the
 * data module loaded once, so scrubbing the timeline recomputes from memory and never asks the network.
 *
 * Honesty rules (docs/LIONFISH_WATCH.md, PLAN.md P3) that the model enforces rather than leaves to copy:
 * - reports are counted, never turned into abundance; a GBIF copy of an iNaturalist record (`canonicalId` set)
 *   is drawn but never counted;
 * - unknown is not zero: a component, heat value or date that is missing stays null and reads as a word;
 * - observed and submitted dates are separate bases, and "known at" a past time means submitted by then;
 * - component values are numbers in [0, 1] shown as such, never as a percent.
 */
import type { AppConfig, AppRegion } from "shared/apps";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// ---- app --------------------------------------------------------------------------------------

/** Score components of a survey app, in display order. */
export const COMPONENT_IDS = ["recentReports", "idQuality", "heatStress", "completeness"] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

/**
 * A survey-priority app (Lionfish Watch): a species app whose score is the four separate components. The HUD
 * mounts the lionfish layers for it, and the generic sightings and hotspot rasters stand down.
 */
export function isSurveyApp(app: Pick<AppConfig, "kind" | "score">): boolean {
  const ids = app.score.components.map((c) => c.id);
  return app.kind === "species" && COMPONENT_IDS.every((id) => ids.includes(id));
}

export type Area = { id: string; code: string; name: string; bbox: AppRegion["bbox"]; camera: AppRegion["camera"]; thin: boolean };

export function areasOf(app: AppConfig): Area[] {
  return app.regions.map((r) => ({ id: r.id, code: r.code ?? r.id, name: r.name, bbox: r.bbox, camera: r.camera, thin: r.thin }));
}

/**
 * A straight-down camera that shows every area, with room on the left for the survey panel and at the bottom for
 * the timeline when `hud` (a desktop pane); `altitudeM` fits the box in the globe's 60° field of view.
 */
export function frameAreas(areas: readonly Pick<Area, "bbox">[], hud = true): { lat: number; lon: number; altitudeM: number; heading: number; pitch: number } {
  const west = Math.min(...areas.map((a) => a.bbox.west));
  const east = Math.max(...areas.map((a) => a.bbox.east));
  const south = Math.min(...areas.map((a) => a.bbox.south));
  const north = Math.max(...areas.map((a) => a.bbox.north));
  const span = Math.max(east - west, north - south);
  const box = { west: west - 0.05 * span - (hud ? 0.35 * span : 0), east: east + 0.05 * span, south: south - 0.05 * span - (hud ? 0.12 * span : 0), north: north + 0.08 * span + (hud ? 0.2 * span : 0) };
  const midLat = ((box.south + box.north) / 2) * (Math.PI / 180);
  const half = Math.max((box.east - box.west) * Math.cos(midLat), box.north - box.south) * 111_320 / 2;
  return { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2, altitudeM: Math.round((half / Math.tan(Math.PI / 6)) * 1.1), heading: 0, pitch: -90 };
}

export function areaOf(areas: readonly Area[], lat: number, lon: number): Area | null {
  return areas.find((a) => lat >= a.bbox.south && lat <= a.bbox.north && lon >= a.bbox.west && lon <= a.bbox.east) ?? null;
}

// ---- reports ----------------------------------------------------------------------------------

export type Basis = "observed" | "submitted";
export const WINDOW_DAYS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_WINDOW_DAYS: WindowDays = 30;
/** A report uploaded more than this long after the dive is "late" (newly submitted report of an older sighting). */
export const LATE_MS = 30 * DAY;

export type Quality = "RESEARCH" | "NEEDS_ID" | "CASUAL" | "CURATED";

export type Report = {
  id: string;
  source: string;
  extId: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  observedMs: number;
  /** Upload time at the source (iNat `created_at`); null when the source has none (GBIF, NAS) or it is not known. */
  submittedMs: number | null;
  ingestedMs: number;
  quality: Quality;
  photoUrl: string | null;
  /** The row this one copies (a GBIF copy of an iNat record): drawn, never counted. */
  duplicateOf: string | null;
  conflict: boolean;
  areaId: string | null;
};

export const isCopy = (r: Pick<Report, "duplicateOf">) => r.duplicateOf !== null;

/** When the report was known: its upload, or (GBIF, NAS, no upload date) its observed date standing in. */
export const knownMs = (r: Pick<Report, "submittedMs" | "observedMs">) => r.submittedMs ?? r.observedMs;

export function basisMs(r: Pick<Report, "submittedMs" | "observedMs">, basis: Basis): number | null {
  return basis === "observed" ? r.observedMs : r.submittedMs;
}

/** Submitted more than 30 days after it was observed. Unknown upload dates are not late. */
export const isLate = (r: Pick<Report, "submittedMs" | "observedMs">) => r.submittedMs !== null && r.submittedMs - r.observedMs > LATE_MS;

export type ReportQuery = { basis: Basis; atMs: number; days: number; /** The period's start: when given, it replaces the trailing `days`. */ fromMs?: number; lateOnly?: boolean; areaId?: string | null };

/**
 * Reports from the period's start (else the trailing `days`) to `atMs`, on the chosen date basis, that were known by
 * then. GBIF copies of iNaturalist records are not reports: they are dropped, not drawn and not counted.
 */
export function windowReports(reports: readonly Report[], q: ReportQuery): Report[] {
  const from = q.fromMs ?? q.atMs - q.days * DAY;
  return reports.filter((r) => {
    if (isCopy(r)) return false;
    if (q.areaId && r.areaId !== q.areaId) return false;
    if (knownMs(r) > q.atMs) return false;
    if (q.lateOnly && !isLate(r)) return false;
    const t = basisMs(r, q.basis);
    return t !== null && t > from && t <= q.atMs;
  });
}

export type ReportCount = {
  /** Independent reports (copies excluded). */
  independent: number;
  /** GBIF copies of iNat records in the window: shown, not counted. */
  copies: number;
  /** Late uploads among the independent reports. */
  late: number;
  /** Submitted basis only: independent reports in the observed window whose upload date is unknown (GBIF, NAS). */
  noSubmittedDate: number;
};

export function countReports(reports: readonly Report[], q: ReportQuery): ReportCount {
  const shown = windowReports(reports, q);
  const independent = shown.filter((r) => !isCopy(r));
  const noSubmittedDate =
    q.basis === "submitted" ? windowReports(reports, { ...q, basis: "observed" }).filter((r) => !isCopy(r) && r.submittedMs === null).length : 0;
  return { independent: independent.length, copies: shown.length - independent.length, late: independent.filter(isLate).length, noSubmittedDate };
}

export type LagStats = { n: number; medianDays: number | null; lateCount: number };

/** Upload lag over the independent reports with an upload date. */
export function lagStats(reports: readonly Report[]): LagStats {
  const lags = reports
    .filter((r) => !isCopy(r) && r.submittedMs !== null)
    .map((r) => (r.submittedMs! - r.observedMs) / DAY)
    .sort((a, b) => a - b);
  const n = lags.length;
  const medianDays = n === 0 ? null : n % 2 ? lags[(n - 1) / 2]! : (lags[n / 2 - 1]! + lags[n / 2]!) / 2;
  return { n, medianDays, lateCount: lags.filter((d) => d * DAY > LATE_MS).length };
}

// ---- reef heat stress (NOAA Coral Reef Watch) -------------------------------------------------

/** A CRW product older than this at the cursor is stale (L5 heatStress rule). */
export const CRW_STALE_MS = 72 * HOUR;

export type HeatDay = { dayMs: number; sstC: number | null; anomaly: number | null; dhw: number | null; baa: number | null };
export type HeatPixel = { station: string; lat: number; lon: number; areaId: string | null; days: HeatDay[] };

export type GqlReading = { param: string; value: number | null; flag: string; observedAt: string; origin: string; station: { id: string; source: string; name: string; lat: number; lon: number; kind: string } };

const HEAT_PARAM: Record<string, keyof Omit<HeatDay, "dayMs">> = { SST: "sstC", SST_ANOMALY: "anomaly", DHW: "dhw", BAA: "baa" };

/** CRW readings grouped into pixels with one entry per product day, oldest first. A flagged value is null. */
export function groupHeat(readings: readonly GqlReading[], areas: readonly Area[]): HeatPixel[] {
  const pixels = new Map<string, HeatPixel>();
  const dayOf = new Map<string, HeatDay>();
  for (const r of readings) {
    const field = HEAT_PARAM[r.param];
    if (!field || r.station.source !== "crw") continue;
    let px = pixels.get(r.station.id);
    if (!px) {
      px = { station: r.station.id, lat: r.station.lat, lon: r.station.lon, areaId: areaOf(areas, r.station.lat, r.station.lon)?.id ?? null, days: [] };
      pixels.set(r.station.id, px);
    }
    const dayMs = Date.parse(r.observedAt);
    const k = `${r.station.id}@${dayMs}`;
    let day = dayOf.get(k);
    if (!day) {
      day = { dayMs, sstC: null, anomaly: null, dhw: null, baa: null };
      dayOf.set(k, day);
      px.days.push(day);
    }
    day[field] = r.flag === "OK" && typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
  }
  for (const px of pixels.values()) px.days.sort((a, b) => a.dayMs - b.dayMs);
  return [...pixels.values()];
}

export type HeatState = "ok" | "stale" | "missing";
export type HeatAt = { state: HeatState; day: HeatDay | null; ageMs: number | null };

/** The newest product day at or before `atMs`; stale past 72 h; missing when none, or when DHW and BAA are both unknown. */
export function heatAt(px: HeatPixel, atMs: number): HeatAt {
  let day: HeatDay | null = null;
  for (const d of px.days) if (d.dayMs <= atMs) day = d;
  if (!day) return { state: "missing", day: null, ageMs: null };
  const ageMs = atMs - day.dayMs;
  if (day.dhw === null && day.baa === null) return { state: "missing", day, ageMs };
  return { state: ageMs > CRW_STALE_MS ? "stale" : "ok", day, ageMs };
}

/** CRW alert levels; CoralTemp v3.1 adds Alert levels 3 to 5 (values 5 to 7) for DHW of 12, 16 and 20. */
export const BAA_WORDS = ["No stress", "Bleaching watch", "Bleaching warning", "Alert level 1", "Alert level 2", "Alert level 3", "Alert level 4", "Alert level 5"] as const;
export const baaWord = (baa: number | null) => (baa === null ? "unknown" : (BAA_WORDS[Math.max(0, Math.min(BAA_WORDS.length - 1, Math.round(baa)))] ?? "unknown"));

/** What the accumulated DHW alone would suggest, on the BAA scale: under 4 none, 4 to 8 alert level 1, 8+ level 2. */
export const dhwLevel = (dhw: number) => (dhw >= 8 ? 4 : dhw >= 4 ? 3 : 0);

/**
 * DHW (accumulated over 12 weeks) and BAA (today's alert, which also needs a current HotSpot) point different
 * ways: high accumulated stress with a low alert today (Florida after cooling), or a high alert on little
 * accumulation. Both are always shown; this flags the case that needs explaining.
 */
export function heatDisagrees(day: Pick<HeatDay, "dhw" | "baa"> | null): boolean {
  if (!day || day.dhw === null || day.baa === null) return false;
  const fromDhw = dhwLevel(day.dhw);
  return (fromDhw >= 3 && day.baa <= 1) || (day.baa >= 3 && fromDhw === 0);
}

export type AreaHeat = { areaId: string; pixels: number; ok: number; stale: number; missing: number; maxDhw: number | null; maxBaa: number | null; dayMs: number | null; disagree: boolean; anomaly: number | null };

/** Per area, at `atMs`: how many pixels are ok, stale or missing, the highest DHW and BAA, and whether they disagree. */
export function areaHeat(pixels: readonly HeatPixel[], areaId: string, atMs: number): AreaHeat {
  const out: AreaHeat = { areaId, pixels: 0, ok: 0, stale: 0, missing: 0, maxDhw: null, maxBaa: null, dayMs: null, disagree: false, anomaly: null };
  for (const px of pixels) {
    if (px.areaId !== areaId) continue;
    out.pixels += 1;
    const h = heatAt(px, atMs);
    out[h.state] += 1;
    if (h.state === "missing" || !h.day) continue;
    const d = h.day;
    if (d.dhw !== null) out.maxDhw = Math.max(out.maxDhw ?? -Infinity, d.dhw);
    if (d.baa !== null) out.maxBaa = Math.max(out.maxBaa ?? -Infinity, d.baa);
    if (d.anomaly !== null) out.anomaly = Math.max(out.anomaly ?? -Infinity, d.anomaly);
    out.dayMs = Math.max(out.dayMs ?? 0, d.dayMs);
    if (heatDisagrees(d)) out.disagree = true;
  }
  return out;
}

// ---- buoy versus satellite SST (Florida only) -------------------------------------------------

/** Buoy and satellite SST differing by this much or more are shown as a disagreement. */
export const SST_CONFLICT_C = 0.5;
const BUOY_MAX_AGE_MS = 3 * DAY;
const PAIR_MAX_KM = 60;

export type SstPair = {
  buoy: { station: string; name: string; valueC: number; observedMs: number; lat: number; lon: number };
  satellite: { station: string; valueC: number; dayMs: number; lat: number; lon: number };
  diffC: number;
  distanceKm: number;
  disagree: boolean;
};

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The closest buoy water temperature (NDBC, measured, newest within 3 days of `atMs`) and CRW satellite SST pixel
 * (within 60 km), or null when no pair exists. Never blended: both values stay with their sources.
 */
export function buoyVsSatellite(buoys: readonly GqlReading[], pixels: readonly HeatPixel[], atMs: number): SstPair | null {
  const latest = new Map<string, GqlReading>();
  for (const r of buoys) {
    if (r.station.source !== "ndbc" || r.flag !== "OK" || typeof r.value !== "number") continue;
    if (r.param !== "SST_C" && r.param !== "WATER_C") continue;
    const t = Date.parse(r.observedAt);
    if (t > atMs || atMs - t > BUOY_MAX_AGE_MS) continue;
    const prev = latest.get(r.station.id);
    if (!prev || Date.parse(prev.observedAt) < t) latest.set(r.station.id, r);
  }
  let best: SstPair | null = null;
  for (const b of latest.values()) {
    for (const px of pixels) {
      const h = heatAt(px, atMs);
      if (h.state === "missing" || !h.day || h.day.sstC === null) continue;
      const km = distanceKm(b.station, px);
      if (km > PAIR_MAX_KM || (best && km >= best.distanceKm)) continue;
      const diffC = (b.value as number) - h.day.sstC;
      best = {
        buoy: { station: b.station.id, name: b.station.name, valueC: b.value as number, observedMs: Date.parse(b.observedAt), lat: b.station.lat, lon: b.station.lon },
        satellite: { station: px.station, valueC: h.day.sstC, dayMs: h.day.dayMs, lat: px.lat, lon: px.lon },
        diffC,
        distanceKm: km,
        disagree: Math.abs(diffC) >= SST_CONFLICT_C,
      };
    }
  }
  return best;
}

// ---- field window (Open-Meteo Marine forecast) ------------------------------------------------

/** Waves under this are workable for a dive survey (the L5 FieldWindow threshold). */
export const CALM_WAVE_M = 1.2;

export type MarinePoint = { station: string; lat: number; lon: number; areaId: string | null; waveMaxM: number | null; calmHours: number; hours: number; currentMaxMs: number | null; fromMs: number; toMs: number };

/** Forecast hours from `fromMs` over `horizonH`, per marine point: highest wave, calm hours, strongest current. */
export function fieldPoints(readings: readonly GqlReading[], areas: readonly Area[], fromMs: number, horizonH = 72): MarinePoint[] {
  const toMs = fromMs + horizonH * HOUR;
  const out = new Map<string, MarinePoint>();
  for (const r of readings) {
    if (r.station.source !== "openmeteo-marine" || r.flag !== "OK" || typeof r.value !== "number") continue;
    const t = Date.parse(r.observedAt);
    if (t < fromMs || t > toMs) continue;
    let p = out.get(r.station.id);
    if (!p) {
      p = { station: r.station.id, lat: r.station.lat, lon: r.station.lon, areaId: areaOf(areas, r.station.lat, r.station.lon)?.id ?? null, waveMaxM: null, calmHours: 0, hours: 0, currentMaxMs: null, fromMs: t, toMs: t };
      out.set(r.station.id, p);
    }
    p.fromMs = Math.min(p.fromMs, t);
    p.toMs = Math.max(p.toMs, t);
    if (r.param === "WAVE_M") {
      p.hours += 1;
      if (r.value < CALM_WAVE_M) p.calmHours += 1;
      p.waveMaxM = Math.max(p.waveMaxM ?? -Infinity, r.value);
    } else if (r.param === "CURRENT_MS") {
      p.currentMaxMs = Math.max(p.currentMaxMs ?? -Infinity, r.value);
    }
  }
  return [...out.values()].filter((p) => p.hours > 0);
}

// ---- survey priority --------------------------------------------------------------------------

export type ComponentState = "OK" | "UNKNOWN" | "STALE";
export type ComponentValue = { value: number | null; state: ComponentState };
export type PriorityCell = {
  cell: string;
  lat: number;
  lon: number;
  regionId: string;
  rankScore: number | null;
  thin: boolean;
  components: Record<ComponentId, ComponentValue>;
};
export type PrioritySnapshot = { atMs: number; cells: PriorityCell[] };

/** The newest snapshot at or before `atMs` (what the priority looked like then), or null before the first. */
export function snapshotAt(snapshots: readonly PrioritySnapshot[], atMs: number): PrioritySnapshot | null {
  let best: PrioritySnapshot | null = null;
  for (const s of snapshots) if (s.atMs <= atMs && (!best || s.atMs > best.atMs)) best = s;
  return best;
}

/** Ranked places are at least this far apart (about 10 km): neighbouring 1 km cells share the same reports. */
export const PLACE_SEPARATION_DEG = 0.1;

/**
 * Ranked places of one area, best first: the best cell of each cluster, skipping any cell within
 * PLACE_SEPARATION_DEG of a better one (the top cells of a grid are mostly neighbours of the same reports). Thin
 * areas keep their places; they are labelled, not hidden.
 */
export function areaCells(snapshot: PrioritySnapshot | null, areaId: string, top = 5, separationDeg = PLACE_SEPARATION_DEG): PriorityCell[] {
  if (!snapshot) return [];
  const ranked = snapshot.cells.filter((c) => c.regionId === areaId).sort((a, b) => (b.rankScore ?? -1) - (a.rankScore ?? -1));
  const out: PriorityCell[] = [];
  for (const c of ranked) {
    if (out.length >= top) break;
    if (out.some((p) => Math.abs(p.lat - c.lat) < separationDeg && Math.abs(p.lon - c.lon) < separationDeg)) continue;
    out.push(c);
  }
  return out;
}

/** Evidence id of a priority cell at a time (C14 `hotspot:<species>:<region>:<col>:<row>:<ms>`). */
export function cellEvidenceId(species: string, cell: string, atMs: number): string {
  return `hotspot:${species}:${cell}:${atMs}`;
}

/** Parse a survey cell evidence id (`hotspot:<species>:<region>:<col>:<row>:<ms>`). */
export function parseCellEvidenceId(id: string | null | undefined): { species: string; cell: string; atMs: number } | null {
  const m = /^hotspot:([a-z][a-z0-9-]*):([a-z][a-z0-9-]*:\d+:\d+):(\d+)$/.exec(id ?? "");
  return m ? { species: m[1]!, cell: m[2]!, atMs: Number(m[3]) } : null;
}

// ---- words and numbers ------------------------------------------------------------------------

/**
 * A component value on its own 0..1 scale ("0.62"), or the state word when there is no value. Never a percent:
 * a rank input is not a probability.
 */
export function componentText(c: ComponentValue | null | undefined): string {
  if (!c || c.value === null || c.state !== "OK") return c?.state === "STALE" ? "stale" : "unknown";
  return c.value.toFixed(2);
}

export const STATE_WORD: Record<ComponentState, string> = { OK: "ok", UNKNOWN: "unknown", STALE: "stale" };

/** Feed chip: mode as the adapter runs (push, webhook, poll) and state in words. */
export type FeedRow = { source: string; mode: string; state: string; newestObservedAt: string | null; lastFetchAt: string | null; lagSeconds: number | null; note: string | null };
export const FEED_STATE_WORD: Record<string, string> = { NOMINAL: "on time", LAGGING: "lagging", STALE: "stale", DOWN: "down" };
export function feedChip(f: FeedRow): { source: string; mode: "push" | "webhook" | "poll"; state: string; tone: "ok" | "warn" | "stale" | "danger" } {
  const mode = f.mode === "PUSH" ? "push" : f.mode === "WEBHOOK" ? "webhook" : "poll";
  const tone = f.state === "NOMINAL" ? "ok" : f.state === "LAGGING" ? "warn" : f.state === "STALE" ? "stale" : "danger";
  return { source: f.source, mode, state: FEED_STATE_WORD[f.state] ?? f.state.toLowerCase(), tone };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-09-29" in UTC. */
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "2026-09-29 14:05Z". */
export const utcText = (ms: number) => {
  const d = new Date(ms);
  return `${isoDay(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
};
/** "3 h", "4 d". */
export function ageText(ms: number): string {
  const h = ms / HOUR;
  if (h < 1) return `${Math.max(0, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}
