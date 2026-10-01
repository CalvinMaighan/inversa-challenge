import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { focusPanel, frameCamera, hoverEvidence, showTurn, turnFocus } from "client/agent/panels/effects";
import { frameBox, highlightTargets, MAX_HIGHLIGHT, panelsFromToolEnd } from "client/agent/panels/model";
import { clearPanels, panelsOf, recordToolEnd } from "client/agent/panels/store";
import { registerGlobe, type CameraTarget } from "client/globe/api";
import { AGENT_HIGHLIGHT, TIME, state } from "client/state";
import type { AgentHighlightState } from "client/state/agent";
import type { TimeState } from "client/state/time";
import { cellsView, conditionsViews, sightingsView, type ReadingRow, type SightingRow } from "@/server/agent/tools/views";
import type { AgentStreamEvent } from "shared/agent/events";

init(state);

const H = 3_600_000;
const NOW = Date.parse("2026-09-30T21:00:00Z");
const HOMESTEAD = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };
const AROUND = { west: -80.81, south: 25.13, east: -80.08, north: 25.81 };
let flights: CameraTarget[] = [];

const sighting = (id: number, lat: number, lon: number, observedAt = "2026-09-02T18:09:00Z"): SightingRow => ({
  evidenceId: `sighting:${id}`,
  species: "Burmese python",
  source: "inat",
  quality: "research",
  observedAt,
  lat,
  lon,
  duplicateOf: null,
  idConflict: false,
});

const gauge = (id: string, lat: number, lon: number, t: number, value: number): ReadingRow => ({
  evidenceId: `reading:${id}:stage_m:${t}:measured`,
  stationId: id,
  station: `Gauge ${id}`,
  source: "usgs",
  lat,
  lon,
  param: "stage_m",
  value,
  flag: "ok",
  origin: "measured",
  observedAt: new Date(t).toISOString(),
});

function toolEnd(toolCallId: string, capabilityName: string, view: object): AgentStreamEvent {
  return { type: "tool_end", toolCallId, capabilityName, ok: true, data: { count: 1, evidence: [], feeds: [], ...view } };
}

/** The e2e question's shape: python sightings near Homestead, and the nearest water-level gauges. */
function recordHomesteadTurn(turnId: string) {
  const t = Date.parse("2026-09-30T20:00:00Z");
  const gauges = [gauge("7", 25.327, -80.525, t, 0.81), gauge("19", 25.731, -80.162, t, 0.61)];
  const history = gauges.flatMap((g) => [0, 1, 2].map((i) => ({ ...g, observedAt: new Date(t - i * H).toISOString() })));
  recordToolEnd(turnId, toolEnd("c1", "conditions", conditionsViews(history, gauges, AROUND, ["stage_m"], "nearest stations within 0.25°")));
  recordToolEnd(turnId, toolEnd("s1", "sightings", sightingsView([sighting(7, 25.554, -80.347)], HOMESTEAD, "Python sightings")));
}

beforeEach(() => {
  flights = [];
  clearPanels();
  registerGlobe({ flyTo: (target) => flights.push(target), project: () => null, pick: () => null, onPostRender: () => () => {}, requestRender: () => {} });
  set<AgentHighlightState>(AGENT_HIGHLIGHT, AGENT_HIGHLIGHT.defaults);
  set<TimeState>(TIME, { at: "2026-09-30T21:00:00.000Z", from: "2026-08-31T21:00:00.000Z", to: "2026-09-30T21:00:00.000Z", playing: true, speed: 8 });
});

afterEach(() => registerGlobe(null));

