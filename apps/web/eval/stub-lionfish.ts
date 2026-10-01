/**
 * Lionfish Watch resolvers for the fixture GraphQL stub: the shared queries (`feeds`, `sightings`, `taxa`,
 * `speciesCounts`, `readings`, `board`, `evidence`) and the L5 component-app forms of `hotspots` and `explainCell`
 * (components, heat, fieldWindow, rankScore, thin, caveats). Data: `fixtures/lionfish.json`, built by
 * `fixtures/lionfish-build.ts`. Filters follow Axum's resolvers: bbox, observed-time window, taxa, quality,
 * params; `hotspots` honours `region` and returns the week-old ranking for an `at` more than 7 days back.
 */

import fixture from "./fixtures/lionfish.json";

type BBox = { west: number; south: number; east: number; north: number };
type Vars = Record<string, unknown>;

export const LIONFISH_FIXTURE_NOW: string = fixture.now;

const DAY = 86_400_000;
const inBox = (b: BBox, lat: number, lon: number) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
const inWindow = (at: string, from: unknown, to: unknown) => {
  const t = Date.parse(at);
  return t >= Date.parse(String(from)) && t <= Date.parse(String(to));
};
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : null);
const norm = (s: string) => s.trim().toLowerCase();

type Taxon = (typeof fixture.taxa)[keyof typeof fixture.taxa];
type Cell = (typeof fixture.hotspots.lionfish.current)[number];
const taxonOf = (id: string) => fixture.taxa[id as keyof typeof fixture.taxa] as Taxon;
const stations = fixture.stations as Record<string, { id: string; source: string; name: string; lat: number; lon: number; kind: string }>;

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
    .map((row) => ({ ...row, taxon: taxonOf(row.taxon) }));
}

function taxa(v: Vars) {
  const ids = list(v.ids);
  const q = typeof v.q === "string" ? norm(v.q) : null;
  return (Object.values(fixture.taxa) as Taxon[]).filter((t) => !ids || ids.includes(t.id)).filter((t) => !q || norm(t.commonName).includes(q) || norm(t.scientificName).includes(q));
}

function speciesCounts(v: Vars) {
  const bbox = v.bbox as BBox;
  const byTaxon = new Map<string, { count: number; latest: { id: string; observedAt: string } }>();
  for (const row of fixture.sightings) {
    if (row.canonicalId || !inBox(bbox, row.lat, row.lon) || !inWindow(row.observedAt, v.from, v.to)) continue;
    const cur = byTaxon.get(row.taxon) ?? { count: 0, latest: { id: row.id, observedAt: row.observedAt } };
    cur.count += 1;
    if (Date.parse(row.observedAt) > Date.parse(cur.latest.observedAt)) cur.latest = { id: row.id, observedAt: row.observedAt };
    byTaxon.set(row.taxon, cur);
  }
  return [...byTaxon.entries()].map(([id, { count, latest }]) => ({ taxon: taxonOf(id), count, latestSightingId: latest.id }));
}

function readings(v: Vars) {
  const bbox = v.bbox as BBox;
  const params = list(v.params);
  return fixture.readings
    .filter((row) => !params || params.includes(row.param))
    .map((row) => ({ ...row, station: stations[row.station]! }))
    .filter((row) => inBox(bbox, row.station.lat, row.station.lon) && inWindow(row.observedAt, v.from, v.to))
    .map((row) => ({ station: row.station, param: row.param, value: row.value, flag: row.flag, observedAt: row.observedAt, origin: row.origin }));
}

function species(v: Vars): void {
  if (String(v.species) !== "lionfish") throw new Error(`unknown species: ${String(v.species)}`);
}

/** `weights` overrides reweight rankScore as the API does: a weighted mean of the three ranking components. */
function reweighted(cell: Cell, weights: Vars | null) {
  if (!weights) return cell;
  const w = { recentReports: Number(weights.recentReports ?? 1), idQuality: Number(weights.idQuality ?? 1), heatStress: Number(weights.heatStress ?? 1) };
  const c = cell.components;
  const candidates: [number | null, number][] = [
    [c.recentReports.value, w.recentReports],
    [c.idQuality.value, w.idQuality],
    [c.heatStress.value, w.heatStress],
  ];
  const parts = candidates.filter((p): p is [number, number] => p[0] !== null && p[1] > 0);
  const sum = parts.reduce((a, [, wt]) => a + wt, 0);
  const rankScore = cell.thin || sum === 0 ? null : Math.round((parts.reduce((a, [v, wt]) => a + v * wt, 0) / sum) * 100) / 100;
  return { ...cell, rankScore, score: rankScore ?? 0, components: { ...c, recentReports: { ...c.recentReports, weight: w.recentReports }, idQuality: { ...c.idQuality, weight: w.idQuality }, heatStress: { ...c.heatStress, weight: w.heatStress } } };
}

