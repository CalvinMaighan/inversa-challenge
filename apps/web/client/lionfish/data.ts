/**
 * Lionfish Watch GraphQL (L3 CRW readings, L4 sightings and marine readings, L5 hotspots and explainCell, E1
 * sources when the API has them). Every request goes through the threads API, so it carries the app prefix
 * (`/v1/lionfish/graphql`) and the db worker's cache. Loaded once per view: the timeline replays from memory.
 *
 * Schema tolerant: fields a later leaf adds (`Sighting.submittedAt`, `sources`) are looked up by introspection
 * first; without them the client falls back (upload dates from `evidence(sighting:<id>)` records, source notes
 * from the app config) instead of failing.
 */
import { gqlRequest } from "client/threads/api";

import type { BBox } from "shared/apps";

import { areaOf, DAY, HOUR, type Area, type FeedRow, type GqlReading, type PriorityCell, type PrioritySnapshot, type Quality, type Report } from "./model";

const iso = (ms: number) => new Date(ms).toISOString();
/** The API caps one sightings or readings window at 31 days. */
const MAX_SPAN_MS = 30 * DAY;
/** Aliased heavy fields per document (`evidence` costs 250 of the API's 3000 complexity). */
const EVIDENCE_BATCH = 10;

const bbox = (b: BBox) => ({ west: b.west, south: b.south, east: b.east, north: b.north });

// ---- schema probe -----------------------------------------------------------------------------

const typeFields = new Map<string, Promise<Map<string, string>>>();

/** Field name to named return type of a schema type (empty when introspection fails). */
export function fieldsOf(typeName: string): Promise<Map<string, string>> {
  let p = typeFields.get(typeName);
  if (!p) {
    p = gqlRequest<{ __type: { fields: { name: string; type: { name: string | null; ofType: { name: string | null; ofType: { name: string | null; ofType: { name: string | null } | null } | null } | null } }[] } | null }>(
      `query LionfishSchema($t: String!) { __type(name: $t) { fields { name type { name ofType { name ofType { name ofType { name } } } } } } }`,
      { t: typeName },
    )
      .then((r) => {
        const out = new Map<string, string>();
        for (const f of r.__type?.fields ?? []) {
          const named = f.type.name ?? f.type.ofType?.name ?? f.type.ofType?.ofType?.name ?? f.type.ofType?.ofType?.ofType?.name ?? "";
          out.set(f.name, named);
        }
        return out;
      })
      .catch(() => new Map<string, string>());
    typeFields.set(typeName, p);
  }
  return p;
}

/** Test hook: forget what the schema said. */
export function resetSchemaProbe(): void {
  typeFields.clear();
}

// ---- reports ----------------------------------------------------------------------------------

type GqlSighting = {
  id: string;
  source: string;
  extId: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  observedAt: string;
  submittedAt?: string | null;
  ingestedAt: string;
  quality: Quality;
  photoUrl: string | null;
  canonicalId: string | null;
  conflict: boolean;
  taxon: { focus: boolean };
};

/** `[from, to]` cut into spans the API accepts, newest first. */
export function spans(fromMs: number, toMs: number, maxMs = MAX_SPAN_MS): { fromMs: number; toMs: number }[] {
  const out: { fromMs: number; toMs: number }[] = [];
  for (let to = toMs; to > fromMs; to -= maxMs) out.push({ fromMs: Math.max(fromMs, to - maxMs), toMs: to });
  return out;
}

export function toReport(s: GqlSighting, areas: readonly Area[]): Report {
  const submitted = s.submittedAt ? Date.parse(s.submittedAt) : NaN;
  return {
    id: s.id,
    source: s.source,
    extId: s.extId,
    lat: s.lat,
    lon: s.lon,
    accuracyM: s.accuracyM,
    observedMs: Date.parse(s.observedAt),
    submittedMs: Number.isFinite(submitted) ? submitted : null,
    ingestedMs: Date.parse(s.ingestedAt),
    quality: s.quality,
    photoUrl: s.photoUrl,
    duplicateOf: s.canonicalId,
    conflict: s.conflict,
    areaId: areaOf(areas, s.lat, s.lon)?.id ?? null,
  };
}

