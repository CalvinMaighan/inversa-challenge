/**
 * Water and weather overlays (docs/GODS_EYE.md GC5): the catalogue the globe, the Layers popover and the e2e
 * scripts share. Pure: times are numbers, URLs are strings, nothing here touches a runtime.
 *
 * Every overlay is a time series with its own cadence. The timeline moves in 15-minute frames; an overlay snaps
 * the cursor to the nearest instant its source publishes (`snapOverlayTime`), clamps it to what the source still
 * has, and reports the instant it shows so the legend can say "radar at 19:36 UTC" instead of pretending the
 * image is the cursor's. Cadences, ranges and layer names were read from each source's capabilities document on
 * 2026-10-01 (cited in docs/overlays.md):
 *
 * - NASA GIBS WMTS `GHRSST_L4_MUR_Sea_Surface_Temperature`: daily, latest date the day before (a request for
 *   today answers 404), back to 2002.
 * - NOAA nowCOAST WMS `conus_base_reflectivity_mosaic`: about every 4 minutes, roughly the last 7.5 hours.
 * - NOAA nowCOAST WMS `goes_longwave_imagery`: every 5 minutes, roughly the last 7.6 hours.
 * - NOAA nowCOAST WMS `ldn_lightning_strike_density`: every 15 minutes, roughly the last 5 hours.
 * - NHC `CurrentStorms.json` plus the NWS tropical weather summary MapServer: advisories every 6 hours (3 when a
 *   storm threatens land); the forecast points carry their valid times, the past track its fixes.
 */
import type { AppId, BBox } from "./apps/schema";

export const OVERLAY_IDS = ["sst-map", "radar", "clouds", "lightning", "cyclones"] as const;
export type OverlayId = (typeof OVERLAY_IDS)[number];
export const [SST_MAP, RADAR, CLOUDS, LIGHTNING, CYCLONES] = OVERLAY_IDS;

