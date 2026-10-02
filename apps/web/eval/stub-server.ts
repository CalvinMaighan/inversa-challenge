/**
 * GraphQL stub for the agent eval and tests. Serves `fixtures/graphql.json`
 * at `POST /v1/<app>/graphql` (PLAN.md C-A2; the unprefixed route is gone, and
 * an unknown app is a 404 `unknown_app`), dispatching on `operationName` and honoring the
 * filter variables (bbox, time window, taxa, quality, params, species) the
 * way Axum's resolvers do, so tool arguments change what comes back.
 */

import fixture from "./fixtures/graphql.json";
import { CARP_FIXTURE_NOW, carpResolvers, REVIEW_OPERATIONS } from "./stub-carp";
import { LIONFISH_FIXTURE_NOW, lionfishResolvers, lionfishSelection } from "./stub-lionfish";

import { APP_IDS, isAppId, type AppId } from "@/shared/apps";

type BBox = { west: number; south: number; east: number; north: number };
type Vars = Record<string, unknown>;
export type StubRequest = { app: AppId; path: string; operationName: string; variables: Vars };

const GRAPHQL_PATH = /^\/v1\/([^/]+)\/graphql$/;

export const FIXTURE_NOW = fixture.now;

/** The fixture's reference time per app: carp has its own recorded week (`fixtures/carp.json`), lionfish its own (`fixtures/lionfish.json`). */
export function fixtureNow(app: AppId): string {
  return app === "carp" ? CARP_FIXTURE_NOW : app === "lionfish" ? LIONFISH_FIXTURE_NOW : FIXTURE_NOW;
}

/**
 * The fixture evidence id a question's `selectedEvidence` context describes ("a python sighting", "an LST reading"),
 * or the text itself when it already is an id. Null when nothing in the fixture matches.
 */
export function fixtureSelection(app: AppId, text: string): string | null {
  if (/^[a-z]+:.+/.test(text)) return text;
  if (app === "lionfish") return lionfishSelection(text);
  if (app === "python") {
    if (/lst|land surface|reading/i.test(text)) {
      const lst = fixture.readings.filter((r) => r.station === "22" && r.param === "LST_C" && r.value !== null).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
      return lst ? `reading:22:lst_c:${Date.parse(lst.observedAt)}:satellite` : null;
    }
    if (/sighting|report/i.test(text)) return "sighting:1001";
  }
  return null;
}

const inBox = (b: BBox, lat: number, lon: number) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
const overlaps = (a: BBox, b: BBox) => a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
const inWindow = (at: string, from: unknown, to: unknown) => {
  const t = Date.parse(at);
  return t >= Date.parse(String(from)) && t <= Date.parse(String(to));
};
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : null);

function feeds() {
  return fixture.feeds;
}

function sightings(v: Vars) {
  const bbox = v.bbox as BBox;
  const taxa = list(v.taxa);
  const quality = list(v.quality);
  return fixture.sightings
    .filter((row) => inBox(bbox, row.lat, row.lon) && inWindow(row.observedAt, v.from, v.to))
    .filter((row) => !taxa || taxa.includes(row.taxon))
    .filter((row) => !quality || quality.includes(row.quality))
    .map((row) => ({ ...row, taxon: fixture.taxa[row.taxon as keyof typeof fixture.taxa] }));
}

type FixtureTaxon = (typeof fixture.taxa)[keyof typeof fixture.taxa];

const norm = (s: string) => s.trim().toLowerCase();

/** `taxa(ids, q)`: by id, or by a name fragment inside the common or scientific name, focus first then by id. */
function taxa(v: Vars) {
  const ids = list(v.ids);
  const q = typeof v.q === "string" ? norm(v.q) : null;
  return (Object.values(fixture.taxa) as FixtureTaxon[])
    .filter((t) => !ids || ids.includes(t.id))
    .filter((t) => !q || norm(t.commonName).includes(q) || norm(t.scientificName).includes(q))
    .sort((a, b) => Number(b.focus) - Number(a.focus) || Number(a.id) - Number(b.id));
}

