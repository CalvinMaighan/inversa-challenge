/**
 * Agent capability tools. Each data tool makes exactly one POST to Axum
 * `/v1/graphql`: its query plus `feeds` in the same document, so every
 * result carries the C3 envelopes for the sources it depends on.
 * `geocode` uses the local gazetteer then Open-Meteo; `set_view` only emits.
 */

import { z } from "zod";

import { REGION_BBOX } from "@/server/agent/config";
import { CapabilityRegistry, type CapabilityContext, type CapabilityOutput, type Evidence } from "@/server/agent/runtime/registry";
import {
  cellCenter,
  cellFor,
  evidence,
  hotspotKey,
  readingKey,
  SPECIES_KEYS,
  speciesByKey,
} from "@/server/agent/tools/evidence";
import { lookupGazetteer, openMeteoGeocode } from "@/server/agent/tools/gazetteer";
import { gqlWithFeeds, toFeedState, type GqlFeedState } from "@/server/agent/tools/gql";
import {
  alertsView,
  backtestView,
  cellsView,
  conditionsViews,
  explainView,
  feedsView,
  sightingsView,
  withView,
  type ReadingRow,
  type SightingRow,
} from "@/server/agent/tools/views";
import type { BBox } from "@/shared/agent/events";
import { worstHealth, type FeedState } from "@/shared/feed-state";
import { QUALITY_CODES } from "@/shared/frames";
import { LAYER_IDS } from "@/shared/voice/ui-tools";

const HOUR_MS = 3_600_000;
/** Frames cover a 30-day window (PLAN.md C15). */
const MAX_LOOKBACK_HOURS = 24 * 30;
const MAX_MODEL_ROWS = 40;
/** Default sightings lookback; with no window given and nothing in it, the tool widens to MAX_LOOKBACK_HOURS. */
const DEFAULT_SIGHTING_HOURS = 24 * 7;
/**
 * Conditions query this much around the asked-for box. Rows inside the box win; when no station lies inside it
 * ("water levels near Homestead", with the nearest gauge a few km out), the nearby stations answer instead.
 */
export const NEARBY_DEG = 0.25;

// ---------------------------------------------------------------- schemas

const bboxSchema = z
  .object({
    west: z.number().min(-180).max(180),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
  })
  .refine((b) => b.west < b.east && b.south < b.north, "bbox needs west < east and south < north")
  .describe("Area in degrees. Get one from geocode. Defaults to the user's current view.");

const timeSchema = z
  .string()
  // Models often send "" for an optional time they mean to leave out; treat it as not given.
  .refine((value) => value === "" || Number.isFinite(Date.parse(value)), "must be an ISO 8601 time")
  .describe("ISO 8601 time, e.g. 2026-01-15T03:00:00Z");

const speciesSchema = z.enum(SPECIES_KEYS).describe("python | tegu | iguana | lionfish");

const QUALITY = QUALITY_CODES;

type LayerId = (typeof LAYER_IDS)[number];
/** Tools that fill a globe layer are named after it, so a tool row can highlight that layer. */
const LAYER = Object.fromEntries(LAYER_IDS.map((id) => [id, id])) as { readonly [K in LayerId]: K };
const PARAMS = ["lst_c", "air_c", "water_c", "sst_c", "rain_mm", "stage_m", "wave_m", "wind_ms", "fire_frp"] as const;
type Param = (typeof PARAMS)[number];

// ---------------------------------------------------------------- helpers

function resolveBbox(input: BBox | undefined, ctx: CapabilityContext): BBox {
  const bbox = input ?? ctx.view?.bbox ?? REGION_BBOX;
  const clamped = {
    west: Math.max(bbox.west, REGION_BBOX.west),
    south: Math.max(bbox.south, REGION_BBOX.south),
    east: Math.min(bbox.east, REGION_BBOX.east),
    north: Math.min(bbox.north, REGION_BBOX.north),
  };
  if (clamped.west >= clamped.east || clamped.south >= clamped.north) {
    throw new Error("bbox is outside the operating region (South Florida, 24.3–27.5°N, 83.2–79.8°W)");
  }
  return clamped;
}