function hotspots(v: Vars) {
  species(v);
  const at = Date.parse(String(v.at));
  const old = at < Date.parse(fixture.now) - 7 * DAY;
  const region = typeof v.region === "string" && v.region ? v.region : null;
  const top = typeof v.top === "number" ? v.top : 10;
  const weights = (v.weights ?? null) as Vars | null;
  const cells = (old ? fixture.hotspots.lionfish.past : fixture.hotspots.lionfish.current)
    .filter((c) => inBox(v.bbox as BBox, c.lat, c.lon) && (!region || c.regionId === region))
    .map((c) => reweighted(c as Cell, weights))
    .sort((a, b) => (b.rankScore ?? -1) - (a.rankScore ?? -1))
    .slice(0, top);
  return { species: "lionfish", at: new Date(at).toISOString(), basis: typeof v.basis === "string" ? v.basis : "SUBMITTED", weights: weights ? { recentReports: Number(weights.recentReports ?? 1), idQuality: Number(weights.idQuality ?? 1), heatStress: Number(weights.heatStress ?? 1) } : fixture.hotspots.lionfish.weights, cells };
}

function explainCell(v: Vars) {
  species(v);
  const found = fixture.explain[`lionfish|${String(v.cell)}` as keyof typeof fixture.explain];
  if (!found) throw new Error(`no priority score for lionfish in cell ${String(v.cell)} at ${String(v.at)}`);
  const weights = (v.weights ?? null) as Vars | null;
  const cell = reweighted(found as unknown as Cell, weights);
  return { ...found, ...cell, at: String(v.at), terms: [], basis: typeof v.basis === "string" ? v.basis : found.basis };
}

function board(v: Vars) {
  return { board: { ...fixture.board, id: String(v.id), notes: fixture.notes } };
}

const feedOf = (source: string) => fixture.feeds.find((f) => f.source === source) ?? null;

