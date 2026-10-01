import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { NOW, setupAgentEnv, type AgentEnv } from "./helpers";

import { answerCacheKey, normalizeQuestion, readAnswerCache, writeAnswerCache, ANSWER_CACHE_TTL_MS } from "@/server/agent/cache";
import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { cellCenter, cellFor, parseEvidenceId } from "@/server/agent/tools/evidence";
import { lookupGazetteer } from "@/server/agent/tools/gazetteer";
import { focusKeyOf, pickTaxon } from "@/server/agent/tools/species";
import { viewOf } from "@/server/agent/tools/views";
import type { TableView } from "@/shared/agent/results";
import { dataVersion, resetFeedFieldProbe, toFeedState } from "@/server/agent/tools/gql";
import { startStub } from "@/eval/stub-server";
import type { AgentStreamEvent } from "@/shared/agent/events";

let env: AgentEnv;
const emitted: AgentStreamEvent[] = [];
const ctx: CapabilityContext = { now: NOW, emit: (event) => emitted.push(event) };
const registry = buildAgentRegistry();
const BISCAYNE = { west: -80.35, south: 25.35, east: -80.05, north: 25.9 };
const HOMESTEAD = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };

/**
 * iNaturalist's autocomplete, answered locally: the tests never leave the machine. `dodo` is unknown; a spelling
 * the database lacks ("cuban treefrog") comes back with the Latin name the database does hold.
 */
const realFetch = globalThis.fetch;
const inatCalls: string[] = [];
const INAT_ANSWERS: Record<string, unknown[]> = {
  "cuban treefrog": [{ id: 24382, name: "Osteopilus septentrionalis", preferred_common_name: "Cuban Tree Frog", iconic_taxon_name: "Amphibia" }],
  "nile monitor": [{ id: 34110, name: "Varanus niloticus", preferred_common_name: "Nile Monitor", iconic_taxon_name: "Reptilia" }],
};
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.inaturalist.org/v1/taxa/autocomplete")) {
    const q = new URL(url).searchParams.get("q") ?? "";
    inatCalls.push(q);
    return Promise.resolve(Response.json({ results: INAT_ANSWERS[q.toLowerCase()] ?? [] }));
  }
  return realFetch(input, init);
}) as typeof fetch;

beforeAll(() => {
  env = setupAgentEnv();
});

afterAll(() => {
  env.cleanup();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  env.stub.requests.length = 0;
  emitted.length = 0;
});

async function run(name: string, input: unknown): Promise<CapabilityOutput> {
  const result = await registry.execute(name, input, ctx);
  if (!result.ok) throw new Error(result.error);
  return result.output;
}

