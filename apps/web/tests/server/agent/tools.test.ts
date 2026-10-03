import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { NOW, setupAgentEnv, type AgentEnv } from "./helpers";

import { answerCacheKey, normalizeQuestion, readAnswerCache, writeAnswerCache, ANSWER_CACHE_TTL_MS } from "@/server/agent/cache";
import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { cellCenter, cellFor, parseEvidenceId } from "@/server/agent/tools/evidence";
import { lookupGazetteer } from "@/server/agent/tools/gazetteer";
import { focusKeyOf } from "@/server/agent/tools/species";
import { viewOf } from "@/server/agent/tools/views";
import type { TableView } from "@/shared/agent/results";
import { dataVersion, resetFeedFieldProbe, toFeedState } from "@/server/agent/tools/gql";
import { startStub } from "@/eval/stub-server";
import type { AgentStreamEvent } from "@/shared/agent/events";
import { getApp } from "@/shared/apps";

const PYTHON = getApp("python");

let env: AgentEnv;
const emitted: AgentStreamEvent[] = [];
const ctx: CapabilityContext = { app: PYTHON, now: NOW, emit: (event) => emitted.push(event) };
const registry = buildAgentRegistry(PYTHON);
const BISCAYNE = { west: -80.35, south: 25.35, east: -80.05, north: 25.9 };
const HOMESTEAD = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };
const SHARK_VALLEY = { west: -80.85, south: 25.67, east: -80.68, north: 25.84 };

beforeAll(() => {
  env = setupAgentEnv();
});