/** `speciesCounts`: distinct sightings of the focus taxa in the box and window, most first. */
function speciesCounts(v: Vars) {
  const bbox = v.bbox as BBox;
  const top = typeof v.top === "number" ? v.top : 50;
  const byTaxon = new Map<string, { count: number; latest: { id: string; observedAt: string } }>();
  for (const row of fixture.sightings) {
    if (row.canonicalId || !inBox(bbox, row.lat, row.lon) || !inWindow(row.observedAt, v.from, v.to)) continue;
    const taxon = fixture.taxa[row.taxon as keyof typeof fixture.taxa] as FixtureTaxon;
    if (!taxon.focus) continue;
    const cur = byTaxon.get(row.taxon) ?? { count: 0, latest: { id: row.id, observedAt: row.observedAt } };
    cur.count += 1;
    if (Date.parse(row.observedAt) > Date.parse(cur.latest.observedAt)) cur.latest = { id: row.id, observedAt: row.observedAt };
    byTaxon.set(row.taxon, cur);
  }
  return [...byTaxon.entries()]
    .sort((a, b) => b[1].count - a[1].count || Number(a[0]) - Number(b[0]))
    .slice(0, top)
    .map(([id, { count, latest }]) => ({ taxon: fixture.taxa[id as keyof typeof fixture.taxa], count, latestSightingId: latest.id }));
}

function readings(v: Vars) {
  const bbox = v.bbox as BBox;
  const params = list(v.params);
  return fixture.readings
    .map((row) => ({ ...row, station: fixture.stations[row.station as keyof typeof fixture.stations] }))
    .filter((row) => inBox(bbox, row.station.lat, row.station.lon) && inWindow(row.observedAt, v.from, v.to))
    .filter((row) => !params || params.includes(row.param));
}

function alerts(v: Vars) {
  const at = Date.parse(String(v.at));
  return fixture.alerts
    .filter((row) => overlaps(v.bbox as BBox, row.bbox))
    .filter((row) => Date.parse(row.onset) <= at && at < Date.parse(row.expires))
    .map((row) => ({
      id: row.id,
      event: row.event,
      severity: row.severity,
      headline: row.headline,
      onset: row.onset,
      expires: row.expires,
      areaGeojson: null,
    }));
}

function species(v: Vars): keyof typeof fixture.hotspots {
  const key = String(v.species);
  if (!(key in fixture.hotspots)) throw new Error(`unknown species: ${key}`);
  return key as keyof typeof fixture.hotspots;
}

// ---------------------------------------------------------------- hotspots at a time (bitemporal, like api/src/hotspot/score.rs)
//
// The score at `at` is density × activity × access from what was observed before `at`: kernel density of the
// sightings observed before `at` (Gaussian σ 2 cells truncated at 3σ, 0.5^(age / 21 d) for the live feeds, NAS and
// GBIF as a 0.2 prior; normalised to the frame maximum), the python temperature rule on the nearest station's
// latest usable air (else land-surface) reading in the 6 hours before `at`, and the levee-stage rule on the nearest
// gauge's stage. A replay at an earlier `at` therefore uses only readings and sightings known then.
const DAY_MS = 86_400_000;
const STALE_MS = 6 * 3_600_000;
const HALF_LIFE_DAYS = 21;
const DECAY_WINDOW_HALF_LIVES = 6;
const SIGMA_CELLS = 2;
const PRIOR_WEIGHT = 0.2;
const CELL_DEG = 0.01;
const REGION = { west: -83.2, south: 24.3, cols: 340, rows: 320 };
/** Stations within this many degrees feed a cell (the API's `max_cells` per parameter, in cell units). */
const REACH_DEG = 0.5;
const WARM_BOOST = 1.5;
const COLD_SUPPRESS = 0.3;
const PYTHON_RULES = {
  activity: "Burmese pythons move and bask most on warm nights; air or land-surface temperature 21–32 °C boosts activity 1.5×, below 15 °C they hole up (0.3×).",
  access: "Levee and canal-bank patrols reach more ground when water stage is low; the multiplier falls 0.3 per metre of stage, capped between 0.6 and 1.2.",
};

const cellCentre = (cell: string) => {
  const m = /^(\d+):(\d+)$/.exec(cell);
  // The API rejects an id off its grid (`App::parse_cell`): <col>:<row> inside the region's 0.01° grid.
  if (!m || Number(m[1]) >= REGION.cols || Number(m[2]) >= REGION.rows) throw new Error(`bad cell id ${JSON.stringify(cell)}; expected <col>:<row> on the ${REGION.cols}×${REGION.rows} grid`);
  return { lon: REGION.west + (Number(m[1]) + 0.5) * CELL_DEG, lat: REGION.south + (Number(m[2]) + 0.5) * CELL_DEG };
};
const cellOf = (lat: number, lon: number) => `${Math.floor((lon - REGION.west) / CELL_DEG + 1e-9)}:${Math.floor((lat - REGION.south) / CELL_DEG + 1e-9)}`;