describe("capability tools", () => {
  test("registry exposes the eleven tools", () => {
    expect(registry.list().map((cap) => cap.name)).toEqual(["geocode", "sightings", "species_counts", "conditions", "alerts", "hotspots", "explain_cell", "backtest", "feed_state", "notes", "set_view"]);
  });

  test("species_counts (T44): the most-seen introduced animals in the box and window, each row citing its newest sighting, as a C17 table with the iNat page as its link", async () => {
    const out = await run("species_counts", { bbox: HOMESTEAD });
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentSpeciesCounts"]);
    expect(env.stub.requests[0]!.variables.groups).toEqual(["Reptilia", "Amphibia", "Aves", "Mammalia", "Actinopterygii", "Mollusca"]);
    const rows = out.data.rows as { species: string; count: number; cite: string; group: string }[];
    // Most seen first; a tie goes to the lower taxon id (the tegu, a focus species).
    expect(rows.map((r) => [r.species, r.count])).toEqual([
      ["Argentine black and white tegu", 3],
      ["Brown anole", 3],
      ["Green iguana", 2],
      ["Cuban tree frog", 1],
    ]);
    expect(rows[1]!.cite).toBe("[e:sighting:5001]");
    expect(out.evidence.map((e) => e.id)).toContain("sighting:5001");
    expect(out.count).toBe(4);
    // The oleander is a plant: not an animal, so not counted unless asked.
    expect(JSON.stringify(out.data)).not.toContain("oleander");
    const plants = await run("species_counts", { bbox: HOMESTEAD, groups: ["plants"] });
    expect((plants.data.rows as { species: string }[]).map((r) => r.species)).toEqual(["Oleander"]);
    const table = viewOf(out)!.result as TableView;
    expect(table.columns.map((c) => c.key)).toEqual(["species", "scientific", "group", "count", "latest"]);
    expect(table.rows[1]).toMatchObject({ evidenceId: "sighting:5001", species: "Brown anole", scientific: "Anolis sagrei", count: 3, sourcePageUrl: "https://www.inaturalist.org/taxa/116461" });
    expect(viewOf(out)!.highlight).toEqual(["sighting:2002", "sighting:5001", "sighting:3002", "sighting:6001"]);
  });

  test("focus names (T44): keys, common and Latin names, plurals and aliases map to the focus four; look-alikes do not", () => {
    for (const [name, key] of [
      ["python", "python"],
      ["Burmese pythons", "python"],
      ["Python bivittatus", "python"],
      ["tegus", "tegu"],
      ["Argentine tegu", "tegu"],
      ["Argentine black and white tegu", "tegu"],
      ["Green iguana", "iguana"],
      ["iguanas", "iguana"],
      ["lionfish", "lionfish"],
      ["Red lionfish", "lionfish"],
      ["lionfishes", "lionfish"],
      ["Pterois volitans", "lionfish"],
    ] as const) {
      expect([name, focusKeyOf(name)]).toEqual([name, key]);
    }
    for (const name of ["African rock python", "rhinoceros iguana", "brown anole", "Python sebae", ""]) expect([name, focusKeyOf(name)]).toEqual([name, null]);
    const rows = [
      { id: "9", scientificName: "Anolis distichus", commonName: "Bark Anole", focus: false },
      { id: "5", scientificName: "Anolis sagrei", commonName: "Brown Anole", focus: false },
    ];
    expect(pickTaxon("brown anole", rows)?.id).toBe("5");
    expect(pickTaxon("Anolis sagrei", rows)?.id).toBe("5");
    expect(pickTaxon("anole", rows)?.id).toBe("9");
    expect(pickTaxon("bark", rows)?.id).toBe("9");
    expect(pickTaxon("x", [])).toBeNull();
  });

  test("sightings (T44) takes any species name: focus keys cost no lookup, other names resolve through taxa(q), unknown ones are reported, never substituted", async () => {
    const anoles = await run("sightings", { bbox: HOMESTEAD, species: ["brown anole"] });
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentTaxa", "AgentSightings"]);
    expect(env.stub.requests[1]!.variables.taxa).toEqual(["5"]);
    expect(anoles.data.total).toBe(3);
    expect((anoles.data.rows as { species: string }[])[0]!.species).toBe("Brown anole");
    expect((viewOf(anoles)!.result as TableView).title).toBe("Brown anole sightings · last 7 days");
    env.stub.requests.length = 0;
    const latin = await run("sightings", { bbox: HOMESTEAD, species: ["Osteopilus septentrionalis", "Tegus"] });
    expect(env.stub.requests[1]!.variables.taxa).toEqual(["6", "2"]);
    expect(latin.data.bySpecies).toEqual({ "Cuban tree frog": 1, "Argentine black and white tegu": 3 });
    env.stub.requests.length = 0;
    const focus = await run("sightings", { bbox: HOMESTEAD, species: ["Green iguana", "iguanas"] });
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentSightings"]);
    expect(env.stub.requests[0]!.variables.taxa).toEqual(["3"]);
    expect(focus.data.total).toBe(2);
    // A spelling the database lacks: iNaturalist names it, and the database is asked again by that name.
    env.stub.requests.length = 0;
    inatCalls.length = 0;
    const frogs = await run("sightings", { bbox: HOMESTEAD, species: ["cuban treefrog"] });
    expect(inatCalls).toEqual(["cuban treefrog"]);
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentTaxa", "AgentTaxa", "AgentSightings"]);
    expect(env.stub.requests[2]!.variables.taxa).toEqual(["6"]);
    expect(frogs.data.total).toBe(1);
    // Known to iNaturalist but never reported here: said plainly, with iNat's name, never another species.
    env.stub.requests.length = 0;
    const monitor = await run("sightings", { bbox: HOMESTEAD, species: ["Nile monitor"] });
    expect(monitor.data.total).toBe(0);
    expect(monitor.data.unresolvedSpecies).toEqual(["Nile monitor (iNaturalist knows it as Nile Monitor (Varanus niloticus, iNaturalist taxon 34110), but no sighting of it is stored)"]);
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentTaxa", "AgentTaxa"]);
    // Unknown everywhere.
    env.stub.requests.length = 0;
    const none = await run("sightings", { bbox: HOMESTEAD, species: ["dodo"] });
    expect(none.data.total).toBe(0);
    expect(none.data.unresolvedSpecies).toEqual(["dodo (no such species in the data or at iNaturalist)"]);
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentTaxa"]);
  });

  test("notes (T43): one board query, filtered by bbox and window, newest first, as a C17 table with note:<id> ids", async () => {
    const homestead = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };
    const output = await run("notes", { bbox: homestead, hours: 24 });
    expect(env.stub.requests.map((request) => request.operationName)).toEqual(["AgentNotes"]);
    expect(env.stub.requests[0]!.variables).toEqual({ id: "everglades" });
    // Three notes near Homestead inside 24 h, one of them written in the quarter hour after the reference time
    // (the timeline cursor sits on a 15-minute step at the live edge); the Flamingo note is outside the box, the
    // older one outside the window, and the mission note (missionId + body) is not a field note at all.
    expect(output.count).toBe(3);
    expect(output.evidence.map((row) => row.id)).toEqual(["note:0194a1b2-0005-7000-8000-000000000005", "note:0194a1b2-0001-7000-8000-000000000001", "note:0194a1b2-0002-7000-8000-000000000002"]);
    for (const row of output.evidence) expect(parseEvidenceId(row.id)?.kind).toBe("note");
    expect(output.feeds).toEqual([]);
    const rows = output.data.rows as { author: string; species: string | null; aboutSighting: string | null; text: string }[];
    expect(rows[0]).toMatchObject({ author: "Ranger-B2C3", species: "python", aboutSighting: null });
    expect(rows[1]).toMatchObject({ author: "Ranger-A1B2", species: "tegu", aboutSighting: null });
    expect(rows[2]).toMatchObject({ author: "Ranger-B2C3", species: "iguana", aboutSighting: "sighting:7" });
    expect(output.data.onBoard).toBe(4);
    // An explicit `to` at the reference time still means now; a historical `to` is taken as given.
    expect((await run("notes", { bbox: homestead, hours: 24, to: NOW.toISOString() })).count).toBe(3);
    expect((await run("notes", { bbox: homestead, hours: 24, to: "2026-01-15T02:00:00Z" })).count).toBe(2);
    const view = viewOf(output)!;
    expect(view.result?.view).toBe("table");
    expect(view.highlight).toEqual(output.evidence.map((row) => row.id));
    const table = view.result as unknown as { rows: { evidenceId: string; note: string; lat: number; lon: number }[] };
    expect(table.rows[1]).toMatchObject({ evidenceId: "note:0194a1b2-0001-7000-8000-000000000001", lat: 25.4712, lon: -80.4651 });
    expect(table.rows[1]!.note).toMatch(/^Two tegus/);
    expect(view.bbox!.west).toBeLessThan(-80.4651);

    // Species filter and a wider window reach the Flamingo note only through the region box.
    expect((await run("notes", { bbox: homestead, hours: 24, species: "iguana" })).count).toBe(1);
    expect((await run("notes", { hours: 24 * 7 })).count).toBe(4);
    await expect(run("notes", { from: "2026-01-16T00:00:00Z", to: "2026-01-15T00:00:00Z" })).rejects.toThrow(/empty/);
  });

  test("each data tool makes exactly one GraphQL POST and carries evidence plus feeds", async () => {
    const calls: [string, unknown, string][] = [
      ["sightings", { bbox: BISCAYNE }, "AgentSightings"],
      ["conditions", { bbox: BISCAYNE }, "AgentReadings"],
      ["alerts", { bbox: BISCAYNE }, "AgentAlerts"],
      ["hotspots", { species: "lionfish" }, "AgentHotspots"],
      ["explain_cell", { species: "lionfish", cell: "282:71" }, "AgentExplainCell"],
      ["backtest", { species: "python" }, "AgentBacktest"],
      ["feed_state", {}, "AgentFeedState"],
    ];
    for (const [name, input, operation] of calls) {
      env.stub.requests.length = 0;
      const output = await run(name, input);
      expect(env.stub.requests.map((request) => request.operationName)).toEqual([operation]);
      expect(Array.isArray(output.evidence)).toBe(true);
      for (const row of output.evidence) expect(parseEvidenceId(row.id)?.kind).toBe(row.kind);
      expect(output.feeds.length).toBeGreaterThan(0);
      expect(output.data.feedSummary).toBeDefined();
    }
  });

  test("geocode and set_view make no GraphQL call", async () => {
    const place = await run("geocode", { place: "the Flamingo visitor center" });
    expect(place.data.name).toBe("Flamingo");
    expect(place.data.cell).toBe(cellFor(25.1417, -80.9245));
    await run("set_view", { bbox: BISCAYNE, time: "2026-01-14T12:00:00Z" });
    expect(emitted).toEqual([{ type: "view", bbox: BISCAYNE, time: "2026-01-14T12:00:00.000Z" }]);
    expect(env.stub.requests).toHaveLength(0);
  });

  test("geocode falls back to Open-Meteo and keeps only in-region hits", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        results: [
          { name: "Cutler", latitude: 40.1, longitude: -100.2, admin1: "Nebraska" },
          { name: "Cutler Bay", latitude: 25.578, longitude: -80.337, admin1: "Florida" },
        ],
      });
    }) as typeof fetch;
    try {
      const out = await run("geocode", { place: "Cutler Bay" });
      expect(out.data).toMatchObject({ name: "Cutler Bay, Florida", source: "open-meteo", cell: "286:127" });
      expect(urls[0]).toStartWith("https://geocoding-api.open-meteo.com/v1/search?name=Cutler+Bay");
      globalThis.fetch = (async () => Response.json({ results: [{ name: "Cutler", latitude: 40.1, longitude: -100.2 }] })) as unknown as typeof fetch;
      const miss = await registry.execute("geocode", { place: "Cutler Bay" }, ctx);
      expect(miss).toMatchObject({ ok: false, error: 'No place named "Cutler Bay" inside the operating region' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("conditions: latest per series, conflicts preferring measured, missing flags", async () => {
    const biscayne = await run("conditions", { bbox: BISCAYNE, params: ["water_c", "sst_c"] });
    const conflicts = biscayne.data.conflicts as { param: string; delta: number; prefer: string }[];
    expect(conflicts).toEqual([
      expect.objectContaining({ param: "sst_c", delta: 2.3, prefer: "measured" }),
    ]);
    expect(biscayne.evidence.map((row) => row.id)).toEqual([
      "reading:21:sst_c:1768440600000:satellite",
      "reading:11:water_c:1768417200000:measured",
      "fetch:90410",
      "fetch:90414",
    ]);
    const sharkValley = await run("conditions", {
      bbox: { west: -80.85, south: 25.67, east: -80.68, north: 25.84 },
      params: ["lst_c"],
    });
    expect(sharkValley.data.missing).toEqual([
      {
        evidenceId: "reading:22:lst_c:1768440600000:satellite",
        station: "GOES-19 cell Shark Valley",
        param: "lst_c",
        flag: "cloud",
      },
    ]);
    expect((sharkValley.data.rows as { samples: number }[])[0]!.samples).toBe(2);
    expect(sharkValley.feeds.map((feed) => feed.source)).toEqual(["goes"]);
  });

  test("sightings: research first, duplicates and conflicts counted", async () => {
    const out = await run("sightings", {
      bbox: { west: -80.56, south: 25.38, east: -80.33, north: 25.56 },
      species: ["tegu"],
    });
    const rows = out.data.rows as { evidenceId: string; quality: string; idConflict: boolean }[];
    expect(rows.map((row) => row.quality)).toEqual(["research", "needs_id", "casual"]);
    expect(out.data.conflicts).toBe(1);
    expect(env.stub.requests[0]!.variables.taxa).toEqual(["2"]);
    const pythons = await run("sightings", { bbox: { west: -80.85, south: 25.67, east: -80.68, north: 25.84 } });
    expect(pythons.data.total).toBe(4);
    expect(pythons.data.distinctAnimals).toBe(2);
    expect(pythons.data.duplicates).toBe(2);
  });

  test("source page link: sightings table rows carry the publisher page, the model summary does not", async () => {
    const out = await run("sightings", { bbox: { west: -80.85, south: 25.67, east: -80.68, north: 25.84 } });
    const table = viewOf(out)!.result as TableView;
    const pages = Object.fromEntries(table.rows.map((row) => [row.evidenceId, row.sourcePageUrl]));
    expect(pages["sighting:1001"]).toBe("https://www.inaturalist.org/observations/301200411");
    expect(pages["sighting:1002"]).toBe("https://www.gbif.org/occurrence/5012233411");
    // Not a NAS specimen key: no link rather than a broken one.
    expect(pages["sighting:1004"]).toBeNull();
    expect(table.columns.map((column) => column.key)).not.toContain("sourcePageUrl");
    expect(JSON.stringify(out.data)).not.toContain("sourcePageUrl");
    expect(JSON.stringify(out.data)).not.toContain("inaturalist.org/observations");
  });

  test("hotspots are labelled heuristic with C14 hotspot ids", async () => {
    const out = await run("hotspots", { species: "python", top: 2 });
    expect(out.data.heuristic).toBe(true);
    expect(String(out.data.note)).toContain("not a forecast");
    expect(out.evidence.filter((row) => row.kind === "hotspot").map((row) => row.id)).toEqual([
      "hotspot:python:243:145:1768446000000",
      "hotspot:python:244:147:1768446000000",
    ]);
  });

  test("feed_state cites each feed's last fetch run and backtest cites species:days", async () => {
    const feeds = await run("feed_state", {});
    // nwws has never fetched, so 9 of 10 feeds are citable.
    expect(feeds.evidence).toHaveLength(9);
    expect(feeds.evidence.find((row) => row.id === "fetch:90410")).toEqual({
      id: "fetch:90410",
      kind: "fetch",
      label: "ndbc stale · last fetch 2026-01-15T02:52:00Z",
    });
    const modelFeeds = feeds.data.feeds as { source: string; evidenceId: string | null }[];
    expect(modelFeeds.find((feed) => feed.source === "nwws")?.evidenceId).toBeNull();
    const backtest = await run("backtest", { species: "iguana", days: 7 });
    expect(backtest.data.evidenceId).toBe("backtest:iguana:7");
    expect(backtest.evidence[0]).toMatchObject({ id: "backtest:iguana:7", kind: "backtest" });
  });

  test("an API without FeedState.lastFetchRunId: one retry, then the field is dropped", async () => {
    resetFeedFieldProbe();
    const legacy = startStub(0, { legacyFeeds: true });
    process.env.INVERSA_API_ORIGIN = legacy.origin;
    try {
      const first = await run("alerts", {});
      expect(legacy.requests.map((request) => request.operationName)).toEqual(["AgentAlerts", "AgentAlerts"]);
      expect(first.evidence.every((row) => row.kind === "alert")).toBe(true);
      expect(first.feeds.length).toBe(2);
      legacy.requests.length = 0;
      await run("feed_state", {});
      expect(legacy.requests).toHaveLength(1);
    } finally {
      process.env.INVERSA_API_ORIGIN = env.stub.origin;
      legacy.stop();
      resetFeedFieldProbe();
    }
  });

  test("explain_cell accepts lat/lon and computes the cell", async () => {
    const out = await run("explain_cell", { species: "iguana", lat: 25.465, lon: -80.475 });
    expect(out.data.cell).toBe("272:116");
    expect(out.evidence[0]!.id).toBe("hotspot:iguana:272:116:1768446000000");
  });

  test("time windows default from the reference time and reject empty windows", async () => {
    const out = await run("sightings", { hours: 48 });
    expect(out.data.window).toEqual({ from: "2026-01-13T03:00:00.000Z", to: "2026-01-15T03:00:00.000Z" });
    // The call fetches the 30 days before `to`, so an empty window can say what is older.
    expect(env.stub.requests[0]!.variables).toMatchObject({
      from: "2025-12-16T03:00:00.000Z",
      to: "2026-01-15T03:00:00.000Z",
      bbox: { west: -83.2, south: 24.3, east: -79.8, north: 27.5 },
    });
    const fixed = await run("sightings", { from: "2026-01-13T00:00:00Z", to: "2026-01-14T00:00:00Z" });
    expect(env.stub.requests[1]!.variables).toMatchObject({ from: "2025-12-15T00:00:00.000Z", to: "2026-01-14T00:00:00.000Z" });
    expect(fixed.data.window).toEqual({ from: "2026-01-13T00:00:00.000Z", to: "2026-01-14T00:00:00.000Z" });
    const bad = await registry.execute("sightings", { from: "2026-01-15T00:00:00Z", to: "2026-01-14T00:00:00Z" }, ctx);
    expect(bad).toMatchObject({ ok: false, code: "error" });
    const outside = await registry.execute("alerts", { bbox: { west: -100, south: 40, east: -99, north: 41 } }, ctx);
    expect(outside).toMatchObject({ ok: false, error: expect.stringContaining("outside the operating region") });
  });

  test("GraphQL errors surface as tool errors", async () => {
    const result = await registry.execute("explain_cell", { species: "tegu", cell: "5:5" }, ctx);
    expect(result).toMatchObject({ ok: false, code: "error", error: expect.stringContaining("AgentExplainCell") });
  });
});

describe("grid, gazetteer, feeds, cache keys", () => {
  test("cell ids round-trip on the 0.01° grid anchored at 24.3N 83.2W", () => {
    expect(cellFor(24.3, -83.2)).toBe("0:0");
    expect(cellFor(25.015, -80.375)).toBe("282:71");
    const center = cellCenter("282:71")!;
    expect(center.lat).toBeCloseTo(25.015, 6);
    expect(center.lon).toBeCloseTo(-80.375, 6);
    expect(cellFor(center.lat, center.lon)).toBe("282:71");
  });

  test("gazetteer resolves field names and aliases", () => {
    expect(lookupGazetteer("Chokoloskee")?.name).toBe("Chokoloskee");
    expect(lookupGazetteer("dive conditions at biscayne")?.name).toBe("Biscayne Bay");
    expect(lookupGazetteer("WCA-3A")?.name).toBe("Water Conservation Area 3A");
    expect(lookupGazetteer("key west")?.bbox.west).toBe(-81.85);
    expect(lookupGazetteer("Anchorage")).toBeNull();
  });

  test("feed envelopes are lower-cased and the data version is the newest fetch", () => {
    const feed = toFeedState({
      source: "ndbc",
      mode: "POLL",
      state: "STALE",
      newestObservedAt: null,
      lastFetchAt: "2026-01-15T02:52:00Z",
      lagSeconds: 28800,
      note: null,
    });
    expect(feed).toMatchObject({ mode: "poll", state: "stale" });
    expect(dataVersion([feed, { ...feed, lastFetchAt: "2026-01-15T02:59:00Z" }, { ...feed, lastFetchAt: null }])).toBe(
      "2026-01-15T02:59:00.000Z",
    );
    expect(dataVersion([{ ...feed, lastFetchAt: null }])).toBeNull();
  });

  test("answer cache normalizes the question and expires after 10 minutes", () => {
    expect(normalizeQuestion("  Where are  the PYTHONS?? ")).toBe("where are the pythons");
    const key = answerCacheKey("Where are the pythons?", "v1");
    expect(answerCacheKey("where are the pythons", "v1")).toBe(key);
    expect(answerCacheKey("where are the pythons", "v2")).not.toBe(key);
    const bbox = { west: -80.35, south: 25.35, east: -80.05, north: 25.9 };
    const scoped = answerCacheKey("where are the pythons", "v1", { bbox, now: new Date("2026-01-15T03:01:00Z") });
    expect(answerCacheKey("Where are the pythons", "v1", { bbox, now: new Date("2026-01-15T03:14:59Z") })).toBe(scoped);
    expect(answerCacheKey("Where are the pythons", "v1", { bbox, now: new Date("2026-01-15T03:15:00Z") })).not.toBe(scoped);
    expect(answerCacheKey("Where are the pythons", "v1", { bbox: { ...bbox, west: -80.4 }, now: new Date("2026-01-15T03:01:00Z") })).not.toBe(scoped);
    writeAnswerCache(key, { events: [], content: "x", citations: [] }, 1_000);
    expect(readAnswerCache(key, 1_000 + ANSWER_CACHE_TTL_MS)?.content).toBe("x");
    expect(readAnswerCache(key, 1_001 + ANSWER_CACHE_TTL_MS)).toBeUndefined();
  });
});