afterAll(() => {
  env.cleanup();
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
  test("registry exposes the python tools", () => {
    expect(registry.list().map((cap) => cap.name)).toEqual(["geocode", "sightings", "species_counts", "conditions", "alerts", "hotspots", "explain_cell", "backtest", "weather_forecast", "feed_state", "source_info", "evidence", "team_board", "notes", "set_view", "toggle_layer", "open_menu", "set_period", "filter_species", "select_area", "zoom", "close_panel", "fly_to", "show_card", "open_evidence", "set_look"]);
  });

  test("species_counts: the app's one species in the box and window, citing its newest sighting, as a C17 table with the iNat page as its link", async () => {
    const out = await run("species_counts", {});
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentSpeciesCounts"]);
    // No group filter: the API counts the focus taxon only.
    expect(env.stub.requests[0]!.variables).not.toHaveProperty("groups");
    expect(env.stub.requests[0]!.variables.top).toBe(1);
    const rows = out.data.rows as { species: string; count: number; cite: string }[];
    // Four distinct pythons in the last 7 days (the GBIF and NAS copies stand behind their first report).
    expect(rows.map((r) => [r.species, r.count])).toEqual([["Burmese python", 4]]);
    expect(rows[0]!.cite).toBe("[e:sighting:1005]");
    expect(out.data.sightingsTotal).toBe(4);
    expect(out.evidence.map((e) => e.id)).toContain("sighting:1005");
    expect(out.count).toBe(1);
    const table = viewOf(out)!.result as TableView;
    expect(table.title).toBe("Burmese python seen · last 7 days");
    expect(table.columns.map((c) => c.key)).toEqual(["species", "scientific", "count", "latest"]);
    expect(table.rows[0]).toMatchObject({ evidenceId: "sighting:1005", species: "Burmese python", scientific: "Python bivittatus", count: 4, sourcePageUrl: "https://www.inaturalist.org/taxa/238252" });
    expect(viewOf(out)!.highlight).toEqual(["sighting:1005"]);
    // Nothing near Homestead this week: no row, and the note says so for the species.
    const none = await run("species_counts", { bbox: HOMESTEAD });
    expect(none.data.rows).toEqual([]);
    expect(none.data.note).toBe("No burmese python was reported in this area and window.");
  });

  test("focus names: the key, common and Latin names, plurals and aliases map to the app's one species; look-alikes and other apps' species do not", () => {
    for (const [name, key] of [
      ["python", "python"],
      ["pythons", "python"],
      ["Burmese pythons", "python"],
      ["burmese python", "python"],
      ["Python bivittatus", "python"],
    ] as const) {
      expect([name, focusKeyOf(PYTHON, name)]).toEqual([name, key]);
    }
    for (const name of ["African rock python", "Python sebae", "lionfish", "Pterois volitans", "carp", ""]) expect([name, focusKeyOf(PYTHON, name)]).toEqual([name, null]);
    expect(focusKeyOf(getApp("lionfish"), "red lionfish")).toBe("lionfish");
    expect(focusKeyOf(getApp("lionfish"), "python")).toBeNull();
  });

  test("sightings takes the app's species by any of its names, with no lookup; any other name is not tracked here and never substituted", async () => {
    const named = await run("sightings", { bbox: SHARK_VALLEY, species: ["Burmese pythons", "python"] });
    expect(env.stub.requests.map((r) => r.operationName)).toEqual(["AgentSightings"]);
    expect(env.stub.requests[0]!.variables.taxa).toEqual(["1"]);
    expect(named.data.total).toBe(4);
    expect((named.data.rows as { species: string }[])[0]!.species).toBe("Burmese python");
    expect((viewOf(named)!.result as TableView).title).toBe("Burmese python sightings · last 7 days");
    // No species named: the title names the app's species.
    env.stub.requests.length = 0;
    const all = await run("sightings", { bbox: SHARK_VALLEY });
    expect(env.stub.requests[0]!.variables.taxa).toBeNull();
    expect((viewOf(all)!.result as TableView).title).toBe("Burmese python sightings · last 7 days");
    // A species the app does not track: no query, the app's refusal, never another species.
    env.stub.requests.length = 0;
    const monitor = await run("sightings", { bbox: SHARK_VALLEY, species: ["Nile monitor"] });
    expect(env.stub.requests).toHaveLength(0);
    expect(monitor.data.total).toBe(0);
    expect(monitor.data.unresolvedSpecies).toEqual(["Nile monitor"]);
    expect(String(monitor.data.note)).toBe(`Not tracked here: Nile monitor. ${PYTHON.agent.refusal}`);
    // Mixed: the python is answered, the other name reported.
    const mixed = await run("sightings", { bbox: SHARK_VALLEY, species: ["python", "dodo"] });
    expect(env.stub.requests[0]!.variables.taxa).toEqual(["1"]);
    expect(mixed.data.unresolvedSpecies).toEqual(["dodo: not tracked in this app"]);
  });

  test("notes (T43): one board query, filtered by bbox and window, newest first, as a C17 table with note:<id> ids", async () => {
    const homestead = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };
    const output = await run("notes", { bbox: homestead, hours: 24 });
    expect(env.stub.requests.map((request) => request.operationName)).toEqual(["AgentNotes"]);
    // The board is the app's (C-A6), on the app's API (C-A2).
    expect(env.stub.requests[0]!.variables).toEqual({ id: "python:main" });
    expect(env.stub.requests[0]!.path).toBe("/v1/python/graphql");
    // One note near Homestead inside 24 h, written in the quarter hour after the reference time (the timeline
    // cursor sits on a 15-minute step at the live edge); the Flamingo notes are outside the box, and the mission
    // note (missionId + body) is not a field note at all.
    expect(output.count).toBe(1);
    expect(output.evidence.map((row) => row.id)).toEqual(["note:0194a1b2-0005-7000-8000-000000000005"]);
    for (const row of output.evidence) expect(parseEvidenceId(row.id)?.kind).toBe("note");
    expect(output.feeds).toEqual([]);
    const rows = output.data.rows as { author: string; species: string | null; aboutSighting: string | null; text: string }[];
    expect(rows[0]).toMatchObject({ author: "Ranger-B2C3", species: "python", aboutSighting: null });
    // Two field notes plus the Flamingo note (AG2), the Tram Road note of today (FX), and one mission note that is not a field note.
    expect(output.data.onBoard).toBe(4);
    // An explicit `to` at the reference time still means now; a historical `to` is taken as given.
    expect((await run("notes", { bbox: homestead, hours: 24, to: NOW.toISOString() })).count).toBe(1);
    expect((await run("notes", { bbox: homestead, hours: 24, to: "2026-01-15T02:00:00Z" })).count).toBe(0);
    const view = viewOf(output)!;
    expect(view.result?.view).toBe("table");
    expect(view.highlight).toEqual(output.evidence.map((row) => row.id));
    const table = view.result as unknown as { rows: { evidenceId: string; note: string; lat: number; lon: number }[] };
    expect(table.rows[0]).toMatchObject({ evidenceId: "note:0194a1b2-0005-7000-8000-000000000005", lat: 25.4601, lon: -80.4703 });
    expect(table.rows[0]!.note).toMatch(/^Fresh python track/);
    expect(view.bbox!.west).toBeLessThan(-80.4703);

    // Species filter, and a wider window reaching the Flamingo notes only through the region box.
    expect((await run("notes", { bbox: homestead, hours: 24, species: "python" })).count).toBe(1);
    expect((await run("notes", { hours: 24 * 7 })).count).toBe(4);
    // Today over the whole region: the Tram Road note (01:40Z) and the Homestead note written in the quarter hour after the reference time.
    expect((await run("notes", { hours: 24 })).evidence.map((row) => row.id)).toEqual(["note:0194a1b2-0005-7000-8000-000000000005", "note:0194a1b2-0007-7000-8000-000000000007"]);
    await expect(run("notes", { from: "2026-01-16T00:00:00Z", to: "2026-01-15T00:00:00Z" })).rejects.toThrow(/empty/);
  });

  test("each data tool makes exactly one GraphQL POST and carries evidence plus feeds", async () => {
    const calls: [string, unknown, string][] = [
      ["sightings", { bbox: BISCAYNE }, "AgentSightings"],
      ["conditions", { bbox: BISCAYNE }, "AgentReadings"],
      ["alerts", { bbox: BISCAYNE }, "AgentAlerts"],
      ["hotspots", { species: "python" }, "AgentHotspots"],
      ["explain_cell", { species: "python", cell: "243:145" }, "AgentExplainCell"],
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
    expect(place.data.cell).toBe(cellFor(PYTHON, 25.1417, -80.9245));
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
      expect(miss).toMatchObject({ ok: false, error: expect.stringContaining(`No place named "Cutler Bay" inside this app's regions. ${PYTHON.agent.refusal}`) });
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
    expect(sharkValley.feeds.map((feed) => feed.source)).toEqual(["goes19"]);
  });

  test("sightings: research first, duplicates and conflicts counted", async () => {
    const out = await run("sightings", { species: ["python"] });
    const rows = out.data.rows as { evidenceId: string; quality: string; idConflict: boolean }[];
    expect(rows.map((row) => row.quality)).toEqual(["research", "research", "research", "research", "curated", "needs_id"]);
    expect(rows.filter((row) => row.idConflict).map((row) => row.evidenceId)).toEqual(["sighting:1005"]);
    expect(out.data.conflicts).toBe(1);
    expect(env.stub.requests[0]!.variables.taxa).toEqual(["1"]);
    const pythons = await run("sightings", { bbox: SHARK_VALLEY });
    expect(pythons.data.total).toBe(4);
    expect(pythons.data.distinctAnimals).toBe(2);
    expect(pythons.data.duplicates).toBe(2);
  });

  test("source page link: sightings table rows carry the publisher page, the model summary does not", async () => {
    const out = await run("sightings", { bbox: SHARK_VALLEY });
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
      feed: "ndbc",
    });
    const modelFeeds = feeds.data.feeds as { source: string; evidenceId: string | null }[];
    expect(modelFeeds.find((feed) => feed.source === "nwws")?.evidenceId).toBeNull();
    const backtest = await run("backtest", { species: "python", days: 7 });
    expect(backtest.data.evidenceId).toBe("backtest:python:7");
    expect(backtest.evidence[0]).toMatchObject({ id: "backtest:python:7", kind: "backtest" });
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
    const out = await run("explain_cell", { species: "python", lat: 25.755, lon: -80.765 });
    expect(out.data.cell).toBe("243:145");
    expect(out.evidence[0]!.id).toBe("hotspot:python:243:145:1768446000000");
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
    expect(outside).toMatchObject({ ok: false, error: expect.stringContaining("outside this app's regions (South Florida and the Keys)") });
  });

  test("GraphQL errors surface as tool errors", async () => {
    // A cell off the region's grid: the API's `parse_cell` rejects it (the stub scores any cell on the grid).
    const result = await registry.execute("explain_cell", { species: "python", cell: "5000:5" }, ctx);
    expect(result).toMatchObject({ ok: false, code: "error", error: expect.stringContaining("AgentExplainCell") });
  });
});