/** Kernel density of the species' sightings observed before `at`, at one cell centre (not yet normalised). */
function densityAt(taxonId: string, centre: { lat: number; lon: number }, at: number): { value: number; recent: number; prior: number } {
  const hl = HALF_LIFE_DAYS * DAY_MS;
  let value = 0;
  let recent = 0;
  let prior = 0;
  for (const s of fixture.sightings) {
    const t = Date.parse(s.observedAt);
    if (s.taxon !== taxonId || t >= at) continue;
    const dx = (s.lon - centre.lon) / CELL_DEG;
    const dy = (s.lat - centre.lat) / CELL_DEG;
    const d2 = dx * dx + dy * dy;
    if (d2 > 9 * SIGMA_CELLS * SIGMA_CELLS) continue;
    const kernel = Math.exp(-d2 / (2 * SIGMA_CELLS * SIGMA_CELLS));
    const history = s.source === "nas" || s.source === "gbif";
    if (history) {
      prior += 1;
      value += PRIOR_WEIGHT * kernel;
    } else if (at - t <= DECAY_WINDOW_HALF_LIVES * hl) {
      recent += 1;
      value += Math.pow(0.5, (at - t) / hl) * kernel;
    }
  }
  return { value, recent, prior };
}

/** The nearest station's latest usable reading of `param` in the 6 hours before `at`, within reach of the centre. */
function readingAt(param: string, centre: { lat: number; lon: number }, at: number): { station: string; value: number; observedAt: string } | null {
  let best: { station: string; value: number; observedAt: string; dist: number } | null = null;
  for (const r of fixture.readings) {
    const t = Date.parse(r.observedAt);
    if (r.param !== param || r.value === null || r.flag !== "OK" || t > at || t <= at - STALE_MS) continue;
    const st = fixture.stations[r.station as keyof typeof fixture.stations];
    const dist = Math.hypot(st.lat - centre.lat, st.lon - centre.lon);
    if (dist > REACH_DEG) continue;
    if (!best || dist < best.dist - 1e-9 || (Math.abs(dist - best.dist) < 1e-9 && t > Date.parse(best.observedAt))) best = { station: st.name, value: r.value, observedAt: r.observedAt, dist };
  }
  return best;
}

type Term = { name: string; value: number; rationale: string };

/** Activity and access multipliers at a cell centre and time, with the rule's rationale and the reading it used. */
function rulesAt(centre: { lat: number; lon: number }, at: number, place: string | null = null): { activity: Term; access: Term } {
  const temp = readingAt("AIR_C", centre, at) ?? readingAt("LST_C", centre, at);
  const activity: Term = temp
    ? (() => {
        const v = temp.value >= 21 && temp.value <= 32 ? WARM_BOOST : temp.value < 15 ? COLD_SUPPRESS : 1;
        const band = v === WARM_BOOST ? "inside the 21–32 °C warm-night band" : v === COLD_SUPPRESS ? "below the 15 °C threshold" : "between 15 and 21 °C, neutral";
        return { name: "activity", value: v, rationale: `${PYTHON_RULES.activity} Input: ${temp.value} °C at ${temp.station}, observed ${temp.observedAt}, ${band}, so ${v}×.` };
      })()
    : { name: "activity", value: 1, rationale: `no data: no air or land-surface temperature reading within 6 hours before ${new Date(at).toISOString()} in reach of this cell, neutral 1.0 (${PYTHON_RULES.activity})` };
  const stage = readingAt("STAGE_M", centre, at);
  const access: Term = stage
    ? { name: "access", value: Number(Math.min(1.2, Math.max(0.6, 1.5 - 0.3 * stage.value)).toFixed(3)), rationale: `${PYTHON_RULES.access} Input: stage ${stage.value} m at ${stage.station}, observed ${stage.observedAt}.${place ? ` Cell: ${place}.` : ""}` }
    : { name: "access", value: 1, rationale: `no data: no stage reading within 6 hours before ${new Date(at).toISOString()} in reach of this cell, neutral 1.0 (${PYTHON_RULES.access})` };
  return { activity, access };
}