function resolveWindow(
  input: { from?: string; to?: string; hours?: number },
  ctx: CapabilityContext,
  defaultHours: number,
): { from: string; to: string } {
  const to = input.to ? new Date(input.to) : ctx.now;
  const hours = Math.min(input.hours ?? defaultHours, MAX_LOOKBACK_HOURS);
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - hours * HOUR_MS);
  if (from.getTime() >= to.getTime()) throw new Error("time window is empty: from must be before to");
  return { from: from.toISOString(), to: to.toISOString() };
}

const inBox = (bbox: BBox, lat: number, lon: number) =>
  lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;

/** `bbox` grown by `deg` on every side, clamped to the operating region. */
function padBbox(bbox: BBox, deg: number): BBox {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    west: r(Math.max(REGION_BBOX.west, bbox.west - deg)),
    south: r(Math.max(REGION_BBOX.south, bbox.south - deg)),
    east: r(Math.min(REGION_BBOX.east, bbox.east + deg)),
    north: r(Math.min(REGION_BBOX.north, bbox.north + deg)),
  };
}

function atTime(input: string | undefined, ctx: CapabilityContext): string {
  return (input ? new Date(input) : ctx.now).toISOString();
}

/** Feeds this result depends on: the sources seen in rows, else the tool's defaults. */
function feedsFor(all: GqlFeedState[], seen: Iterable<string>, fallback: readonly string[] | "all"): GqlFeedState[] {
  if (fallback === "all") return all;
  const wanted = new Set(seen);
  return all.filter(
    (feed) => wanted.has(feed.source) || (wanted.size === 0 && fallback.some((prefix) => feed.source.startsWith(prefix))),
  );
}

/** A feed's last fetch run, citable as `fetch:<id>` when the API reports it. */
function fetchEvidence(feed: GqlFeedState): Evidence | null {
  if (!feed.lastFetchRunId) return null;
  const state = toFeedState(feed);
  return evidence("fetch", feed.lastFetchRunId, `${feed.source} ${state.state} · last fetch ${feed.lastFetchAt ?? "never"}`);
}

/** The analyst reads this summary before any claim about freshness. */
function feedSummary(feeds: FeedState[]) {
  const pick = (state: FeedState["state"]) => feeds.filter((feed) => feed.state === state).map((feed) => feed.source);
  return {
    worst: feeds.length > 0 ? worstHealth(feeds) : "unknown",
    lagging: pick("lagging"),
    stale: pick("stale"),
    down: pick("down"),
  };
}

function output(
  data: Record<string, unknown>,
  evidenceRows: Evidence[],
  rawFeeds: GqlFeedState[],
  count: number,
): CapabilityOutput {
  const feeds = rawFeeds.map(toFeedState);
  const fetches = rawFeeds.map(fetchEvidence);
  const allEvidence = [...evidenceRows, ...fetches.filter((row): row is Evidence => row !== null)];
  const modelFeeds = feeds.map((feed, index) => ({ ...feed, evidenceId: fetches[index]?.id ?? null }));
  return {
    // Data-quality first, bulky rows last: if a long result is ever pruned head/tail, the caveats survive.
    data: { feedSummary: feedSummary(feeds), feeds: modelFeeds, ...data, evidence: allEvidence },
    evidence: allEvidence,
    feeds,
    count,
  };
}

const lower = (value: string) => value.toLowerCase();

// ---------------------------------------------------------------- geocode

const geocode = {
  name: "geocode",
  description:
    "Resolve a South Florida place name (park units, sloughs, reefs, Keys towns, marinas) to a point, a bbox and its grid cell. Call before any area query.",
  inputSchema: z.object({ place: z.string().min(2).max(120).describe("Place name, e.g. 'Flamingo' or 'Key Largo'") }),
  async execute(input: { place: string }, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const place = lookupGazetteer(input.place) ?? (await openMeteoGeocode(input.place, ctx.signal));
    if (!place) throw new Error(`No place named "${input.place}" inside the operating region`);
    return output({ ...place, cell: cellFor(place.lat, place.lon) }, [], [], 1);
  },
};

// ---------------------------------------------------------------- sightings

