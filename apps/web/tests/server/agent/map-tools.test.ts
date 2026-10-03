import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSystemPrompt } from "@/server/agent/prompt";
import type { CapabilityContext } from "@/server/agent/runtime/registry";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { uiToolsFor } from "@/server/voice/voice-prompt";
import type { AgentStreamEvent } from "@/shared/agent/events";
import { getApp } from "@/shared/apps";
import { LOOK_IDS } from "@/shared/look";
import { parseUiCommand, uiToolSchemasFor, UI_TOOL_NAMES } from "@/shared/voice/ui-tools";

/**
 * GE7 G6: the agent knows the map. `toggle_layer` and `set_look` (the voice's UI tools, one schema) reach the browser
 * as the stream's `ui` event; `vessels` reads AIS tracks and cites `vessel:<mmsi>`. The GraphQL side is a local
 * stub answering with the recorded AISStream position report (api/tests/fixtures/ais/position_report.json).
 */

const CARP = getApp("carp");
const PYTHON = getApp("python");
const LIONFISH = getApp("lionfish");
const NOW = new Date("2026-10-01T18:00:00Z");
const FRAME = JSON.parse(readFileSync(join(import.meta.dir, "../../../../../api/tests/fixtures/ais/position_report.json"), "utf8")) as {
  Message: { PositionReport: { UserID: number; Latitude: number; Longitude: number; Sog: number; Cog: number; TrueHeading: number } };
  MetaData: { ShipName: string };
};

let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
const asked: { operationName: string; variables: Record<string, unknown> }[] = [];
const emitted: AgentStreamEvent[] = [];
const ctxFor = (app = CARP): CapabilityContext => ({ app, now: NOW, emit: (e) => emitted.push(e) });

beforeAll(() => {
  const p = FRAME.Message.PositionReport;
  const track = {
    mmsi: String(p.UserID),
    name: FRAME.MetaData.ShipName.trim(),
    type: "cargo",
    points: [
      { at: new Date(NOW.getTime() - 90 * 60_000).toISOString(), lat: 29.3, lon: -91.4, sog: p.Sog, cog: p.Cog, heading: p.TrueHeading },
      { at: new Date(NOW.getTime() - 20 * 60_000).toISOString(), lat: 29.31, lon: -91.38, sog: 6.2, cog: 88, heading: 90 },
    ],
  };
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { operationName: string; variables: Record<string, unknown> };
      asked.push({ operationName: body.operationName, variables: body.variables });
      const feeds = [{ source: "aisstream", mode: "PUSH", state: "NOMINAL", newestObservedAt: track.points[1]!.at, lastFetchAt: track.points[1]!.at, lagSeconds: 1200, note: null, lastFetchRunId: null }];
      return Response.json({ data: { vessels: [track], feeds } });
    },
  });
  dataDir = mkdtempSync(join(tmpdir(), "inversa-map-tools-"));
  process.env.INVERSA_API_ORIGIN = `http://127.0.0.1:${server.port}`;
  process.env.INVERSA_DATA_DIR = dataDir;
});

afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  asked.length = 0;
  emitted.length = 0;
});

describe("set_look schema", () => {
  test("set_look schema: the seven looks parse, anything else is refused, in every app", () => {
    expect(UI_TOOL_NAMES).toContain("set_look");
    for (const app of [PYTHON, CARP, LIONFISH]) {
      for (const look of LOOK_IDS) expect(parseUiCommand("set_look", { look }, app)).toEqual({ name: "set_look", args: { look } });
      expect(parseUiCommand("set_look", { look: "thermal" }, app)).toBeNull();
      expect(parseUiCommand("set_look", {}, app)).toBeNull();
    }
    expect(uiToolSchemasFor(CARP).set_look.safeParse({ look: "nvg" }).success).toBe(true);
  });

  test("set_look schema: the voice offers set_look with the seven looks in its JSON schema", () => {
    const tool = uiToolsFor(CARP).find((t) => t.name === "set_look")!;
    expect(tool.description).toContain("night vision");
    expect(JSON.stringify(tool.parameters)).toContain('"nvg"');
  });
});

describe("agent map tools", () => {
  test("agent map tools: every app registers toggle_layer and set_look, and none the ships tool (ships were removed)", () => {
    const names = (app: typeof CARP) => buildAgentRegistry(app).list().map((c) => c.name);
    for (const app of [CARP, LIONFISH, PYTHON]) {
      for (const n of ["toggle_layer", "set_look"]) expect(names(app)).toContain(n);
      expect(names(app)).not.toContain("vessels");
    }
  });

  test("agent map tools: toggle_layer emits a validated ui event for the app's own layer, and refuses another app's", async () => {
    // Carp has no hotspots layer: the schema offers none, so the switch is refused.
    const refused = await buildAgentRegistry(CARP).execute("toggle_layer", { layer: "hotspots", visible: true }, ctxFor());
    expect(refused.ok).toBe(false);
    expect(emitted).toEqual([]);
    // Python lists it: the same switch goes through.
    const py = await buildAgentRegistry(PYTHON).execute("toggle_layer", { layer: "hotspots", visible: true }, ctxFor(PYTHON));
    expect(py.ok).toBe(true);
    expect(emitted).toEqual([{ type: "ui", name: "toggle_layer", args: { layer: "hotspots", visible: true } }]);
  });

  test("agent map tools: set_look emits the look as a ui event", async () => {
    const out = await buildAgentRegistry(LIONFISH).execute("set_look", { look: "nvg" }, ctxFor(LIONFISH));
    expect(out.ok).toBe(true);
    expect(emitted).toEqual([{ type: "ui", name: "set_look", args: { look: "nvg" } }]);
  });

  test("agent map tools: the prompt lists what each app can toggle, the water and weather layers, the vessel citation rule and the looks", () => {
    const carp = agentSystemPrompt(CARP);
    expect(carp).toContain("## The map: layers, ships and looks");
    // Ships are no longer a layer of any app.
    expect(carp).not.toContain("vessels (Ships (AIS))");
    for (const id of ["sst-map", "radar", "lightning", "cyclones"]) expect(carp).toContain(`${id} (`);
    expect(carp).not.toContain("[e:vessel:<mmsi>]");
    expect(carp).toContain("nvg (night vision");
    const python = agentSystemPrompt(PYTHON);
    expect(python).toContain("## The map: layers, ships and looks");
    expect(python).not.toContain("[e:vessel:<mmsi>]");
    expect(python).not.toContain("vessels (Ships");
  });
});