export function isOverlayId(value: unknown): value is OverlayId {
  return typeof value === "string" && (OVERLAY_IDS as readonly string[]).includes(value);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Opacity of a freshly enabled overlay; the slider in the Layers popover changes it for all of them. */
export const DEFAULT_OVERLAY_OPACITY = 0.75;

export type OverlayLegend =
  | { kind: "ramp"; /** CSS colour stops, low to high, as the source draws them. */ stops: readonly string[]; min: string; max: string; unit: string }
  | { kind: "swatches"; items: readonly { label: string; color: string }[] };

export type OverlaySpec = {
  id: OverlayId;
  /** Row label. */
  label: string;
  /** One plain line for a novice: what the picture shows. */
  blurb: string;
  /** How often the source publishes a new picture. */
  cadenceMs: number;
  /** How far behind the wall clock the newest picture usually is. */
  latencyMs: number;
  /** How far back the source still serves pictures. */
  historyMs: number;
  /** Raster: deepest Web Mercator zoom the proxy serves; null for a vector layer. */
  maxZoom: number | null;
  /** Where the source has data, degrees; tiles outside are never requested. */
  bbox: BBox;
  /** Apps that list the layer ("all" for the weather layers; SST maps only make sense around water). */
  apps: readonly AppId[] | "all";
  /** Attribution, as the provider asks for it (the Layers popover, docs/overlays.md). */
  attribution: string;
  /** The short form on the globe's credit line, where a sentence would wrap. */
  credit: string;
  /** The provider's page, opened in a new tab. */
  sourceUrl: string;
  legend: OverlayLegend;
};

/** °C → °F, one decimal. */
export function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/** "26 °C / 79 °F". */
export function tempLabel(c: number): string {
  return `${c} °C / ${celsiusToFahrenheit(c)} °F`;
}

/** NOAA's base reflectivity palette, dBZ, as the `weather_radar_base_reflectivity` style draws it (light to heavy). */
export const RADAR_STOPS = ["#04e9e7", "#019ff4", "#0300f4", "#02fd02", "#01c501", "#008e00", "#fdf802", "#e5bc00", "#fd9500", "#fd0000", "#d40000", "#bc0000", "#f800fd", "#9854c6"] as const;
/** MUR SST, GIBS default style: 0 °C deep blue to 32 °C dark red. */
export const SST_STOPS = ["#2c0b7a", "#1f3fb5", "#1f8fd6", "#44c7a9", "#a6e061", "#fcd934", "#f58b24", "#d7301f", "#7f0000"] as const;
export const SST_RANGE_C = { min: 0, max: 32 } as const;

export const OVERLAYS: readonly OverlaySpec[] = [
  {
    id: SST_MAP,
    label: "Sea surface temperature map",
    blurb: "How warm the sea was, satellite picture, one per day.",
    cadenceMs: DAY,
    latencyMs: 36 * HOUR,
    historyMs: 365 * DAY,
    maxZoom: 7,
    bbox: { west: -180, south: -85, east: 180, north: 85 },
    apps: ["carp", "lionfish"],
    attribution: "NASA GIBS, GHRSST MUR sea surface temperature (NASA ESDIS)",
    credit: "NASA GIBS (MUR SST)",
    sourceUrl: "https://gibs.earthdata.nasa.gov/",
    legend: { kind: "ramp", stops: SST_STOPS, min: tempLabel(SST_RANGE_C.min), max: tempLabel(SST_RANGE_C.max), unit: "°C / °F" },
  },
  {
    id: RADAR,
    label: "Rain radar",
    blurb: "Where it is raining now, from weather radar. Brighter is heavier.",
    cadenceMs: 4 * MINUTE,
    latencyMs: 6 * MINUTE,
    historyMs: 7 * HOUR,
    maxZoom: 10,
    bbox: { west: -130, south: 20, east: -60, north: 55 },
    apps: "all",
    attribution: "NOAA nowCOAST, NWS/OAR MRMS radar",
    credit: "NOAA nowCOAST (MRMS radar)",
    sourceUrl: "https://nowcoast.noaa.gov/",
    legend: { kind: "ramp", stops: RADAR_STOPS, min: "light", max: "heavy", unit: "dBZ, radar echo strength" },
  },
  {
    id: CLOUDS,
    label: "Clouds",
    blurb: "Cloud cover from the GOES weather satellite, every few minutes. Bright is cold, high cloud.",
    cadenceMs: 5 * MINUTE,
    latencyMs: 8 * MINUTE,
    historyMs: 7 * HOUR,
    maxZoom: 10,
    bbox: { west: -179.5, south: 10.9, east: -50.7, north: 50.6 },
    apps: "all",
    attribution: "NOAA nowCOAST, NESDIS GOES-19/18 longwave infrared",
    credit: "NOAA nowCOAST (GOES clouds)",
    sourceUrl: "https://nowcoast.noaa.gov/",
    legend: { kind: "swatches", items: [{ label: "Clear or warm, low cloud", color: "#3a3a3a" }, { label: "Cold, high cloud (storm tops)", color: "#f4f4f4" }] },
  },
  {
    id: LIGHTNING,
    label: "Lightning",
    blurb: "Where lightning struck in the last 15 minutes. Red is the most strikes.",
    cadenceMs: 15 * MINUTE,
    latencyMs: 20 * MINUTE,
    historyMs: 5 * HOUR,
    maxZoom: 10,
    bbox: { west: -180, south: -25, east: 180, north: 80 },
    apps: "all",
    attribution: "NOAA/NWS nowCOAST lightning density, derived from Vaisala NLDN/GLD360",
    credit: "NOAA nowCOAST (lightning, Vaisala)",
    sourceUrl: "https://nowcoast.noaa.gov/",
    legend: { kind: "ramp", stops: ["#ffff80", "#ffb000", "#ff4000", "#c00000"], min: "few", max: "many", unit: "strikes per km² in 15 min" },
  },
  {
    id: CYCLONES,
    label: "Hurricanes and tropical storms",
    blurb: "Active storms, where they have been, where they are headed and how sure the forecast is (the cone).",
    cadenceMs: 6 * HOUR,
    latencyMs: 0,
    historyMs: 30 * DAY,
    maxZoom: null,
    bbox: { west: -180, south: -10, east: 10, north: 70 },
    apps: "all",
    attribution: "NOAA/NWS National Hurricane Center and Central Pacific Hurricane Center",
    credit: "NOAA/NWS NHC and CPHC",
    sourceUrl: "https://www.nhc.noaa.gov/",
    legend: {
      kind: "swatches",
      items: [
        { label: "Hurricane", color: "#ff3b30" },
        { label: "Tropical storm", color: "#ff9f0a" },
        { label: "Depression or low", color: "#ffd60a" },
        { label: "Forecast cone (where the centre may go)", color: "#ffffff" },
      ],
    },
  },
];

export function overlaySpec(id: OverlayId): OverlaySpec {
  return OVERLAYS.find((o) => o.id === id)!;
}

/** The overlays an app may list (the config's `layers[]` decides what it does list). */
export function overlaysForApp(app: AppId): OverlaySpec[] {
  return OVERLAYS.filter((o) => o.apps === "all" || o.apps.includes(app));
}

export type SnappedTime = {
  /** The instant the layer shows, unix ms. */
  shownMs: number;
  /** Set when the cursor fell outside what the source has and the shown time is its edge. */
  clamped: "latest" | "earliest" | null;
};

/** Newest instant the source has published by `nowMs`, on its cadence grid. */
export function latestAvailable(spec: Pick<OverlaySpec, "cadenceMs" | "latencyMs">, nowMs: number): number {
  return Math.floor((nowMs - spec.latencyMs) / spec.cadenceMs) * spec.cadenceMs;
}

/**
 * The instant of `spec`'s series nearest the timeline cursor, clamped to what the source still serves.
 * Daily series (SST) snap to the UTC day; the others round to the nearest cadence step.
 */
export function snapOverlayTime(spec: Pick<OverlaySpec, "cadenceMs" | "latencyMs" | "historyMs">, timeMs: number, nowMs: number): SnappedTime {
  const latest = latestAvailable(spec, nowMs);
  const earliest = latest - Math.floor(spec.historyMs / spec.cadenceMs) * spec.cadenceMs;
  const snapped = spec.cadenceMs >= DAY ? Math.floor(timeMs / spec.cadenceMs) * spec.cadenceMs : Math.round(timeMs / spec.cadenceMs) * spec.cadenceMs;
  if (snapped > latest) return { shownMs: latest, clamped: "latest" };
  if (snapped < earliest) return { shownMs: earliest, clamped: "earliest" };
  return { shownMs: snapped, clamped: null };
}

/** `2026-10-01T19:36:00Z` (seconds, no millis: the proxy keys its cache by the minute). */
export function overlayTimeParam(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Tile URL template for Cesium (`{z}/{x}/{y}` left for the provider), same origin through the Axum proxy. */
export function overlayTileTemplate(app: AppId, id: OverlayId, shownMs: number): string {
  return `/v1/${app}/overlay/${id}/{z}/{x}/{y}?time=${encodeURIComponent(overlayTimeParam(shownMs))}`;
}

/** A concrete tile URL, for probes and tests. */
export function overlayTileUrl(app: AppId, id: OverlayId, z: number, x: number, y: number, shownMs: number): string {
  return overlayTileTemplate(app, id, shownMs).replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

export function cyclonesUrl(app: AppId): string {
  return `/v1/${app}/overlay/cyclones`;
}

/** What the legend says under a time-following overlay: the shown instant and whether it is an edge. */
export function shownTimeLine(spec: Pick<OverlaySpec, "cadenceMs">, snapped: SnappedTime): string {
  const d = new Date(snapped.shownMs);
  const when = spec.cadenceMs >= DAY ? d.toISOString().slice(0, 10) : `${d.toISOString().slice(11, 16)} UTC, ${d.toISOString().slice(0, 10)}`;
  const edge = snapped.clamped === "latest" ? " (newest available)" : snapped.clamped === "earliest" ? " (oldest kept by the source)" : "";
  return `Showing ${when}${edge}`;
}

// ---- cyclones ---------------------------------------------------------------------------------------------

/** One storm as the globe draws it, from `CurrentStorms.json` plus the summary MapServer features. */
export type Cyclone = {
  /** NHC storm id, e.g. `ep182026`. */
  id: string;
  name: string;
  /** NHC classification code: HU, TS, TD, STS, STD, PTC, PC, LO, DB... */
  classification: string;
  /** Knots. */
  intensityKt: number | null;
  pressureMb: number | null;
  lat: number;
  lon: number;
  /** Degrees and knots, as reported. */
  movementDir: number | null;
  movementKt: number | null;
  /** Position time, unix ms. */
  lastUpdateMs: number;
  advisory: { number: string; issuedMs: number | null; url: string | null };
  /** Forecast positions, in time order: tau hours after the advisory, with the valid time when it can be derived. */
  forecast: { lon: number; lat: number; tauH: number; validMs: number | null; maxWindKt: number | null; label: string | null }[];
  /** Forecast track line, lon/lat pairs. */
  track: [number, number][];
  /** Forecast cone polygons (outer rings), lon/lat pairs. */
  cone: [number, number][][];
  /** Past track fixes, oldest first, lon/lat pairs; from the past-track lines. */
  past: [number, number][];
};

export type CyclonesDoc = {
  fetchedAt: string;
  current: unknown;
  features: unknown;
};

type Feature = { type?: string; geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const pair = (c: unknown): [number, number] | null => (Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[0] as number, c[1] as number] : null);
const line = (c: unknown): [number, number][] => (Array.isArray(c) ? c.map(pair).filter((p): p is [number, number] => p !== null) : []);

function features(doc: unknown): Feature[] {
  const list = (doc as { features?: unknown } | null)?.features;
  return Array.isArray(list) ? (list as Feature[]) : [];
}

/** Hurricane, tropical storm or depression bucket of an NHC classification code (the legend's three colours). */
export function cycloneBucket(classification: string): "hurricane" | "storm" | "depression" {
  const c = classification.toUpperCase();
  if (c === "HU" || c === "MH" || c === "TY" || c === "ST") return "hurricane";
  if (c === "TS" || c === "STS" || c === "SS") return "storm";
  return "depression";
}

/** Plain words for a classification code. */
export function cycloneKind(classification: string): string {
  switch (classification.toUpperCase()) {
    case "HU":
      return "Hurricane";
    case "MH":
      return "Major hurricane";
    case "TS":
      return "Tropical storm";
    case "TD":
      return "Tropical depression";
    case "STS":
      return "Subtropical storm";
    case "STD":
      return "Subtropical depression";
    case "PTC":
      return "Potential tropical cyclone";
    case "PC":
      return "Post-tropical cyclone";
    default:
      return "Tropical system";
  }
}

/**
 * Storms of a proxy document (`/v1/<app>/overlay/cyclones`): positions from `current.activeStorms`, geometry
 * matched by NHC bin number (`EP3`) across the summary layers. A storm with no geometry still has a position.
 */
export function parseCyclones(doc: CyclonesDoc): Cyclone[] {
  const active = (doc.current as { activeStorms?: unknown } | null)?.activeStorms;
  if (!Array.isArray(active)) return [];
  const feats = features(doc.features);
  const byBin = (layer: string, bin: string) => feats.filter((f) => f.properties?.layer === layer && String(f.properties?.binnumber ?? "").toUpperCase() === bin);
  const out: Cyclone[] = [];
  for (const raw of active as Record<string, unknown>[]) {
    const id = str(raw.id);
    const lat = num(raw.latitudeNumeric);
    const lon = num(raw.longitudeNumeric);
    const lastUpdateMs = Date.parse(String(raw.lastUpdate ?? ""));
    if (!id || lat === null || lon === null || !Number.isFinite(lastUpdateMs)) continue;
    const bin = String(raw.binNumber ?? "").toUpperCase();
    const adv = (raw.publicAdvisory ?? raw.forecastAdvisory ?? {}) as Record<string, unknown>;
    const issuedMs = Date.parse(String(adv.issuance ?? ""));
    const forecast = byBin("points", bin)
      .map((f) => {
        const p = pair(f.geometry?.coordinates);
        const props = f.properties ?? {};
        const tauH = num(props.tau) ?? 0;
        if (!p) return null;
        return { lon: p[0], lat: p[1], tauH, validMs: Number.isFinite(issuedMs) ? issuedMs + tauH * HOUR : null, maxWindKt: num(props.maxwind), label: str(props.datelbl) };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => a.tauH - b.tauH);
    const track = byBin("track", bin).flatMap((f) => (f.geometry?.type === "MultiLineString" ? (f.geometry.coordinates as unknown[]).flatMap(line) : line(f.geometry?.coordinates)));
    const cone = byBin("cone", bin).flatMap((f) => {
      const g = f.geometry;
      if (g?.type === "Polygon") return [line((g.coordinates as unknown[])[0])];
      if (g?.type === "MultiPolygon") return (g.coordinates as unknown[][]).map((poly) => line(poly[0]));
      return [];
    });
    // Past track segments (one per intensity bucket) in order; de-duplicate the shared joints.
    const past: [number, number][] = [];
    for (const f of byBin("past", bin)) {
      const pts = f.geometry?.type === "MultiLineString" ? (f.geometry.coordinates as unknown[]).flatMap(line) : line(f.geometry?.coordinates);
      for (const p of pts) {
        const last = past[past.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) past.push(p);
      }
    }
    out.push({
      id,
      name: str(raw.name) ?? id.toUpperCase(),
      classification: str(raw.classification) ?? "LO",
      intensityKt: num(raw.intensity),
      pressureMb: num(raw.pressure),
      lat,
      lon,
      movementDir: num(raw.movementDir),
      movementKt: num(raw.movementSpeed),
      lastUpdateMs,
      advisory: { number: str(adv.advNum) ?? "", issuedMs: Number.isFinite(issuedMs) ? issuedMs : null, url: str(adv.url) },
      forecast,
      track,
      cone,
      past,
    });
  }
  return out;
}

/**
 * Where a storm's centre was or is forecast to be at `atMs`: linear between the past fixes (assumed evenly
 * spaced in time up to the current position) and the forecast points (valid times known). Before the first
 * fix or after the last forecast point the nearest end holds. Null for a storm with no position at all.
 */
export function cyclonePositionAt(storm: Cyclone, atMs: number): { lon: number; lat: number; phase: "past" | "now" | "forecast" } {
  const forecast = storm.forecast.filter((p) => p.validMs !== null) as { lon: number; lat: number; validMs: number }[];
  if (atMs >= storm.lastUpdateMs) {
    if (forecast.length === 0) return { lon: storm.lon, lat: storm.lat, phase: "now" };
    const points = [{ lon: storm.lon, lat: storm.lat, validMs: storm.lastUpdateMs }, ...forecast];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (atMs <= b.validMs) {
        const t = b.validMs === a.validMs ? 1 : (atMs - a.validMs) / (b.validMs - a.validMs);
        return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, phase: atMs === storm.lastUpdateMs ? "now" : "forecast" };
      }
    }
    const last = points[points.length - 1]!;
    return { lon: last.lon, lat: last.lat, phase: "forecast" };
  }
  // Past fixes are 6-hourly best-track positions (NHC), the last one the current position.
  const fixes = [...storm.past, [storm.lon, storm.lat] as [number, number]];
  const step = 6 * HOUR;
  const idx = (fixes.length - 1) + (atMs - storm.lastUpdateMs) / step;
  if (idx <= 0) return { lon: fixes[0]![0], lat: fixes[0]![1], phase: "past" };
  const i = Math.floor(idx);
  const t = idx - i;
  const a = fixes[i]!;
  const b = fixes[Math.min(i + 1, fixes.length - 1)]!;
  return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, phase: "past" };
}