const SIGHTINGS_QUERY = `query AgentSightings($bbox: BBox!, $from: Time!, $to: Time!, $taxa: [ID!], $quality: [Quality!]) {
  sightings(bbox: $bbox, from: $from, to: $to, taxa: $taxa, quality: $quality) {
    id source extId taxon { id scientificName commonName } lat lon accuracyM observedAt quality canonicalId conflict
  }
  feeds { ...FeedFields }
}
`;

type GqlSighting = {
  id: string;
  source: string;
  extId: string;
  taxon: { id: string; scientificName: string; commonName: string };
  lat: number;
  lon: number;
  accuracyM: number | null;
  observedAt: string;
  quality: string;
  canonicalId: string | null;
  conflict: boolean;
};

/** Research grade first, then curated records, then unconfirmed. */
const QUALITY_RANK: Record<string, number> = { research: 0, curated: 1, needs_id: 2, casual: 3 };

const sightingsInput = z.object({
  bbox: bboxSchema.optional(),
  species: z.array(speciesSchema).optional().describe("Limit to these species. Omit for all four."),
  quality: z.array(z.enum(QUALITY)).optional().describe("Limit to these quality grades."),
  from: timeSchema.optional(),
  to: timeSchema.optional(),
  hours: z.number().min(1).max(MAX_LOOKBACK_HOURS).optional().describe("Lookback from `to` (default 168 = 7 days)."),
});