describe("grid, gazetteer, feeds, cache keys", () => {
  test("cell ids round-trip on the 0.01° grid anchored at 24.3N 83.2W", () => {
    expect(cellFor(PYTHON, 24.3, -83.2)).toBe("0:0");
    expect(cellFor(PYTHON, 25.015, -80.375)).toBe("282:71");
    const center = cellCenter(PYTHON, "282:71")!;
    expect(center.lat).toBeCloseTo(25.015, 6);
    expect(center.lon).toBeCloseTo(-80.375, 6);
    expect(cellFor(PYTHON, center.lat, center.lon)).toBe("282:71");
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
    const key = answerCacheKey("python", "Where are the pythons?", "v1");
    expect(answerCacheKey("python", "where are the pythons", "v1")).toBe(key);
    expect(answerCacheKey("python", "where are the pythons", "v2")).not.toBe(key);
    const bbox = { west: -80.35, south: 25.35, east: -80.05, north: 25.9 };
    const scoped = answerCacheKey("python", "where are the pythons", "v1", { bbox, now: new Date("2026-01-15T03:01:00Z") });
    expect(answerCacheKey("python", "Where are the pythons", "v1", { bbox, now: new Date("2026-01-15T03:14:59Z") })).toBe(scoped);
    expect(answerCacheKey("python", "Where are the pythons", "v1", { bbox, now: new Date("2026-01-15T03:15:00Z") })).not.toBe(scoped);
    expect(answerCacheKey("python", "Where are the pythons", "v1", { bbox: { ...bbox, west: -80.4 }, now: new Date("2026-01-15T03:01:00Z") })).not.toBe(scoped);
    writeAnswerCache(key, { events: [], content: "x", citations: [] }, 1_000);
    expect(readAnswerCache(key, 1_000 + ANSWER_CACHE_TTL_MS)?.content).toBe("x");
    expect(readAnswerCache(key, 1_001 + ANSWER_CACHE_TTL_MS)).toBeUndefined();
  });
});