export type ReportsLoad = { reports: Report[]; fromMs: number; toMs: number; submittedSource: "field" | "evidence" | "none" };

/**
 * Focus-species reports observed in `[fromMs, toMs]` in every area, with upload dates: `Sighting.submittedAt` when
 * the API has it, else the `submittedAt` of each iNat record's evidence (batched), else unknown.
 */
export async function loadReports(areas: readonly Area[], fromMs: number, toMs: number, signal?: AbortSignal): Promise<ReportsLoad> {
  const hasSubmitted = (await fieldsOf("Sighting")).has("submittedAt");
  const fields = `id source extId lat lon accuracyM observedAt ${hasSubmitted ? "submittedAt " : ""}ingestedAt quality photoUrl canonicalId conflict taxon { focus }`;
  const aliases = areas.map((a, i) => `a${i}: sightings(bbox: $b${i}, from: $from, to: $to) { ${fields} }`).join(" ");
  const decl = areas.map((_, i) => `$b${i}: BBox!`).join(", ");
  const query = `query LionfishReports(${decl}, $from: Time!, $to: Time!) { ${aliases} }`;
  const chunks = await Promise.all(
    spans(fromMs, toMs).map((s) =>
      gqlRequest<Record<string, GqlSighting[]>>(query, { ...Object.fromEntries(areas.map((a, i) => [`b${i}`, bbox(a.bbox)])), from: iso(s.fromMs), to: iso(s.toMs) }, signal),
    ),
  );
  const byId = new Map<string, Report>();
  for (const chunk of chunks) for (const list of Object.values(chunk)) for (const s of list ?? []) if (s.taxon?.focus !== false) byId.set(s.id, toReport(s, areas));
  const reports = [...byId.values()].sort((a, b) => a.observedMs - b.observedMs);
  if (hasSubmitted) return { reports, fromMs, toMs, submittedSource: "field" };
  const filled = await fillSubmitted(reports, signal);
  return { reports, fromMs, toMs, submittedSource: filled ? "evidence" : "none" };
}