const sightings = {
  name: LAYER.sightings,
  description:
    "Invasive species sightings (iNaturalist, USGS NAS, GBIF) in an area and time window. Rows carry quality grade, duplicate links (duplicateOf) and ID-conflict flags. Default window: the last 7 days. A window ending now that comes back empty is widened to the last 30 days (the result says so). The user sees every row in a table panel.",
  inputSchema: sightingsInput,
  async execute(input: z.infer<typeof sightingsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const bbox = resolveBbox(input.bbox, ctx);
    const explicit = Boolean(input.from) || Boolean(input.to) || input.hours !== undefined;
    const asked = resolveWindow(input, ctx, DEFAULT_SIGHTING_HOURS);
    // The same call fetches the whole 30 days before `to`. A "recent" window (none given, or one ending now) that
    // comes back empty widens to them; an empty historical window tells the model how many older records exist.
    const endsNow = Math.abs(Date.parse(asked.to) - ctx.now.getTime()) <= HOUR_MS;
    const fetched = {
      from: new Date(Math.min(Date.parse(asked.from), Date.parse(asked.to) - MAX_LOOKBACK_HOURS * HOUR_MS)).toISOString(),
      to: asked.to,
    };
    const data = await gqlWithFeeds<{ sightings: GqlSighting[]; feeds: GqlFeedState[] }>(
      "AgentSightings",
      SIGHTINGS_QUERY,
      {
        bbox,
        ...fetched,
        taxa: input.species?.map((key) => speciesByKey(key).taxonId) ?? null,
        quality: input.quality?.map((quality) => quality.toUpperCase()) ?? null,
      },
      ctx.signal,
    );
    const recent = data.sightings.filter((row) => Date.parse(row.observedAt) >= Date.parse(asked.from));
    const widened = (!explicit || endsNow) && recent.length === 0 && data.sightings.length > 0;
    const window = widened ? fetched : asked;
    const rows = [...(widened ? data.sightings : recent)].sort(
      (a, b) =>
        (QUALITY_RANK[lower(a.quality)] ?? 9) - (QUALITY_RANK[lower(b.quality)] ?? 9) ||
        Date.parse(b.observedAt) - Date.parse(a.observedAt),
    );
    const shown = rows.slice(0, MAX_MODEL_ROWS);
    const byQuality: Record<string, number> = {};
    const bySpecies: Record<string, number> = {};
    for (const row of rows) {
      byQuality[lower(row.quality)] = (byQuality[lower(row.quality)] ?? 0) + 1;
      bySpecies[row.taxon.commonName] = (bySpecies[row.taxon.commonName] ?? 0) + 1;
    }
    const duplicates = rows.filter((row) => row.canonicalId);
    const evidenceRows = shown.map((row) =>
      evidence(
        "sighting",
        row.id,
        `${row.taxon.commonName} · ${lower(row.quality)} · ${row.source} · ${row.observedAt}`,
      ),
    );
    const feeds = feedsFor(data.feeds, new Set(rows.map((row) => row.source)), ["inat", "nas", "gbif"]);
    const viewRows: SightingRow[] = rows.map((row) => ({
      evidenceId: `sighting:${row.id}`,
      species: row.taxon.commonName,
      source: row.source,
      quality: lower(row.quality),
      observedAt: row.observedAt,
      lat: row.lat,
      lon: row.lon,
      duplicateOf: row.canonicalId ? `sighting:${row.canonicalId}` : null,
      idConflict: row.conflict,
    }));
    const species = input.species?.map((key) => speciesByKey(key).common.toLowerCase()).join(", ") ?? "invasive";
    const days = Math.max(1, Math.round((Date.parse(window.to) - Date.parse(window.from)) / (24 * HOUR_MS)));
    const span = endsNow ? `last ${days} ${days === 1 ? "day" : "days"}` : `${window.from.slice(5, 10)} to ${window.to.slice(5, 10)}`;
    const title = `${species} sightings · ${span}`;
    const view = sightingsView(viewRows, bbox, title.charAt(0).toUpperCase() + title.slice(1));
    const older = !widened && recent.length === 0 ? data.sightings.length : 0;
    const askedDays = Math.max(1, Math.round((Date.parse(asked.to) - Date.parse(asked.from)) / (24 * HOUR_MS)));
    const out = output(
      {
        bbox,
        window,
        ...(widened
          ? { widened: `Nothing in the ${askedDays} days asked for; the window was widened to the last 30 days. Say so.` }
          : {}),
        ...(older > 0
          ? { olderInLast30Days: older, hint: `Nothing in this window, but ${older} older in the 30 days before it: call again with hours: 720 to show them.` }
          : {}),
        total: rows.length,
        distinctAnimals: rows.length - duplicates.length,
        duplicates: duplicates.length,
        conflicts: rows.filter((row) => row.conflict).length,
        byQuality,
        bySpecies,
        truncated: rows.length > shown.length,
        rows: shown.map((row, index) => ({
          evidenceId: evidenceRows[index]!.id,
          species: row.taxon.commonName,
          source: row.source,
          quality: lower(row.quality),
          observedAt: row.observedAt,
          lat: row.lat,
          lon: row.lon,
          accuracyM: row.accuracyM,
          duplicateOf: row.canonicalId ? `sighting:${row.canonicalId}` : null,
          idConflict: row.conflict,
        })),
      },
      evidenceRows,
      feeds,
      rows.length,
    );
    return withView(out, view);
  },
};

// ---------------------------------------------------------------- conditions

const READINGS_QUERY = `query AgentReadings($bbox: BBox!, $from: Time!, $to: Time!, $params: [Param!]) {
  readings(bbox: $bbox, from: $from, to: $to, params: $params) {
    station { id source name lat lon kind } param value flag observedAt origin
  }
  feeds { ...FeedFields }
}
`;

type GqlReading = {
  station: { id: string; source: string; name: string; lat: number; lon: number; kind: string };
  param: string;
  value: number | null;
  flag: string;
  observedAt: string;
  origin: string;
};

/** In-situ beats satellite beats model (PRD §7 "Conflicting"). */
const ORIGIN_RANK: Record<string, number> = { measured: 0, satellite: 1, modeled: 2 };

/** Cross-origin disagreement worth naming, per parameter. */
const CONFLICT_THRESHOLD: Partial<Record<Param, number>> = {
  sst_c: 1.5,
  water_c: 1.5,
  air_c: 3,
  wave_m: 0.5,
  wind_ms: 3,
  stage_m: 0.15,
};

/** Water temperature from buoys (water_c) and satellites (sst_c) is one comparison. */
const COMPARE_AS: Partial<Record<Param, Param>> = { water_c: "sst_c" };

