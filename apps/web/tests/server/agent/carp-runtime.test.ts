import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ofType, resetState } from "./helpers";

import { CARP_FIXTURE_NOW } from "@/eval/stub-carp";
import { startStub, type Stub } from "@/eval/stub-server";
import { agentSystemPrompt, viewContext } from "@/server/agent/prompt";
import { runTurn } from "@/server/agent/run-turn";
import { foreignSpeciesPattern, scopeGuard } from "@/server/agent/scope";
import { buildAgentRegistry, CAPABILITY_NAMES } from "@/server/agent/tools/capabilities";
import { isAgentStreamEvent, type AgentStreamEvent } from "@/shared/agent/events";
import { APP_IDS, getApp } from "@/shared/apps";

/**
 * gates/leaf-AG1.md G1: the carp runtime is built from the app config: system prompt (persona, scope, refusal,
 * boundary, demonstration locations, L'CARP, UTC and Central time, "known at time T"), tool allowlist, scope
 * guard and refusal text.
 */

const CARP = getApp("carp");
const PROMPT = agentSystemPrompt(CARP);
const NOW = new Date(CARP_FIXTURE_NOW);

let stub: Stub;
let dataDir: string;
const savedKey = process.env.OPENROUTER_API_KEY;

beforeAll(() => {
  stub = startStub();
  dataDir = mkdtempSync(join(tmpdir(), "inversa-carp-runtime-"));
  process.env.INVERSA_API_ORIGIN = stub.origin;
  process.env.INVERSA_DATA_DIR = dataDir;
});

afterAll(() => {
  if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
  else delete process.env.OPENROUTER_API_KEY;
  stub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetState();
  stub.requests.length = 0;
});