const atMs = (v: Vars) => {
  const at = typeof v.at === "string" ? Date.parse(v.at) : NaN;
  return Number.isFinite(at) ? at : Date.parse(FIXTURE_NOW);
};
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** The candidate cells: the fixture's named cells plus the cell of every sighting of the species. */
function candidateCells(key: keyof typeof fixture.hotspots, taxonId: string): { cell: string; lat: number; lon: number; place: string | null }[] {
  const out = new Map<string, { cell: string; lat: number; lon: number; place: string | null }>();
  for (const c of fixture.hotspots[key]) out.set(c.cell, c);
  for (const s of fixture.sightings) {
    if (s.taxon !== taxonId) continue;
    const cell = cellOf(s.lat, s.lon);
    if (!out.has(cell)) out.set(cell, { cell, ...cellCentre(cell), place: null });
  }
  return [...out.values()];
}

const taxonIdOf = (key: string) => (Object.values(fixture.taxa) as FixtureTaxon[]).find((t) => t.id === key || t.commonName.toLowerCase().includes(key))?.id ?? "1";

/** Every candidate cell scored at `at`: density normalised to the frame maximum, then the rules. */
function scoreGrid(key: keyof typeof fixture.hotspots, at: number) {
  const taxonId = taxonIdOf(key);
  const cells = candidateCells(key, taxonId).map((c) => ({ ...c, density: densityAt(taxonId, c, at) }));
  const max = Math.max(0, ...cells.map((c) => c.density.value));
  return cells.map((c) => {
    const density = max > 0 ? c.density.value / max : 0;
    const { activity, access } = rulesAt(c, at, c.place);
    const score = Number((density * activity.value * access.value).toFixed(2));
    const densityTerm: Term = {
      name: "density",
      value: Number(density.toFixed(2)),
      rationale: `kernel-weighted python sightings observed before ${new Date(at).toISOString()} (Gaussian σ ${SIGMA_CELLS} cells, half-life ${HALF_LIFE_DAYS} d, nas/gbif history at ${PRIOR_WEIGHT} weight), normalised to the frame maximum: ${c.density.recent} recent report${c.density.recent === 1 ? "" : "s"} and ${c.density.prior} history record${c.density.prior === 1 ? "" : "s"} within 3σ${c.place ? ` (${c.place})` : ""}`,
    };
    return { cell: c.cell, lat: c.lat, lon: c.lon, score, terms: [densityTerm, activity, access] };
  });
}

function hotspots(v: Vars) {
  const key = species(v);
  const at = atMs(v);
  const top = typeof v.top === "number" ? v.top : 10;
  const cells = scoreGrid(key, at)
    .filter((c) => c.score > 0 && inBox(v.bbox as BBox, c.lat, c.lon))
    .sort((a, b) => b.score - a.score || (a.cell < b.cell ? -1 : 1))
    .slice(0, top)
    .map(({ cell, lat, lon, score }) => ({ cell, lat, lon, score }));
  return { species: key, at: iso(at), cells };
}

function explainCell(v: Vars) {
  const key = species(v);
  const at = atMs(v);
  const cell = String(v.cell);
  const centre = cellCentre(cell);
  const found = scoreGrid(key, at).find((c) => c.cell === cell);
  if (found) return { cell, species: key, at: iso(at), score: found.score, terms: found.terms };
  // Any other cell on the grid, as the API explains it: no sighting within reach, so density 0 and the rules on its inputs.
  const { activity, access } = rulesAt(centre, at);
  const density: Term = { name: "density", value: 0, rationale: `no python sighting observed before ${new Date(at).toISOString()} within 3σ (${3 * SIGMA_CELLS} cells) of this cell` };
  return { cell, species: key, at: iso(at), score: 0, terms: [density, activity, access] };
}

function backtest(v: Vars) {
  const key = species(v);
  const found = fixture.backtest[key];
  const days = Math.min(Number(v.days), found.days);
  return { species: key, ...found, days, perDay: found.perDay.slice(-days) };
}

