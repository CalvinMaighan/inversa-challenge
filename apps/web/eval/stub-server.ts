/**
 * GraphQL stub for the agent eval and tests. Serves `fixtures/graphql.json`
 * at `POST /v1/graphql`, dispatching on `operationName` and honoring the
 * filter variables (bbox, time window, taxa, quality, params, species) the
 * way Axum's resolvers do, so tool arguments change what comes back.
 */

import fixture from "./fixtures/graphql.json";

type BBox = { west: number; south: number; east: number; north: number };
type Vars = Record<string, unknown>;
export type StubRequest = { operationName: string; variables: Vars };

export const FIXTURE_NOW = fixture.now;

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

/** `speciesCounts`: distinct sightings per taxon in the box and window, most first, by iconic group. */
function speciesCounts(v: Vars) {
  const bbox = v.bbox as BBox;
  const groups = list(v.groups);
  const top = typeof v.top === "number" ? v.top : 50;
  const byTaxon = new Map<string, { count: number; latest: { id: string; observedAt: string } }>();
  for (const row of fixture.sightings) {
    if (row.canonicalId || !inBox(bbox, row.lat, row.lon) || !inWindow(row.observedAt, v.from, v.to)) continue;
    const taxon = fixture.taxa[row.taxon as keyof typeof fixture.taxa] as FixtureTaxon;
    const group = taxon.iconicGroup ?? null;
    if (groups && !(groups.includes(group ?? "") || (group === null && groups.includes("other")))) continue;
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

function hotspots(v: Vars) {
  const key = species(v);
  const top = typeof v.top === "number" ? v.top : 10;
  const cells = fixture.hotspots[key].filter((cell) => inBox(v.bbox as BBox, cell.lat, cell.lon)).slice(0, top);
  return { species: key, at: FIXTURE_NOW, cells };
}

function explainCell(v: Vars) {
  const key = species(v);
  const found = fixture.explain[`${key}|${String(v.cell)}` as keyof typeof fixture.explain];
  if (!found) throw new Error(`no hotspot score for ${key} in cell ${String(v.cell)} at ${String(v.at)}`);
  return { cell: String(v.cell), species: key, at: FIXTURE_NOW, ...found };
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
};

export type Stub = { origin: string; requests: StubRequest[]; stop(): void };

/**
 * Port 0 picks a free port. `legacyFeeds` mimics an API from before
 * `FeedState.lastFetchRunId`: selecting the field is a GraphQL error.
 */
export function startStub(port = 0, options: { legacyFeeds?: boolean } = {}): Stub {
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/graphql") return new Response("not found", { status: 404 });
      const body = (await request.json()) as { operationName?: string; query?: string; variables?: Vars };
      const operationName = body.operationName ?? "";
      const variables = body.variables ?? {};
      requests.push({ operationName, variables });
      if (options.legacyFeeds && body.query?.includes("lastFetchRunId")) {
        return Response.json({ data: null, errors: [{ message: 'Unknown field "lastFetchRunId" on type "FeedState".' }] });
      }
      const resolve = RESOLVERS[operationName];
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
  console.log(`fixture GraphQL stub on ${stub.origin}/v1/graphql (fixture time ${FIXTURE_NOW})`);
}