const PARAM_SOURCES: Record<Param, string[]> = {
  lst_c: ["goes"],
  sst_c: ["goes", "ndbc"],
  fire_frp: ["goes"],
  water_c: ["ndbc", "usgs", "coops"],
  air_c: ["nws", "openmeteo", "ndbc"],
  rain_mm: ["openmeteo", "nws"],
  stage_m: ["usgs", "coops"],
  wave_m: ["ndbc", "openmeteo"],
  wind_ms: ["ndbc", "openmeteo", "nws"],
};

const conditionsInput = z.object({
  bbox: bboxSchema.optional(),
  params: z
    .array(z.enum(PARAMS))
    .optional()
    .describe("lst_c land skin temp, air_c, water_c, sst_c, rain_mm, stage_m, wave_m, wind_ms, fire_frp. Omit for all."),
  from: timeSchema.optional(),
  to: timeSchema.optional(),
  hours: z.number().min(1).max(MAX_LOOKBACK_HOURS).optional().describe("Lookback from `to` (default 24). Keep the default for right-now questions: buoys and satellite passes report hourly or slower, so a short window misses the latest reading and its gaps."),
});

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const conditions = {
  name: "conditions",
  description:
    "Latest readings per station, parameter and origin (measured in-situ, satellite, modeled) in an area (the nearest stations within 0.25° when none is inside it). Includes missing/flagged series and cross-origin conflicts. The user sees each parameter's time series as a chart. For current conditions leave from/to/hours unset (last 24 h): a one-hour window misses sparse satellite passes and buoy reports.",
  inputSchema: conditionsInput,
  async execute(input: z.infer<typeof conditionsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const area = resolveBbox(input.bbox, ctx);
    const window = resolveWindow(input, ctx, 24);
    const around = padBbox(area, NEARBY_DEG);
    const data = await gqlWithFeeds<{ readings: GqlReading[]; feeds: GqlFeedState[] }>(
      "AgentReadings",
      READINGS_QUERY,
      { bbox: around, ...window, params: input.params?.map((param) => param.toUpperCase()) ?? null },
      ctx.signal,
    );
    const inside = data.readings.filter((row) => inBox(area, row.station.lat, row.station.lon));
    const nearby = inside.length === 0 && data.readings.length > 0;
    const readings = nearby ? data.readings : inside;
    const bbox = nearby ? around : area;
    const latest = new Map<string, { row: GqlReading; count: number }>();
    for (const row of readings) {
      const key = `${row.station.id}|${lower(row.param)}|${lower(row.origin)}`;
      const seen = latest.get(key);
      if (!seen) latest.set(key, { row, count: 1 });
      else {
        seen.count += 1;
        if (Date.parse(row.observedAt) > Date.parse(seen.row.observedAt)) seen.row = row;
      }
    }
    const series = [...latest.values()].sort(
      (a, b) =>
        lower(a.row.param).localeCompare(lower(b.row.param)) ||
        (ORIGIN_RANK[lower(a.row.origin)] ?? 9) - (ORIGIN_RANK[lower(b.row.origin)] ?? 9) ||
        a.row.station.name.localeCompare(b.row.station.name),
    );
    const idOf = (row: GqlReading) => `reading:${readingKey(row.station.id, row.param, row.observedAt, row.origin)}`;
    const shown = series.slice(0, MAX_MODEL_ROWS);
    const evidenceRows = shown.map(({ row }) =>
      evidence(
        "reading",
        readingKey(row.station.id, row.param, row.observedAt, row.origin),
        `${row.station.name} ${lower(row.param)} ${row.value ?? "missing"} (${lower(row.origin)}) · ${row.observedAt}`,
      ),
    );
    const usable = (row: GqlReading) => row.value !== null && lower(row.flag) === "ok";
    const missing = shown
      .filter(({ row }) => !usable(row))
      .map(({ row }) => ({ evidenceId: idOf(row), station: row.station.name, param: lower(row.param), flag: lower(row.flag) }));

    // Group usable latest values by comparable parameter, then by origin.
    const groups = new Map<Param, Map<string, GqlReading[]>>();
    for (const { row } of shown) {
      if (!usable(row)) continue;
      const param = lower(row.param) as Param;
      const as = COMPARE_AS[param] ?? param;
      const byOrigin = groups.get(as) ?? new Map<string, GqlReading[]>();
      const bucket = byOrigin.get(lower(row.origin)) ?? [];
      bucket.push(row);
      byOrigin.set(lower(row.origin), bucket);
      groups.set(as, byOrigin);
    }
    const conflicts: Record<string, unknown>[] = [];
    for (const [param, byOrigin] of groups) {
      const threshold = CONFLICT_THRESHOLD[param];
      const reference = byOrigin.get("measured");
      if (threshold === undefined || !reference) continue;
      const refMean = mean(reference.map((row) => row.value!));
      for (const origin of ["satellite", "modeled"]) {
        const other = byOrigin.get(origin);
        if (!other) continue;
        const delta = mean(other.map((row) => row.value!)) - refMean;
        if (Math.abs(delta) > threshold) {
          conflicts.push({
            param,
            measured: { mean: Number(refMean.toFixed(2)), evidenceIds: reference.map(idOf) },
            [origin]: { mean: Number((refMean + delta).toFixed(2)), evidenceIds: other.map(idOf) },
            delta: Number(delta.toFixed(2)),
            threshold,
            prefer: "measured",
          });
        }
      }
    }
    const seenSources = new Set(readings.map((row) => row.station.source));
    const fallback = [...new Set((input.params ?? PARAMS).flatMap((param) => PARAM_SOURCES[param]))];
    const feeds = feedsFor(data.feeds, seenSources, fallback);
    const toRow = (row: GqlReading): ReadingRow => ({
      evidenceId: idOf(row),
      stationId: row.station.id,
      station: row.station.name,
      source: row.station.source,
      lat: row.station.lat,
      lon: row.station.lon,
      param: lower(row.param),
      value: row.value,
      flag: lower(row.flag),
      origin: lower(row.origin),
      observedAt: row.observedAt,
    });
    const scope = nearby ? `nearest stations within ${NEARBY_DEG}°` : "";
    const view = conditionsViews(
      readings.map(toRow),
      series.map(({ row }) => toRow(row)),
      bbox,
      input.params ?? [],
      scope,
    );
    const out = output(
      {
        bbox,
        window,
        ...(nearby
          ? { scope: `No station inside the area; these are the nearest within ${NEARBY_DEG}° of it.`, area }
          : {}),
        readings: readings.length,
        series: series.length,
        truncated: series.length > shown.length,
        conflicts,
        missing,
        rows: shown.map(({ row, count }, index) => ({
          evidenceId: evidenceRows[index]!.id,
          station: row.station.name,
          stationKind: row.station.kind,
          source: row.station.source,
          param: lower(row.param),
          value: row.value,
          flag: lower(row.flag),
          origin: lower(row.origin),
          observedAt: row.observedAt,
          samples: count,
        })),
      },
      evidenceRows,
      feeds,
      readings.length,
    );
    return withView(out, view);
  },
};