describe("agent carp", () => {
  test("agent carp: the system prompt is the config's persona, scope and refusal, then the shared and conditions rules, with no species or hotspot rules", () => {
    expect(PROMPT.startsWith(CARP.agent.persona)).toBe(true);
    expect(PROMPT).toContain(CARP.agent.scope);
    expect(PROMPT).toContain(CARP.agent.refusal);
    expect(PROMPT).toContain("## Boundary (conditions only)");
    expect(PROMPT).toContain("## Units, sources, times");
    expect(PROMPT).toContain("## Knowledge time (replay)");
    expect(PROMPT).not.toContain("## Hotspots");
    expect(PROMPT).not.toContain("## Species");
    expect(agentSystemPrompt(getApp("python"))).not.toContain("## Boundary (conditions only)");
    // Static per app: no per-turn values, so the provider's prompt cache holds.
    expect(PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(agentSystemPrompt(CARP)).toBe(PROMPT);
  });

  test("agent carp: the boundary names conditions only (no abundance, catch, access, trip safety), the demonstration locations and L'CARP in the Atchafalaya Basin for silver, grass, bighead and black carp", () => {
    expect(PROMPT).toContain(CARP.copy.boundaryNote!);
    for (const word of ["abundance", "catch", "legal access", "trip safety"]) expect(PROMPT.toLowerCase()).toContain(word);
    expect(PROMPT).toMatch(/Never say a site is safe or unsafe/);
    expect(PROMPT).toMatch(/never give a chance or percent of flooding/);
    expect(PROMPT).toMatch(/never claim that water conditions cause fish to move/);
    expect(PROMPT).toContain("demonstration locations");
    for (const site of CARP.locations) expect(PROMPT).toContain(`${site.nwps} ${site.name}`);
    expect(PROMPT).toMatch(/L'CARP/);
    expect(PROMPT).toMatch(/Atchafalaya Basin/);
    expect(PROMPT).toMatch(/silver, grass, bighead and black carp/);
    expect(PROMPT).toMatch(/It cannot say where carp are or what moves them/);
  });

  test("agent carp: UTC and Central time handling, the four times, units with their sources, and 'known at time T' semantics are stated", () => {
    expect(PROMPT).toMatch(/tool times are UTC \(Z\)/);
    expect(PROMPT).toContain("America/Chicago");
    expect(PROMPT).toMatch(/24-hour clock, zone right after/);
    expect(PROMPT).toMatch(/Units as the tools label them \(ft, cfs, kcfs, °F, mph\)/);
    expect(PROMPT).not.toMatch(/Metric units/);
    expect(PROMPT).toMatch(/observed \(when the gauge measured\), issued \(when the RFC published the forecast\), valid \(when a forecast point applies\), ingested\/fetched/);
    expect(PROMPT).toMatch(/pass asOf = T/);
    expect(PROMPT).toMatch(/answer only from what was known at T/i);
    expect(PROMPT).toMatch(/As of <T local>, we knew/);
    expect(PROMPT).toMatch(/never present a replay \(as-of\) value as live/);
    expect(PROMPT).toMatch(/USGS discharge in cfs, NWPS flow in kcfs/);
    expect(PROMPT).toMatch(/never average or blend them/);
    expect(PROMPT).toMatch(/never compare a USGS stage with a flood threshold/);
    expect(PROMPT).toMatch(/replayCoverageStart/);
    expect(PROMPT).toMatch(/preset all-sites \(All sites\), atchafalaya/);
  });

  test("agent carp: the view context carries the selected site, the knowledge time and the replay flag", () => {
    const base = { bbox: { west: -94, south: 28.9, east: -88.8, north: 32.9 }, time: CARP_FIXTURE_NOW, layers: ["stations"], selection: null };
    const live = viewContext(base, NOW, CARP);
    expect(live).toContain("Local time is America/Chicago.");
    expect(live).toContain("Selected site: none");
    expect(live).toContain("Timeline mode: live.");
    expect(live).not.toContain("Sightings on the globe");
    const replay = viewContext({ ...base, site: "MCGL1", asOf: Date.parse("2026-09-30T20:00:00Z"), replay: true }, NOW, CARP);
    expect(replay).toContain("Selected site: MCGL1 Atchafalaya River at Morgan City");
    expect(replay).toContain("Timeline mode: replay, knowledge time 2026-09-30T20:00:00.000Z (asOf)");
    expect(viewContext({ ...base, replay: true }, NOW, CARP)).toContain("Timeline mode: replay at the timeline time.");
  });

  test("agent carp: the tool allowlist is the config's; the river tools are offered to conditions apps only, the shared tools to all", () => {
    const names = buildAgentRegistry(CARP).list().map((cap) => cap.name);
    expect([...names].sort()).toEqual([...CARP.agent.tools].sort());
    for (const tool of ["site_status", "river_readings", "river_forecast", "forecast_verify", "review_history", "weather_forecast", "source_info", "evidence", "team_board", "alerts", "feed_state", "notes", "set_view"]) {
      expect(names).toContain(tool);
      expect(CAPABILITY_NAMES).toContain(tool);
    }
    for (const off of ["sightings", "species_counts", "hotspots", "explain_cell", "backtest", "conditions", "geocode"]) expect(names).not.toContain(off);
    for (const id of APP_IDS.filter((a) => a !== "carp")) {
      const app = getApp(id);
      expect(() => buildAgentRegistry({ ...app, agent: { ...app.agent, tools: [...app.agent.tools, "river_forecast"] } })).toThrow(/unknown tools: river_forecast/);
      expect(buildAgentRegistry({ ...app, agent: { ...app.agent, tools: [...app.agent.tools, "source_info", "evidence", "team_board"] } }).get("team_board")).toBeDefined();
    }
  });

  test("agent carp: the scope guard is built from the other apps' taxa and refuses before any model call", async () => {
    const pattern = foreignSpeciesPattern(CARP)!;
    expect(pattern.test("Where are Burmese pythons active in the Everglades?")).toBe(true);
    expect(pattern.test("Any lionfish near Key Largo?")).toBe(true);
    expect(pattern.test("Which locations need operational review today?")).toBe(false);
    expect(pattern.test("How much water is the Atchafalaya carrying at Simmesport?")).toBe(false);
    expect(scopeGuard(CARP, "Where are Burmese pythons active in the Everglades?")).toContain(CARP.agent.refusal);
    expect(scopeGuard(CARP, "What is the river stage at Krotz Springs right now?")).toBeNull();
    // Python's own species pass its guard; carp (no taxa) is not a foreign species anywhere.
    expect(scopeGuard(getApp("python"), "Show me recent tegu sightings around Homestead.")).toBeNull();
    expect(scopeGuard(getApp("lionfish"), "How many iguanas were reported around Marathon?")).toContain(getApp("lionfish").agent.refusal);

    process.env.OPENROUTER_API_KEY = "test-key-never-used";
    const events: AgentStreamEvent[] = [];
    const result = await runTurn({ app: "carp", sessionId: `guard-${Date.now()}`, question: "Where are Burmese pythons active in the Everglades?", now: NOW, cache: false }, (e) => events.push(e));
    expect(result.model).toBe("scope-guard");
    expect(result.content).toContain("Python app");
    expect(result.content).toContain("Louisiana");
    expect(result.toolCalls).toEqual([]);
    expect(events.every(isAgentStreamEvent)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", content: result.content });
    expect(ofType(events, "tool_start")).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
  });

  test("agent carp: the prompt and the turn context never carry a supported-question hint (the benchmark is blind)", () => {
    expect(PROMPT).not.toContain("Supported question");
    expect(viewContext(undefined, NOW, CARP)).not.toMatch(/supported question|call .* then/i);
  });

  test("agent carp: the refusal text is the config's and names what the app covers", () => {
    expect(CARP.agent.refusal).toMatch(/eight Louisiana demonstration locations/);
    expect(CARP.agent.refusal).toMatch(/cannot estimate carp abundance, expected catch, legal access or trip safety/);
    expect(PROMPT).toContain(`"${CARP.agent.refusal}"`);
  });
});