describe("agent highlight", () => {
  test("highlight: a turn's targets are unique, the primary panel's first, capped at 50, with row positions", () => {
    const many = sightingsView(
      Array.from({ length: 80 }, (_, i) => sighting(i, 25.4 + i / 1000, -80.4)),
      HOMESTEAD,
      "t",
    );
    const cells = cellsView("python", "2026-01-15T03:00:00Z", [{ cell: "243:145", lat: 25.755, lon: -80.765, score: 0.82, evidenceId: "hotspot:python:243:145:1768446000000" }], HOMESTEAD);
    const panels = [
      ...panelsFromToolEnd("s", "sightings", many),
      ...panelsFromToolEnd("s-again", "sightings", sightingsView([sighting(3, 25.403, -80.4)], HOMESTEAD, "t")),
      ...panelsFromToolEnd("h", "hotspots", cells),
    ];
    const primary = turnFocus(panels).primary;
    expect(panels[primary]!.capabilityName).toBe("hotspots");
    const targets = highlightTargets(panels, primary);
    expect(targets).toHaveLength(MAX_HIGHLIGHT);
    expect(targets[0]).toEqual({ id: "hotspot:python:243:145:1768446000000", label: "python 243:145 · 0.82", lon: -80.765, lat: 25.755 });
    expect(new Set(targets.map((t) => t.id)).size).toBe(MAX_HIGHLIGHT);
    expect(targets[1]).toMatchObject({ id: "sighting:0", label: "Burmese python · research", lat: 25.4, lon: -80.4 });
  });

  test("highlight: the camera box grows the result's area to take in every bracket", () => {
    const box = frameBox(HOMESTEAD, [
      { id: "a", label: "", lon: -80.162, lat: 25.731 },
      { id: "b", label: "" },
    ])!;
    expect(box.west).toBe(HOMESTEAD.west);
    expect(box.east).toBeCloseTo(-80.142, 6);
    expect(box.north).toBeCloseTo(25.751, 6);
    expect(frameBox(undefined, [])).toBeNull();
  });

  test("highlight: a finished turn writes AGENT_HIGHLIGHT, frames every bracket once, and moves TIME to the sighting", () => {
    recordHomesteadTurn("turn-1");
    expect(panelsOf("turn-1").map((p) => `${p.capabilityName}:${p.view.view}`)).toEqual(["conditions:series", "conditions:table", "sightings:table"]);
    showTurn("turn-1", NOW);
    const hl = get<AgentHighlightState>(AGENT_HIGHLIGHT)!;
    expect(hl.turnId).toBe("turn-1");
    // Sightings outrank conditions: the python first, then one bracket per gauge.
    expect(hl.targets.map((t) => t.id)).toEqual([
      "sighting:7",
      "reading:7:stage_m:1790798400000:measured",
      "reading:19:stage_m:1790798400000:measured",
    ]);
    expect(hl.targets.every((t) => t.lon !== undefined && t.lat !== undefined)).toBe(true);
    expect(flights).toHaveLength(1);
    // The Homestead box grown to Virginia Key's gauge, north-east of it.
    expect(flights[0]).toEqual(frameCamera({ west: -80.56, south: 25.307, east: -80.142, north: 25.751 }));
    const time = get<TimeState>(TIME)!;
    expect(time.at).toBe("2026-09-02T18:15:00.000Z");
    expect(time.playing).toBe(false);
  });

  test("highlight: opening a panel re-frames it and brings its turn's brackets back", () => {
    recordHomesteadTurn("turn-2");
    set<AgentHighlightState>(AGENT_HIGHLIGHT, { turnId: "other", targets: [], hover: null });
    const series = panelsOf("turn-2")[0]!;
    focusPanel("turn-2", series, NOW);
    expect(get<AgentHighlightState>(AGENT_HIGHLIGHT)!.turnId).toBe("turn-2");
    expect(get<AgentHighlightState>(AGENT_HIGHLIGHT)!.targets).toHaveLength(3);
    expect(flights).toHaveLength(1);
    // The gauges' area, not the sighting's; the readings are within the 24 h trail, so TIME stays.
    expect(flights[0]).toEqual(frameCamera(AROUND));
    expect(get<TimeState>(TIME)!.at).toBe("2026-09-30T21:00:00.000Z");
  });

  test("highlight: hovering a row sets the pulse target with its position; leaving clears it", () => {
    recordHomesteadTurn("turn-3");
    showTurn("turn-3", NOW);
    hoverEvidence("turn-3", "sighting:7");
    expect(get<AgentHighlightState>(AGENT_HIGHLIGHT)!.hover).toEqual({ id: "sighting:7", label: "Burmese python · research", lon: -80.347, lat: 25.554 });
    const before = get<AgentHighlightState>(AGENT_HIGHLIGHT);
    hoverEvidence("turn-3", "sighting:7");
    expect(get<AgentHighlightState>(AGENT_HIGHLIGHT)).toBe(before);
    hoverEvidence("turn-3", null);
    expect(get<AgentHighlightState>(AGENT_HIGHLIGHT)!.hover).toBeNull();
    expect(get<AgentHighlightState>(AGENT_HIGHLIGHT)!.targets).toHaveLength(3);
  });

  test("highlight: failed tool calls and turns without views change nothing", () => {
    expect(recordToolEnd("turn-4", { type: "tool_end", toolCallId: "x", capabilityName: "sightings", ok: false, error: "boom" })).toBe(false);
    expect(recordToolEnd("turn-4", toolEnd("g", "geocode", { name: "Homestead" }))).toBe(false);
    showTurn("turn-4", NOW);
    expect(get<AgentHighlightState>(AGENT_HIGHLIGHT)).toEqual(AGENT_HIGHLIGHT.defaults);
    expect(flights).toHaveLength(0);
  });
});