const RESOLVERS: Record<string, (v: Vars) => Record<string, unknown>> = {
  AgentFeeds: () => ({ feeds: feeds() }),
  AgentFeedState: () => ({ feeds: feeds() }),
  AgentSightings: (v) => ({ sightings: sightings(v), feeds: feeds() }),
  AgentTaxa: (v) => ({ taxa: taxa(v) }),
  AgentSpeciesCounts: (v) => ({ speciesCounts: speciesCounts(v), feeds: feeds() }),
  AgentReadings: (v) => ({ readings: readings(v), feeds: feeds() }),
  AgentAlerts: (v) => ({ alerts: alerts(v), feeds: feeds() }),
  AgentHotspots: (v) => ({ hotspots: hotspots(v), feeds: feeds() }),
  AgentExplainCell: (v) => ({ explainCell: explainCell(v), feeds: feeds() }),
  AgentBacktest: (v) => ({ backtest: backtest(v), feeds: feeds() }),
  // The team board (T43): `board(id)` has no filters; the notes tool filters by bbox and time itself.
  AgentNotes: (v) => ({ board: { id: String(v.id), notes: fixture.notes } }),
  AgentTeamBoard: (v) => ({ board: { id: String(v.id), lastSeq: 0, missions: fixture.board.missions, messages: fixture.board.messages, notes: fixture.notes, removals: {} } }),
  // The gridpoint forecast is stored as modeled readings at an NWS grid station (what the C4 adapter does).
  AgentWeatherForecast: (v) => ({ readings: readings(v), feeds: feeds() }),
  AgentEvidence: (v) => ({ evidence: pythonEvidence(v), feeds: feeds() }),
};

/** `evidence(id)` over the python fixture: sightings, readings, fetch runs, hotspot cells, notes, missions and messages. */
function pythonEvidence(v: Vars) {
  const id = String(v.id);
  const [kind, ...rest] = id.split(":");
  const key = rest.join(":");
  const feedOf = (source: string) => fixture.feeds.find((f) => f.source === source) ?? null;
  const base = { id, kind, raw: null as unknown, rawKey: null as string | null, sourceUrl: null as string | null, sourcePageUrl: null as string | null, fetchedAt: null as string | null, ingestLagSeconds: null as number | null, feed: null as unknown, links: [] as { id: string; relation: string; source: string }[] };
  if (kind === "sighting") {
    const s = fixture.sightings.find((x) => x.id === key);
    if (!s) throw new Error(`no evidence ${id}`);
    const taxon = fixture.taxa[s.taxon as keyof typeof fixture.taxa];
    const page = s.source === "inat" ? `https://www.inaturalist.org/observations/${s.extId}` : s.source === "gbif" ? `https://www.gbif.org/occurrence/${s.extId}` : `https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=${s.extId}`;
    const api = s.source === "inat" ? `https://api.inaturalist.org/v1/observations/${s.extId}` : s.source === "gbif" ? `https://api.gbif.org/v1/occurrence/${s.extId}` : "https://nas.er.usgs.gov/api/v2/occurrence/search?state=FL";
    return { ...base, record: { ...s, taxon: taxon.commonName, submittedAt: s.ingestedAt, licence: s.source === "inat" ? "CC BY-NC (observer's choice)" : s.source === "gbif" ? "CC BY 4.0 (dataset)" : "public domain" }, raw: s, sourceUrl: api, sourcePageUrl: page, fetchedAt: s.ingestedAt, ingestLagSeconds: Math.round((Date.parse(s.ingestedAt) - Date.parse(s.observedAt)) / 1000), feed: feedOf(s.source), links: s.canonicalId ? [{ id: `sighting:${s.canonicalId}`, relation: "duplicateOf", source: "inat" }] : [] };
  }
  if (kind === "reading") {
    const [station, param, at, origin] = key.split(":");
    const r = fixture.readings.find((x) => x.station === station && x.param.toLowerCase() === param && Date.parse(x.observedAt) === Number(at) && x.origin.toLowerCase() === origin);
    const st = fixture.stations[station as keyof typeof fixture.stations];
    if (!r || !st) throw new Error(`no evidence ${id}`);
    const goes = st.source === "goes19";
    const feed = feedOf(st.source);
    const fetchedAt = feed?.lastFetchAt ?? null;
    const record = { station: st.id, stationName: st.name, source: st.source, param: r.param, value: r.value, unit: r.param.endsWith("_C") ? "°C" : r.param === "STAGE_M" ? "m" : r.param === "WAVE_M" ? "m" : r.param === "WIND_MS" ? "m/s" : "", flag: r.flag, origin: r.origin, observedAt: r.observedAt, ...(goes ? { product: "GOES-19 ABI L2 LST/SST (full disk, hourly scan)", scanAt: r.observedAt, dqf: r.flag === "OK" ? "good" : r.flag.toLowerCase() } : {}) };
    return { ...base, record, raw: r, sourceUrl: goes ? "s3://noaa-goes19/ABI-L2-LSTC" : st.source === "ndbc" ? `https://www.ndbc.noaa.gov/data/realtime2/${st.name.split(" ")[0]}.txt` : st.source === "usgs" ? "https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/items" : "https://api.weather.gov", sourcePageUrl: goes ? "https://registry.opendata.aws/noaa-goes/" : st.source === "ndbc" ? "https://www.ndbc.noaa.gov/" : st.source === "usgs" ? "https://waterdata.usgs.gov/" : "https://www.weather.gov/", fetchedAt, ingestLagSeconds: fetchedAt ? Math.max(0, Math.round((Date.parse(fetchedAt) - Date.parse(r.observedAt)) / 1000)) : null, feed, links: [{ id: `source:${st.source}`, relation: "feed", source: st.source }] };
  }
  if (kind === "fetch") {
    const f = fixture.feeds.find((x) => x.lastFetchRunId === key);
    if (!f) throw new Error(`no evidence ${id}`);
    return { ...base, record: f, raw: f, fetchedAt: f.lastFetchAt, feed: f };
  }
  if (kind === "hotspot") {
    // hotspot:<species>:<col>:<row>:<at ms>
    const [sp, col, row, at] = key.split(":");
    if (!sp || !(sp in fixture.hotspots) || !col || !row) throw new Error(`no evidence ${id}`);
    const found = explainCell({ species: sp, cell: `${col}:${row}`, at: Number.isFinite(Number(at)) ? new Date(Number(at)).toISOString() : FIXTURE_NOW });
    return { ...base, record: found };
  }
  const row = kind === "note" ? fixture.notes.find((n) => n.id === key) : kind === "mission" ? fixture.board.missions.find((m) => m.id === key) : kind === "message" ? fixture.board.messages.find((m) => m.id === key) : null;
  if (!row) throw new Error(`no evidence ${id}`);
  return { ...base, record: row, raw: row };
}