/** Upload dates of iNat reports from their evidence records, in place. False when none could be read. */
async function fillSubmitted(reports: Report[], signal?: AbortSignal): Promise<boolean> {
  const want = reports.filter((r) => r.source === "inat" && r.submittedMs === null);
  let any = false;
  for (let i = 0; i < want.length; i += EVIDENCE_BATCH) {
    const batch = want.slice(i, i + EVIDENCE_BATCH);
    const q = `query LionfishSubmitted { ${batch.map((r, j) => `e${j}: evidence(id: "sighting:${Number(r.id)}") { record }`).join(" ")} }`;
    try {
      const res = await gqlRequest<Record<string, { record: { submittedAt?: string | null } } | null>>(q, {}, signal);
      batch.forEach((r, j) => {
        const t = Date.parse(res[`e${j}`]?.record?.submittedAt ?? "");
        if (Number.isFinite(t)) {
          r.submittedMs = t;
          any = true;
        }
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn("[lionfish] upload dates unavailable for a batch", err);
    }
  }
  return any;
}

// ---- readings ---------------------------------------------------------------------------------

const READING = `param value flag observedAt origin station { id source name lat lon kind }`;

async function readingsIn(areas: readonly Area[], params: string, fromMs: number, toMs: number, signal?: AbortSignal): Promise<GqlReading[]> {
  const decl = areas.map((_, i) => `$b${i}: BBox!`).join(", ");
  const aliases = areas.map((_, i) => `a${i}: readings(bbox: $b${i}, from: $from, to: $to, params: [${params}]) { ${READING} }`).join(" ");
  const query = `query LionfishReadings(${decl}, $from: Time!, $to: Time!) { ${aliases} }`;
  const out: GqlReading[] = [];
  for (const s of spans(fromMs, toMs)) {
    const res = await gqlRequest<Record<string, GqlReading[]>>(query, { ...Object.fromEntries(areas.map((a, i) => [`b${i}`, bbox(a.bbox)])), from: iso(s.fromMs), to: iso(s.toMs) }, signal);
    for (const list of Object.values(res)) out.push(...(list ?? []));
  }
  return out;
}

// Reef heat is not loaded as readings: the globe draws NOAA's finished maps (reef.ts).

/** NDBC water temperature (buoys exist in Florida only). */
export const loadBuoys = (areas: readonly Area[], fromMs: number, toMs: number, signal?: AbortSignal) => readingsIn(areas, "SST_C, WATER_C", fromMs, toMs, signal);

/** Open-Meteo Marine waves and currents over the next `hours`, one area per request (each is a dense grid). */
export async function loadMarine(areas: readonly Area[], fromMs: number, hours: number, signal?: AbortSignal): Promise<GqlReading[]> {
  const lists = await Promise.all(areas.map((a) => readingsIn([a], "WAVE_M, CURRENT_MS", fromMs, fromMs + hours * HOUR, signal).catch((err) => (signal?.aborted ? Promise.reject(err) : (console.warn("[lionfish] marine", a.id, err), [])))));
  return lists.flat();
}

// ---- survey priority --------------------------------------------------------------------------

const COMPONENT_BRIEF = `value state`;
const CELL_BRIEF = `cell lat lon regionId rankScore thin components { recentReports { ${COMPONENT_BRIEF} } idQuality { ${COMPONENT_BRIEF} } heatStress { ${COMPONENT_BRIEF} } completeness { ${COMPONENT_BRIEF} } }`;

type GqlCell = Omit<PriorityCell, "regionId" | "thin"> & { regionId: string | null; thin: boolean | null; components: PriorityCell["components"] | null };

const toCell = (c: GqlCell): PriorityCell | null => (c.components && c.regionId ? { ...c, regionId: c.regionId, thin: c.thin === true, components: c.components } : null);

/** The ranked cells of every area at `atMs` (what was known then: basis SUBMITTED), one aliased request. */
export async function loadSnapshot(species: string, areas: readonly Area[], atMs: number, top: number, signal?: AbortSignal): Promise<PrioritySnapshot> {
  const decl = areas.map((_, i) => `$b${i}: BBox!`).join(", ");
  const aliases = areas.map((a, i) => `a${i}: hotspots(species: $sp, at: $t, bbox: $b${i}, top: ${top}, region: "${a.id}", basis: SUBMITTED) { cells { ${CELL_BRIEF} } }`).join(" ");
  const res = await gqlRequest<Record<string, { cells: GqlCell[] }>>(
    `query LionfishPriority($sp: ID!, $t: Time!, ${decl}) { ${aliases} }`,
    { sp: species, t: iso(atMs), ...Object.fromEntries(areas.map((a, i) => [`b${i}`, bbox(a.bbox)])) },
    signal,
  );
  const cells = Object.values(res).flatMap((g) => (g?.cells ?? []).map(toCell).filter((c): c is PriorityCell => c !== null));
  return { atMs, cells };
}

/**
 * Daily snapshots back over the window (newest first), a few requests at a time, each reported as it lands so
 * the timeline can use what has arrived. Resolves when all are in.
 */
export async function loadSnapshots(
  species: string,
  areas: readonly Area[],
  times: readonly number[],
  top: number,
  onSnapshot: (s: PrioritySnapshot) => void,
  signal?: AbortSignal,
  concurrency = 3,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < times.length) {
      const t = times[next++]!;
      try {
        onSnapshot(await loadSnapshot(species, areas, t, top, signal));
      } catch (err) {
        if (signal?.aborted) return;
        console.warn("[lionfish] priority snapshot", new Date(t).toISOString(), err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, times.length) }, worker));
}

/** Snapshot times: `liveMs`, then one per day back to `fromMs`. */
export function snapshotTimes(liveMs: number, fromMs: number): number[] {
  const out: number[] = [];
  for (let t = liveMs; t >= fromMs; t -= DAY) out.push(t);
  return out;
}