// ---------------------------------------------------------------- alerts

const ALERTS_QUERY = `query AgentAlerts($bbox: BBox!, $at: Time!) {
  alerts(bbox: $bbox, at: $at) { id event severity headline onset expires }
  feeds { ...FeedFields }
}
`;

type GqlAlert = {
  id: string;
  event: string;
  severity: string;
  headline: string | null;
  onset: string | null;
  expires: string | null;
};

const alertsInput = z.object({ bbox: bboxSchema.optional(), at: timeSchema.optional() });

const alerts = {
  name: LAYER.alerts,
  description: "NWS alerts (freeze, heat, marine, flood) in effect over an area at a time.",
  inputSchema: alertsInput,
  async execute(input: z.infer<typeof alertsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const bbox = resolveBbox(input.bbox, ctx);
    const at = atTime(input.at, ctx);
    const data = await gqlWithFeeds<{ alerts: GqlAlert[]; feeds: GqlFeedState[] }>(
      "AgentAlerts",
      ALERTS_QUERY,
      { bbox, at },
      ctx.signal,
    );
    const evidenceRows = data.alerts.map((row) => evidence("alert", row.id, `${row.event} (${row.severity})`));
    const feeds = feedsFor(data.feeds, [], ["nws", "nwws"]);
    const rows = data.alerts.map((row, index) => ({ evidenceId: evidenceRows[index]!.id, ...row }));
    return withView(output({ bbox, at, rows }, evidenceRows, feeds, data.alerts.length), alertsView(rows, bbox, at));
  },
};