export type Stub = { origin: string; requests: StubRequest[]; stop(): void };

/**
 * Port 0 picks a free port. `legacyFeeds` mimics an API from before
 * `FeedState.lastFetchRunId`: selecting the field is a GraphQL error. `reviewFields` serves C5's
 * `reviewBoard`/`siteReview`/`reviewHistory` for carp; without it those operations fail like an API that
 * predates C5, so the carp tools take their `siteStatusAt` fallback.
 */
export function startStub(port = 0, options: { legacyFeeds?: boolean; reviewFields?: boolean } = {}): Stub {
  const requests: StubRequest[] = [];
  const carp = carpResolvers({ reviewFields: options.reviewFields });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const app = GRAPHQL_PATH.exec(url.pathname)?.[1];
      if (request.method !== "POST" || app === undefined) return new Response("not found", { status: 404 });
      if (!isAppId(app)) return Response.json({ error: "unknown_app", apps: APP_IDS }, { status: 404 });
      const body = (await request.json()) as { operationName?: string; query?: string; variables?: Vars };
      const operationName = body.operationName ?? "";
      const variables = body.variables ?? {};
      requests.push({ app, path: url.pathname, operationName, variables });
      if (options.legacyFeeds && body.query?.includes("lastFetchRunId")) {
        return Response.json({ data: null, errors: [{ message: 'Unknown field "lastFetchRunId" on type "FeedState".' }] });
      }
      const resolve = app === "carp" ? carp[operationName] : app === "lionfish" ? lionfishResolvers[operationName] : RESOLVERS[operationName];
      if (!resolve && app === "carp" && REVIEW_OPERATIONS.has(operationName)) {
        return Response.json({ data: null, errors: [{ message: `Unknown field "${operationName.slice("Agent".length).replace(/^./, (c) => c.toLowerCase())}" on type "Query".` }] });
      }
      if (!resolve) return Response.json({ data: null, errors: [{ message: `unknown operation ${operationName}` }] });
      try {
        const data = resolve(variables);
        return options.legacyFeeds
          ? new Response(JSON.stringify({ data }, (key, value: unknown) => (key === "lastFetchRunId" ? undefined : value)), {
              headers: { "content-type": "application/json" },
            })
          : Response.json({ data });
      } catch (error) {
        return Response.json({ data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] });
      }
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, requests, stop: () => void server.stop(true) };
}

/** `bun eval/stub-server.ts [port]`: serve the fixtures standalone, e.g. to develop the UI without Axum. */
if (import.meta.main) {
  const stub = startStub(Number(process.argv[2] ?? 4041));
  console.log(`fixture GraphQL stub on ${stub.origin}/v1/<app>/graphql (fixture time ${FIXTURE_NOW})`);
}
