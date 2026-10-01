/**
 * Agent capability tools. Each data tool makes exactly one POST to Axum
 * `/v1/<app>/graphql`: its query plus `feeds` in the same document, so every
 * result carries the C3 envelopes for the sources it depends on.
 * `geocode` uses the local gazetteer then Open-Meteo; `set_view` only emits.
 * Which tools a turn gets, and which species and regions they accept, come from
 * the app config (C-A3 `agent.tools`, `taxa`, `regions`).
 */

import { z } from "zod";

import { CapabilityRegistry, type AnyCapability, type CapabilityContext, type CapabilityOutput } from "@/server/agent/runtime/registry";
import {
  cellCenter,
  cellFor,
  evidence,
  hotspotKey,
  readingKey,
  speciesKeys,
} from "@/server/agent/tools/evidence";
import { carpTools } from "@/server/agent/tools/carp";
import { commonTools } from "@/server/agent/tools/common";
import { inRegion, lookupGazetteer, openMeteoGeocode } from "@/server/agent/tools/gazetteer";
import { gqlWithFeeds, type GqlFeedState } from "@/server/agent/tools/gql";
import { notes } from "@/server/agent/tools/notes";
import { ageWords, atTime, bboxSchema, feedsFor, feedSummary, given, givenTime, HOUR_MS, lookbackWindow, output, padBbox, resolveBbox, timeSchema } from "@/server/agent/tools/shared";
import { findSite, presetBox, resolveSites, siteBox, sitesBox } from "@/server/agent/tools/sites";
import { localTime } from "@/server/agent/tools/shared";
import {
  GROUP_WORDS,
  GROUPS_OF,
  resolveSpecies,
  SPECIES_COUNTS_QUERY,
  speciesCountRow,
  speciesCountsView,
  speciesLabel,
  speciesNameSchema,
  type GqlSpeciesCount,
} from "@/server/agent/tools/species";
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
import type { AppConfig } from "@/shared/apps";
import { QUALITY_CODES } from "@/shared/frames";
import { sightingPageUrl } from "@/shared/source-pages";
import { LAYER_IDS } from "@/shared/voice/ui-tools";

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

type SpeciesSchema = z.ZodType<string>;

/** The app's focus species as an enum, so the model sees exactly the keys this app has. */
function speciesSchemaFor(app: AppConfig): SpeciesSchema {
  const keys = speciesKeys(app);
  if (keys.length === 0) return z.never();
  return z.enum(keys as [string, ...string[]]).describe(keys.join(" | "));
}

const QUALITY = QUALITY_CODES;

type LayerId = (typeof LAYER_IDS)[number];
/** Tools that fill a globe layer are named after it, so a tool row can highlight that layer. */
const LAYER = Object.fromEntries(LAYER_IDS.map((id) => [id, id])) as { readonly [K in LayerId]: K };
const PARAMS = ["lst_c", "air_c", "water_c", "sst_c", "rain_mm", "stage_m", "wave_m", "wind_ms", "fire_frp"] as const;
type Param = (typeof PARAMS)[number];

// ---------------------------------------------------------------- helpers

export { ageWords, feedSummary, resolveBbox };

function resolveWindow(
  input: { from?: string; to?: string; hours?: number },
  ctx: CapabilityContext,
  defaultHours: number,
): { from: string; to: string } {
  const window = lookbackWindow(input, ctx.now, defaultHours, MAX_LOOKBACK_HOURS);
  return { from: window.from, to: window.to };
}

const inBox = (bbox: BBox, lat: number, lon: number) =>
  lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;

const lower = (value: string) => value.toLowerCase();

// ---------------------------------------------------------------- geocode

const geocode = {
  name: "geocode",
  description:
    "Resolve a place name inside this app's regions (park units, reefs, towns, river gauges, marinas) to a point, a bbox and its grid cell. Call before any area query.",
  inputSchema: z.object({ place: z.string().min(2).max(120).describe("Place name, e.g. 'Flamingo' or 'Key Largo'") }),
  async execute(input: { place: string }, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const local = lookupGazetteer(input.place);
    const place = (local && inRegion(ctx.app, local.lat, local.lon) ? local : null) ?? (await openMeteoGeocode(ctx.app, input.place, ctx.signal));
    if (!place) throw new Error(`No place named "${input.place}" inside this app's regions. ${ctx.app.agent.refusal}`);
    return output({ ...place, cell: cellFor(ctx.app, place.lat, place.lon) }, [], [], 1);
  },
};