// ---------------------------------------------------------------- hotspots

const HOTSPOT_NOTE =
  "Heuristic score = density × activity × access. It ranks where crews are likely to find animals; it is not a forecast, a probability or a population estimate.";

const HOTSPOTS_QUERY = `query AgentHotspots($species: ID!, $at: Time!, $bbox: BBox!, $top: Int) {
  hotspots(species: $species, at: $at, bbox: $bbox, top: $top) { species at cells { cell lat lon score } }
  feeds { ...FeedFields }
}
`;

type GqlHotspotGrid = { species: string; at: string; cells: { cell: string; lat: number; lon: number; score: number }[] };

const hotspotsInput = z.object({
  species: speciesSchema,
  bbox: bboxSchema.optional(),
  at: timeSchema.optional(),
  top: z.number().int().min(1).max(50).optional().describe("How many cells (default 10)."),
});

const hotspots = {
  name: LAYER.hotspots,
  description:
    "Top-scoring 0.01° cells for a species at a time (explainable heuristic, not a prediction). Use explain_cell for why a cell scores.",
  inputSchema: hotspotsInput,
  async execute(input: z.infer<typeof hotspotsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const bbox = resolveBbox(input.bbox, ctx);
    const at = atTime(input.at, ctx);
    const data = await gqlWithFeeds<{ hotspots: GqlHotspotGrid; feeds: GqlFeedState[] }>(
      "AgentHotspots",
      HOTSPOTS_QUERY,
      { species: input.species, at, bbox, top: input.top ?? 10 },
      ctx.signal,
    );
    const grid = data.hotspots;
    const evidenceRows = grid.cells.map((cell) =>
      evidence("hotspot", hotspotKey(grid.species, cell.cell, grid.at), `${grid.species} cell ${cell.cell} score ${cell.score.toFixed(2)}`),
    );
    const cells = grid.cells.map((cell, index) => ({ evidenceId: evidenceRows[index]!.id, ...cell }));
    const out = output(
      { species: grid.species, at: grid.at, heuristic: true, note: HOTSPOT_NOTE, cells },
      evidenceRows,
      feedsFor(data.feeds, [], "all"),
      grid.cells.length,
    );
    return withView(out, cellsView(grid.species, grid.at, cells, bbox));
  },
};

// ---------------------------------------------------------------- explain_cell

const EXPLAIN_QUERY = `query AgentExplainCell($cell: ID!, $species: ID!, $at: Time!) {
  explainCell(cell: $cell, species: $species, at: $at) { cell species at score terms { name value rationale } }
  feeds { ...FeedFields }
}
`;

type GqlExplain = {
  cell: string;
  species: string;
  at: string;
  score: number;
  terms: { name: string; value: number; rationale: string }[];
};

const explainInput = z
  .object({
    species: speciesSchema,
    cell: z.string().regex(/^\d+:\d+$/).optional().describe("Cell id '<col>:<row>' from hotspots."),
    lat: z.number().optional(),
    lon: z.number().optional(),
    at: timeSchema.optional(),
  })
  .refine((v) => v.cell !== undefined || (v.lat !== undefined && v.lon !== undefined), "give cell, or lat and lon");

const explainCell = {
  name: "explain_cell",
  description: "Term-by-term breakdown (density, activity, access, with rationale) of one cell's hotspot score.",
  inputSchema: explainInput,
  async execute(input: z.infer<typeof explainInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const cell = input.cell ?? cellFor(input.lat!, input.lon!);
    const at = atTime(input.at, ctx);
    const data = await gqlWithFeeds<{ explainCell: GqlExplain; feeds: GqlFeedState[] }>(
      "AgentExplainCell",
      EXPLAIN_QUERY,
      { cell, species: input.species, at },
      ctx.signal,
    );
    const explained = data.explainCell;
    const row = evidence(
      "hotspot",
      hotspotKey(explained.species, explained.cell, explained.at),
      `${explained.species} cell ${explained.cell} score ${explained.score.toFixed(2)}`,
    );
    const center = cellCenter(explained.cell);
    const out = output(
      { ...explained, evidenceId: row.id, center, heuristic: true, note: HOTSPOT_NOTE },
      [row],
      feedsFor(data.feeds, [], "all"),
      explained.terms.length,
    );
    return withView(out, explainView(explained, row.id, center));
  },
};