export type ExplainEvidence = { id: string; kind: string; observedAt: string | null; submittedAt: string | null; ingestedAt: string | null; weight: number | null; detail: string; url: string | null };
export type ExplainComponent = { id: string; value: number | null; state: "OK" | "UNKNOWN" | "STALE"; weight: number; rationale: string; inputs: string[]; evidence: ExplainEvidence[] };
export type CellExplain = {
  cell: string;
  at: string;
  regionId: string | null;
  rankScore: number | null;
  thin: boolean | null;
  components: Record<"recentReports" | "idQuality" | "heatStress" | "completeness", ExplainComponent> | null;
  heat: { dhw: number | null; baa: number | null; sst: number | null; anomaly: number | null; observedAt: string; ingestedAt: string; station: string; credit: string } | null;
  fieldWindow: { state: "OK" | "UNKNOWN" | "STALE"; issuedAt: string | null; waveMaxM: number | null; waveMinM: number | null; calmHours: number | null; horizonHours: number; currentMaxMs: number | null; station: string } | null;
  weights: { recentReports: number; idQuality: number; heatStress: number } | null;
  basis: string | null;
  caveats: string[];
  credit: string | null;
};

const COMPONENT_FULL = `id value state weight rationale inputs evidence { id kind observedAt submittedAt ingestedAt weight detail url }`;

/** Every component of one cell with its records, the CRW values, the field window and the caveats. */
export async function loadExplain(species: string, cell: string, atMs: number, signal?: AbortSignal): Promise<CellExplain> {
  const res = await gqlRequest<{ explainCell: CellExplain }>(
    `query LionfishExplain($cell: ID!, $sp: ID!, $t: Time!) { explainCell(cell: $cell, species: $sp, at: $t, basis: SUBMITTED) { cell at regionId rankScore thin
      components { recentReports { ${COMPONENT_FULL} } idQuality { ${COMPONENT_FULL} } heatStress { ${COMPONENT_FULL} } completeness { ${COMPONENT_FULL} } }
      heat { dhw baa sst anomaly observedAt ingestedAt station credit }
      fieldWindow { state issuedAt waveMaxM waveMinM calmHours horizonHours currentMaxMs station }
      weights { recentReports idQuality heatStress } basis caveats credit } }`,
    { cell, sp: species, t: iso(atMs) },
    signal,
  );
  return res.explainCell;
}

// ---- feeds and sources ------------------------------------------------------------------------

export async function loadFeeds(signal?: AbortSignal): Promise<FeedRow[]> {
  const res = await gqlRequest<{ feeds: FeedRow[] }>(`query LionfishFeeds { feeds { source mode state newestObservedAt lastFetchAt lagSeconds note } }`, {}, signal);
  return res.feeds ?? [];
}

/** Scalar fields of E1's per-feed source record the panel can show, when the API has them. */
const SCALARS = ["String", "ID", "Int", "Float", "Boolean", "Time", "FeedMode"];
const SOURCE_FIELDS = ["source", "feed", "id", "name", "mode", "cadence", "licence", "license", "credit", "homepage", "rateLimit", "whyPoll", "latencySeconds", "observedLatencySeconds", "lastFetchAt", "status"];

/** E1 `sources` rows (licence, credit, cadence, why poll) keyed by feed id; null when the API has no `sources`. */
export async function loadSources(signal?: AbortSignal): Promise<Record<string, Record<string, unknown>> | null> {
  const root = await fieldsOf("Query");
  const type = root.get("sources");
  if (!type) return null;
  const fields = await fieldsOf(type);
  const pick = SOURCE_FIELDS.filter((f) => SCALARS.includes(fields.get(f) ?? ""));
  const keyField = ["source", "feed", "id"].find((f) => pick.includes(f));
  if (!keyField || pick.length < 2) return null;
  try {
    const res = await gqlRequest<{ sources: Record<string, unknown>[] }>(`query LionfishSources { sources { ${pick.join(" ")} } }`, {}, signal);
    return Object.fromEntries((res.sources ?? []).map((s) => [String(s[keyField]), s]));
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}