// ---------------------------------------------------------------- sightings

const SIGHTINGS_QUERY = `query AgentSightings($bbox: BBox!, $from: Time!, $to: Time!, $taxa: [ID!], $quality: [Quality!]) {
  sightings(bbox: $bbox, from: $from, to: $to, taxa: $taxa, quality: $quality) {
    id source extId taxon { id scientificName commonName } lat lon accuracyM observedAt quality canonicalId conflict ingestedAt
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
  /** Absent from APIs that predate it. */
  ingestedAt?: string | null;
};

/** A record stored more than a day after it was observed is late (the API's frame flag 4, PRD §7). */
const LATE_MS = 24 * HOUR_MS;

/** How long after its observation a late record reached the API ("2.2 days"), or null when it is not late. */
export function lateBy(row: Pick<GqlSighting, "observedAt" | "ingestedAt">): string | null {
  if (!row.ingestedAt) return null;
  const lag = Date.parse(row.ingestedAt) - Date.parse(row.observedAt);
  if (!(lag > LATE_MS)) return null;
  const days = lag / (24 * HOUR_MS);
  return days < 10 ? `${days.toFixed(1)} days` : `${Math.round(days)} days`;
}

/** Research grade first, then curated records, then unconfirmed. */
const QUALITY_RANK: Record<string, number> = { research: 0, curated: 1, needs_id: 2, casual: 3 };

const sightingsInput = z.object({
  bbox: bboxSchema.optional(),
  species: z
    .array(speciesNameSchema)
    .max(8)
    .optional()
    .describe("Limit to these species, by any name (python, tegu, iguana, lionfish, brown anole, Cuban tree frog, Anolis sagrei…). Omit for every introduced species."),
  quality: z.array(z.enum(QUALITY)).optional().describe("Limit to these quality grades."),
  from: timeSchema.optional(),
  to: timeSchema.optional(),
  hours: z.number().min(1).max(MAX_LOOKBACK_HOURS).optional().describe("Lookback from `to` (default 168 = 7 days)."),
});

const sightings = {
  name: LAYER.sightings,
  description:
    "Invasive species sightings (iNaturalist, USGS NAS, GBIF) in an area and time window, of any species (the four focus species or any other introduced animal or plant, by common or scientific name). Rows carry quality grade, duplicate links (duplicateOf) and ID-conflict flags. Default window: the last 7 days. A window ending now that comes back empty is widened to the last 30 days (the result says so). The user sees every row in a table panel. For 'which species were seen' use species_counts.",
  inputSchema: sightingsInput,
  async execute(input: z.infer<typeof sightingsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const bbox = resolveBbox(input.bbox, ctx);
    const wanted = input.species ? await resolveSpecies(input.species, ctx) : null;
    if (wanted && wanted.taxonIds.length === 0) {
      const missing = wanted.unresolved.map((u) => (u.inat ? `${u.asked} (iNaturalist knows it as ${u.inat}, but no sighting of it is stored)` : `${u.asked} (no such species in the data or at iNaturalist)`));
      return output({ bbox, total: 0, distinctAnimals: 0, duplicates: 0, conflicts: 0, rows: [], unresolvedSpecies: missing, note: `No records: ${missing.join("; ")}. Say so plainly.` }, [], [], 0);
    }
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
        taxa: wanted?.taxonIds ?? null,
        quality: input.quality?.map((quality) => quality.toUpperCase()) ?? null,
      },
      ctx,
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
      const name = speciesLabel(row.taxon);
      bySpecies[name] = (bySpecies[name] ?? 0) + 1;
    }
    const duplicates = rows.filter((row) => row.canonicalId);
    const evidenceRows = shown.map((row) =>
      evidence(
        "sighting",
        row.id,
        `${speciesLabel(row.taxon)} · ${lower(row.quality)} · ${row.source} · ${row.observedAt}`,
      ),
    );
    const feeds = feedsFor(data.feeds, new Set(rows.map((row) => row.source)), ["inat", "nas", "gbif"]);
    const viewRows: SightingRow[] = rows.map((row) => ({
      evidenceId: `sighting:${row.id}`,
      species: speciesLabel(row.taxon),
      source: row.source,
      quality: lower(row.quality),
      observedAt: row.observedAt,
      lat: row.lat,
      lon: row.lon,
      duplicateOf: row.canonicalId ? `sighting:${row.canonicalId}` : null,
      idConflict: row.conflict,
      late: lateBy(row),
      sourcePageUrl: sightingPageUrl(row.source, row.extId),
    }));
    const species = wanted && wanted.names.length > 0 ? wanted.names.join(", ") : "invasive";
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
        ...(wanted && wanted.unresolved.length > 0
          ? { unresolvedSpecies: wanted.unresolved.map((u) => (u.inat ? `${u.asked}: iNaturalist knows it as ${u.inat}, but no sighting of it is stored` : `${u.asked}: no such species in the data or at iNaturalist`)) }
          : {}),
        total: rows.length,
        distinctAnimals: rows.length - duplicates.length,
        duplicates: duplicates.length,
        conflicts: rows.filter((row) => row.conflict).length,
        late: rows.filter((row) => lateBy(row) !== null).length,
        // Named up front, like feedSummary.mention: each late record with how late and its citation marker.
        ...(rows.some((row) => lateBy(row) !== null)
          ? {
              lateRecords: rows
                .filter((row) => lateBy(row) !== null)
                .slice(0, MAX_MODEL_ROWS)
                .map((row) => ({ source: row.source, arrived: `${lateBy(row)} after it was observed`, cite: `[e:sighting:${row.id}]` })),
            }
          : {}),
        byQuality,
        bySpecies,
        truncated: rows.length > shown.length,
        rows: shown.map((row, index) => ({
          evidenceId: evidenceRows[index]!.id,
          species: speciesLabel(row.taxon),
          source: row.source,
          quality: lower(row.quality),
          observedAt: row.observedAt,
          lat: row.lat,
          lon: row.lon,
          accuracyM: row.accuracyM,
          duplicateOf: row.canonicalId ? `sighting:${row.canonicalId}` : null,
          idConflict: row.conflict,
          ...(lateBy(row) ? { arrivedLate: `${lateBy(row)} after it was observed` } : {}),
        })),
      },
      evidenceRows,
      feeds,
      rows.length,
    );
    return withView(out, view);
  },
};

// ---------------------------------------------------------------- species_counts

const speciesCountsInput = z.object({
  bbox: bboxSchema.optional(),
  groups: z
    .array(z.enum(GROUP_WORDS))
    .optional()
    .describe("Which kinds of species to count: animals (default), plants, others (insects and the rest), or all."),
  from: timeSchema.optional(),
  to: timeSchema.optional(),
  hours: z.number().min(1).max(MAX_LOOKBACK_HOURS).optional().describe("Lookback from `to` (default 168 = 7 days)."),
  top: z.number().int().min(1).max(100).optional().describe("How many species, most seen first (default 15)."),
});

/**
 * T44: which invasive species were seen, most first, with a count per species. Rows cite each species' newest
 * sighting, so an answer like "brown anole 111, curly-tailed lizard 51" carries a marker per species.
 */
const speciesCounts = {
  name: "species_counts",
  description:
    "Which invasive species were seen in an area and window, most seen first, with a count per species and each species' newest sighting to cite. Animals by default (reptiles, amphibians, birds, mammals, fish, molluscs); groups can add plants and insects. Default window: the last 7 days. Use it for 'what invasive animals…', 'which species…', 'what has been reported…' questions; use sightings for the records of one species.",
  inputSchema: speciesCountsInput,
  async execute(input: z.infer<typeof speciesCountsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const bbox = resolveBbox(input.bbox, ctx);
    const window = resolveWindow(input, ctx, DEFAULT_SIGHTING_HOURS);
    const words = input.groups && input.groups.length > 0 ? input.groups : ["animals" as const];
    const groups = words.includes("all") ? null : [...new Set(words.flatMap((w) => (w === "all" ? [] : GROUPS_OF[w])))];
    const top = input.top ?? 15;
    const data = await gqlWithFeeds<{ speciesCounts: GqlSpeciesCount[]; feeds: GqlFeedState[] }>(
      "AgentSpeciesCounts",
      SPECIES_COUNTS_QUERY,
      { bbox, ...window, groups, top },
      ctx,
    );
    const rows = data.speciesCounts.map(speciesCountRow);
    const evidenceRows = rows
      .filter((row) => row.latestSighting)
      .map((row) => evidence("sighting", row.latestSighting!.slice("sighting:".length), `${row.species} · ${row.count} in the window · newest sighting`));
    const feeds = feedsFor(data.feeds, [], ["inat", "nas", "gbif"]);
    const days = Math.max(1, Math.round((Date.parse(window.to) - Date.parse(window.from)) / (24 * HOUR_MS)));
    const kinds = words.includes("all") ? "species" : words.map((w) => (w === "others" ? "insects and others" : w)).join(", ");
    const title = `Introduced ${kinds} seen · last ${days} ${days === 1 ? "day" : "days"}`;
    const out = output(
      {
        bbox,
        window,
        groups: words,
        speciesCount: rows.length,
        sightingsTotal: rows.reduce((n, r) => n + r.count, 0),
        note:
          rows.length === 0
            ? "No introduced species of these groups were reported in this area and window."
            : "Counts are distinct sightings (duplicates stand behind their first report). Each row's cite marker is its newest sighting: name the species with its count and paste the marker right after.",
        rows: rows.slice(0, MAX_MODEL_ROWS).map((row) => ({
          species: row.species,
          scientificName: row.scientificName,
          group: row.group,
          focusSpecies: row.focus,
          count: row.count,
          cite: row.latestSighting ? `[e:${row.latestSighting}]` : null,
          ...(row.summary ? { about: row.summary } : {}),
        })),
        truncated: rows.length > MAX_MODEL_ROWS,
      },
      evidenceRows,
      feeds,
      rows.length,
    );
    return withView(out, speciesCountsView(rows, bbox, title));
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
    const around = padBbox(ctx.app, area, NEARBY_DEG);
    const data = await gqlWithFeeds<{ readings: GqlReading[]; feeds: GqlFeedState[] }>(
      "AgentReadings",
      READINGS_QUERY,
      { bbox: around, ...window, params: input.params?.map((param) => param.toUpperCase()) ?? null },
      ctx,
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

const alertsInput = z.object({
  bbox: bboxSchema.optional(),
  site: z.string().min(2).max(80).optional().describe("A configured location (conditions apps): its NWPS id, name or town, e.g. 'MCGL1' or 'Morgan City'. Replaces bbox."),
  at: timeSchema.optional().describe("Time the alerts must be in effect (default: the reference time). For a past day give that time."),
});

const alerts = {
  name: LAYER.alerts,
  description:
    "NWS alerts (freeze, heat, marine, flood, wind) in effect over an area or at a configured location at a time. An empty result still returns the time of the last alerts check, citable as its fetch run, so 'no active alerts' is a grounded claim.",
  inputSchema: alertsInput,
  async execute(input: z.infer<typeof alertsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const siteName = given(input.site);
    // One site, or a preset's sites ("Atchafalaya"), or no site: the asked-for area.
    const sites = siteName ? resolveSites(ctx.app, [siteName]) : [];
    const site = sites.length === 1 ? sites[0]! : null;
    const bbox = sites.length > 0 ? sitesBox(sites, 0.15) : resolveBbox(input.bbox, ctx);
    const at = atTime(given(input.at), ctx);
    const data = await gqlWithFeeds<{ alerts: GqlAlert[]; feeds: GqlFeedState[] }>(
      "AgentAlerts",
      ALERTS_QUERY,
      { bbox, at },
      ctx,
    );
    const evidenceRows = data.alerts.map((row) => evidence("alert", row.id, `${row.event} (${row.severity})`, "nws-alerts"));
    const feeds = feedsFor(data.feeds, [], ["nws", "nwws"]);
    const rows = data.alerts.map((row, index) => ({ evidenceId: evidenceRows[index]!.id, ...row }));
    const check = feeds.find((f) => f.source === "nws-alerts" || f.source === "nws");
    const empty =
      rows.length === 0 && check
        ? {
            noActiveAlerts: `No active NWS alerts ${site ? `at ${site.name}` : sites.length > 1 ? `at ${sites.map((s) => s.short).join(", ")}` : "in this area"} as of ${check.lastFetchAt ? localTime(ctx.app, check.lastFetchAt) : at} (the last alerts check)${check.lastFetchRunId ? `; cite that check as [e:fetch:${check.lastFetchRunId}]` : ""}. Say it in those words: "no active NWS alerts".`,
            checkedAt: check.lastFetchAt,
            checkedLocal: check.lastFetchAt ? localTime(ctx.app, check.lastFetchAt) : null,
          }
        : {};
    return withView(output({ bbox, ...(site ? { site: site.lid, siteName: site.name } : sites.length > 1 ? { sites: sites.map((s) => s.lid) } : {}), at, atLocal: localTime(ctx.app, at), ...empty, rows }, evidenceRows, feeds, data.alerts.length), alertsView(rows, bbox, at));
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

const hotspotsInput = (species: SpeciesSchema) =>
  z.object({
    species,
    bbox: bboxSchema.optional(),
    at: timeSchema.optional(),
    top: z.number().int().min(1).max(50).optional().describe("How many cells (default 10)."),
  });

const hotspots = (species: SpeciesSchema) => ({
  name: LAYER.hotspots,
  description:
    "Top-scoring grid cells for a species at a time (explainable heuristic, not a prediction). Use explain_cell for why a cell scores.",
  inputSchema: hotspotsInput(species),
  async execute(input: z.infer<ReturnType<typeof hotspotsInput>>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const bbox = resolveBbox(input.bbox, ctx);
    const at = atTime(input.at, ctx);
    const data = await gqlWithFeeds<{ hotspots: GqlHotspotGrid; feeds: GqlFeedState[] }>(
      "AgentHotspots",
      HOTSPOTS_QUERY,
      { species: input.species, at, bbox, top: input.top ?? 10 },
      ctx,
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
});

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

const explainInput = (species: SpeciesSchema) =>
  z
    .object({
      species,
      cell: z.string().regex(/^\d+:\d+$/).optional().describe("Cell id '<col>:<row>' from hotspots."),
      lat: z.number().optional(),
      lon: z.number().optional(),
      at: timeSchema.optional(),
    })
    .refine((v) => v.cell !== undefined || (v.lat !== undefined && v.lon !== undefined), "give cell, or lat and lon");

const explainCell = (species: SpeciesSchema) => ({
  name: "explain_cell",
  description: "Term-by-term breakdown (density, activity, access, with rationale) of one cell's hotspot score.",
  inputSchema: explainInput(species),
  async execute(input: z.infer<ReturnType<typeof explainInput>>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const cell = input.cell ?? cellFor(ctx.app, input.lat!, input.lon!);
    const at = atTime(input.at, ctx);
    const data = await gqlWithFeeds<{ explainCell: GqlExplain; feeds: GqlFeedState[] }>(
      "AgentExplainCell",
      EXPLAIN_QUERY,
      { cell, species: input.species, at },
      ctx,
    );
    const explained = data.explainCell;
    const row = evidence(
      "hotspot",
      hotspotKey(explained.species, explained.cell, explained.at),
      `${explained.species} cell ${explained.cell} score ${explained.score.toFixed(2)}`,
    );
    const center = cellCenter(ctx.app, explained.cell);
    const out = output(
      { ...explained, evidenceId: row.id, center, heuristic: true, note: HOTSPOT_NOTE },
      [row],
      feedsFor(data.feeds, [], "all"),
      explained.terms.length,
    );
    return withView(out, explainView(explained, row.id, center));
  },
});

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

const backtestInput = (species: SpeciesSchema) =>
  z.object({
    species,
    days: z.number().int().min(1).max(30).optional().describe("Days to test (default 14)."),
  });

const backtest = (species: SpeciesSchema) => ({
  name: "backtest",
  description:
    "Measured hit rate of past hotspot scores: share of each day's sightings inside the top 10% of cells scored with earlier data, against the 10% baseline.",
  inputSchema: backtestInput(species),
  async execute(input: z.infer<ReturnType<typeof backtestInput>>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const data = await gqlWithFeeds<{ backtest: GqlBacktest; feeds: GqlFeedState[] }>(
      "AgentBacktest",
      BACKTEST_QUERY,
      { species: input.species, days: input.days ?? 14 },
      ctx,
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
});

// ---------------------------------------------------------------- feed_state

const FEEDS_ONLY_QUERY = "query AgentFeedState { feeds { ...FeedFields } }";

const feedState = {
  name: "feed_state",
  description: "Freshness of every data feed (nominal, lagging, stale, down), with newest observation and last fetch times.",
  inputSchema: z.object({}),
  async execute(_input: Record<string, never>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const data = await gqlWithFeeds<{ feeds: GqlFeedState[] }>("AgentFeedState", FEEDS_ONLY_QUERY, {}, ctx);
    const out = output({ asOf: ctx.now.toISOString() }, [], data.feeds, data.feeds.length);
    return withView(out, feedsView(out.feeds));
  },
};

// ---------------------------------------------------------------- set_view

const setViewInput = z
  .object({
    bbox: bboxSchema.optional(),
    preset: z.string().min(2).max(60).optional().describe("A named camera preset of this app (conditions apps: 'all-sites' or 'atchafalaya'). Replaces bbox."),
    site: z.string().min(2).max(80).optional().describe("Select and frame one configured location (NWPS id, name or town). Replaces bbox."),
    time: timeSchema.optional().describe("Timeline time. Defaults to the current reference time."),
    asOf: timeSchema.optional().describe("Knowledge time for replay: show what was known at this time (forecast versions, observations, alerts as of then). Sets the timeline to it."),
    replay: z.boolean().optional().describe("Switch the timeline to knowledge-time replay. Implied by asOf; pass false to leave replay while keeping the time."),
  })
  .refine((v) => v.bbox !== undefined || v.preset !== undefined || v.site !== undefined, "give bbox, preset or site");

const setView = {
  name: "set_view",
  description:
    "Fly the globe to an area, a camera preset or a configured location, and move the timeline. asOf switches the timeline to replay: what was known then. Use it when the answer is about a place or a past moment.",
  inputSchema: setViewInput,
  async execute(input: z.infer<typeof setViewInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const presetName = given(input.preset);
    const preset = presetName ? (ctx.app.cameraPresets ?? []).find((p) => [p.id, p.name].map((s) => s.toLowerCase()).some((s) => s.includes(presetName.toLowerCase()) || presetName.toLowerCase().includes(p.id))) : undefined;
    const siteName = given(input.site);
    // An unknown preset next to a site ("preset: Simmesport, site: SMML1") is a site name: the site wins.
    if (presetName && !preset && !siteName) throw new Error(`no camera preset "${presetName}" (presets: ${(ctx.app.cameraPresets ?? []).map((p) => p.id).join(", ") || "none"})`);
    // A site that is also the preset's name ("Atchafalaya") means the preset.
    const site = siteName && !(preset && preset.name.toLowerCase().includes(siteName.toLowerCase())) ? findSite(ctx.app, siteName) : null;
    if (siteName && !site && !preset) throw new Error(`"${siteName}" is not a configured location. ${ctx.app.agent.refusal}`);
    const bbox = resolveBbox(site ? siteBox(site) : preset ? presetBox(preset) : input.bbox, ctx);
    const asOfText = givenTime(input.asOf);
    const asOf = asOfText ? Date.parse(asOfText) : undefined;
    const time = asOf !== undefined ? new Date(asOf).toISOString() : atTime(input.time, ctx);
    const replay = input.replay ?? asOf !== undefined;
    ctx.emit({
      type: "view",
      bbox,
      time,
      ...(site ? { site: site.lid } : {}),
      ...(asOf !== undefined ? { asOf } : {}),
      ...(replay ? { replay: true } : {}),
    });
    return output({ bbox, time, ...(preset ? { preset: preset.id } : {}), ...(site ? { site: site.lid, siteName: site.name } : {}), ...(asOf !== undefined ? { asOf: time } : {}), replay, applied: true }, [], [], 1);
  },
};

/** Every tool an app may list in `agent.tools`: the species tools for species apps, the river tools for conditions apps, the rest for all. */
function allCapabilities(app: AppConfig): AnyCapability[] {
  const species = speciesSchemaFor(app);
  const kind = (app as Partial<AppConfig>).kind;
  const speciesOnly = kind !== "conditions";
  const riverTools = kind === "species" ? [] : carpTools;
  return [
    geocode,
    ...(speciesOnly ? [sightings, speciesCounts] : []),
    conditions,
    alerts,
    ...(speciesOnly ? [hotspots(species), explainCell(species), backtest(species)] : []),
    ...riverTools,
    feedState,
    ...commonTools,
    notes,
    setView,
  ];
}

export const CAPABILITY_NAMES: readonly string[] = allCapabilities({ taxa: [] } as unknown as AppConfig).map((cap) => cap.name);

/**
 * The tools of one app: its `agent.tools` allowlist, in registry order. A tool off the list is never
 * registered, so the model cannot call it; a name on the list that no tool has is a config error.
 */
export function buildAgentRegistry(app: AppConfig): CapabilityRegistry {
  const allowed = new Set(app.agent.tools);
  const available = allCapabilities(app);
  const unknown = [...allowed].filter((name) => !available.some((cap) => cap.name === name));
  if (unknown.length) throw new Error(`app ${app.id}: agent.tools names unknown tools: ${unknown.join(", ")}`);
  const registry = new CapabilityRegistry();
  for (const cap of available) if (allowed.has(cap.name)) registry.register(cap);
  return registry;
}