// ---------------------------------------------------------------- backtest

const BACKTEST_QUERY = `query AgentBacktest($species: ID!, $days: Int!) {
  backtest(species: $species, days: $days) { species days hitRate baseline perDay { day sightings hits } }
  feeds { ...FeedFields }
}
`;

type GqlBacktest = {
  species: string;
  days: number;
  hitRate: number;
  baseline: number;
  perDay: { day: string; sightings: number; hits: number }[];
};

const backtestInput = z.object({
  species: speciesSchema,
  days: z.number().int().min(1).max(30).optional().describe("Days to test (default 14)."),
});

const backtest = {
  name: "backtest",
  description:
    "Measured hit rate of past hotspot scores: share of each day's sightings inside the top 10% of cells scored with earlier data, against the 10% baseline.",
  inputSchema: backtestInput,
  async execute(input: z.infer<typeof backtestInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const data = await gqlWithFeeds<{ backtest: GqlBacktest; feeds: GqlFeedState[] }>(
      "AgentBacktest",
      BACKTEST_QUERY,
      { species: input.species, days: input.days ?? 14 },
      ctx.signal,
    );
    const result = data.backtest;
    const scored = result.perDay.reduce((sum, day) => sum + day.sightings, 0);
    const row = evidence(
      "backtest",
      `${result.species}:${result.days}`,
      `${result.species} backtest ${result.days} d: hit rate ${result.hitRate} vs baseline ${result.baseline}`,
    );
    const out = output(
      {
        evidenceId: row.id,
        ...result,
        lift: result.baseline > 0 ? Number((result.hitRate / result.baseline).toFixed(2)) : null,
        sightingsScored: scored,
        heuristic: true,
        note: HOTSPOT_NOTE,
      },
      [row],
      feedsFor(data.feeds, [], "all"),
      result.perDay.length,
    );
    return withView(out, backtestView(result, row.id));
  },
};

// ---------------------------------------------------------------- feed_state

const FEEDS_ONLY_QUERY = "query AgentFeedState { feeds { ...FeedFields } }";

const feedState = {
  name: "feed_state",
  description: "Freshness of every data feed (nominal, lagging, stale, down), with newest observation and last fetch times.",
  inputSchema: z.object({}),
  async execute(_input: Record<string, never>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const data = await gqlWithFeeds<{ feeds: GqlFeedState[] }>("AgentFeedState", FEEDS_ONLY_QUERY, {}, ctx.signal);
    const out = output({ asOf: ctx.now.toISOString() }, [], data.feeds, data.feeds.length);
    return withView(out, feedsView(out.feeds));
  },
};

// ---------------------------------------------------------------- set_view

const setViewInput = z.object({
  bbox: bboxSchema,
  time: timeSchema.optional().describe("Timeline time. Defaults to the current reference time."),
});

const setView = {
  name: "set_view",
  description: "Fly the globe to an area and move the timeline. Use it when the answer is about a place.",
  inputSchema: setViewInput,
  async execute(input: z.infer<typeof setViewInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const bbox = resolveBbox(input.bbox, ctx);
    const time = atTime(input.time, ctx);
    ctx.emit({ type: "view", bbox, time });
    return output({ bbox, time, applied: true }, [], [], 1);
  },
};

export function buildAgentRegistry(): CapabilityRegistry {
  return new CapabilityRegistry()
    .register(geocode)
    .register(sightings)
    .register(conditions)
    .register(alerts)
    .register(hotspots)
    .register(explainCell)
    .register(backtest)
    .register(feedState)
    .register(setView);
}