/** `evidence(id)`: the stored record, its publisher page and feed, for every kind the lionfish tools cite. */
function evidence(v: Vars) {
  const id = String(v.id);
  const [kind, ...rest] = id.split(":");
  const key = rest.join(":");
  const base = { id, kind, raw: null as unknown, rawKey: null as string | null, sourceUrl: null as string | null, sourcePageUrl: null as string | null, fetchedAt: null as string | null, ingestLagSeconds: null as number | null, feed: null as unknown, links: [] as { id: string; relation: string; source: string }[] };
  if (kind === "sighting") {
    const s = fixture.sightings.find((x) => x.id === key);
    if (!s) throw new Error(`no evidence ${id}`);
    const page = s.source === "inat" ? `https://www.inaturalist.org/observations/${s.extId}` : s.source === "gbif" ? `https://www.gbif.org/occurrence/${s.extId}` : `https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=${s.extId}`;
    const api = s.source === "inat" ? `https://api.inaturalist.org/v1/observations/${s.extId}` : s.source === "gbif" ? `https://api.gbif.org/v1/occurrence/${s.extId}` : "https://nas.er.usgs.gov/api/v2/occurrence/search?genus=Pterois";
    const links = s.canonicalId ? [{ id: `sighting:${s.canonicalId}`, relation: "duplicateOf", source: "inat" }] : [];
    const record = { ...s, taxon: taxonOf(s.taxon).commonName, submittedAt: s.ingestedAt, licence: s.source === "inat" ? "CC BY-NC (observer's choice)" : s.source === "gbif" ? "CC BY 4.0 (dataset)" : "public domain" };
    return { ...base, record, raw: s, sourceUrl: api, sourcePageUrl: page, fetchedAt: s.ingestedAt, ingestLagSeconds: Math.round((Date.parse(s.ingestedAt) - Date.parse(s.observedAt)) / 1000), feed: feedOf(s.source), links };
  }
  if (kind === "reading") {
    const [station, param, at, origin] = key.split(":");
    const r = fixture.readings.find((x) => x.station === station && x.param.toLowerCase() === param && Date.parse(x.observedAt) === Number(at) && x.origin.toLowerCase() === origin);
    const st = stations[station!];
    if (!r || !st) throw new Error(`no evidence ${id}`);
    const crw = st.source === "crw";
    const record = { station: st.id, stationName: st.name, source: st.source, param: r.param, value: r.value, unit: r.param === "DHW" ? "°C-weeks" : r.param === "BAA" ? "bleaching alert level 0-4" : r.param.startsWith("WAVE_M") ? "m" : r.param === "WAVE_PERIOD_S" ? "s" : r.param === "CURRENT_MS" ? "m/s" : r.param === "CURRENT_DIR_DEG" ? "degrees" : "°C", flag: r.flag, observedAt: r.observedAt, origin: r.origin, ...(crw ? { product: "CRW CoralTemp v3.1 5 km daily (dhw_5km)", productDay: r.observedAt.slice(0, 10), credit: fixture.crwCredit, doi: "https://doi.org/10.3390/rs12233856" } : {}) };
    const sourceUrl = crw ? `https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json?CRW_${r.param}[(${r.observedAt})][(${st.lat})][(${st.lon})]` : st.source === "openmeteo-marine" ? `https://marine-api.open-meteo.com/v1/marine?latitude=${st.lat}&longitude=${st.lon}&hourly=wave_height,wave_period,ocean_current_velocity,ocean_current_direction&forecast_days=3` : st.source === "ndbc" ? `https://www.ndbc.noaa.gov/data/realtime2/${st.id}.txt` : "s3://noaa-goes19/ABI-L2-SSTF";
    const sourcePageUrl = crw ? "https://coralreefwatch.noaa.gov/product/5km/index.php" : st.source === "openmeteo-marine" ? "https://open-meteo.com/en/docs/marine-weather-api" : st.source === "ndbc" ? `https://www.ndbc.noaa.gov/station_page.php?station=${st.id}` : "https://registry.opendata.aws/noaa-goes/";
    const feed = feedOf(st.source);
    const fetchedAt = crw ? "2026-09-30T09:30:00Z" : (feed?.lastFetchAt ?? null);
    return { ...base, record, raw: r, sourceUrl, sourcePageUrl, fetchedAt, ingestLagSeconds: fetchedAt ? Math.max(0, Math.round((Date.parse(fetchedAt) - Date.parse(r.observedAt)) / 1000)) : null, feed, links: [{ id: `source:${st.source}`, relation: "feed", source: st.source }] };
  }
  if (kind === "fetch") {
    const f = fixture.feeds.find((x) => x.lastFetchRunId === key);
    if (!f) throw new Error(`no evidence ${id}`);
    return { ...base, record: f, raw: f, fetchedAt: f.lastFetchAt, feed: f };
  }
  if (kind === "hotspot") {
    const [, ...cellParts] = key.split(":");
    cellParts.pop();
    const found = fixture.explain[`lionfish|${cellParts.join(":")}` as keyof typeof fixture.explain];
    if (!found) throw new Error(`no evidence ${id}`);
    return { ...base, record: found, raw: null, sourcePageUrl: null };
  }
  const row = kind === "note" ? fixture.notes.find((n) => n.id === key) : kind === "mission" ? fixture.board.missions.find((m) => m.id === key) : kind === "message" ? fixture.board.messages.find((m) => m.id === key) : null;
  if (!row) throw new Error(`no evidence ${id}`);
  return { ...base, record: row, raw: row };
}

export const lionfishResolvers: Record<string, (v: Vars) => Record<string, unknown>> = {
  AgentFeeds: () => ({ feeds: feeds() }),
  AgentFeedState: () => ({ feeds: feeds() }),
  AgentSightings: (v) => ({ sightings: sightings(v), feeds: feeds() }),
  AgentTaxa: (v) => ({ taxa: taxa(v) }),
  AgentSpeciesCounts: (v) => ({ speciesCounts: speciesCounts(v), feeds: feeds() }),
  AgentReadings: (v) => ({ readings: readings(v), feeds: feeds() }),
  AgentHotspots: (v) => ({ hotspots: hotspots(v), feeds: feeds() }),
  AgentExplainCell: (v) => ({ explainCell: explainCell(v), feeds: feeds() }),
  AgentNotes: board,
  AgentTeamBoard: board,
  AgentEvidence: (v) => ({ evidence: evidence(v), feeds: feeds() }),
};

/** The fixture record a question's `selectedEvidence` context names ("a sighting", "reading at the Looe Key CRW cell"). */
export function lionfishSelection(text: string): string | null {
  if (/crw|dhw|heat/i.test(text)) return `reading:crw-fl-looe:dhw:${Date.parse("2026-09-29T12:00:00Z")}:satellite`;
  if (/sighting|report/i.test(text)) return "sighting:8001";
  return null;
}
