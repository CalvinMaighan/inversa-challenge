import { describe, expect, test } from "bun:test";

import { agentView, buildAgentRequest, validBBox } from "client/agent/chat/request";
import { REGION_BBOX } from "client/state/view";

const NOW = Date.parse("2026-09-30T12:00:00Z");

describe("agent request view", () => {
  test("reads bbox, time, visible layers and the selection", () => {
    const request = buildAgentRequest(
      "s1",
      "  Where should python crews go tonight?  ",
      {
        view: { bbox: { west: -81, south: 25, east: -80, north: 26 } },
        time: { at: "2026-01-15T03:00:00Z" },
        layers: { visible: { sightings: true, hotspots: true, lst: false, stations: true } },
        selection: { evidenceId: "hotspot:python:243:145:1768446000000" },
      },
      NOW,
    );
    expect(request).toEqual({
      sessionId: "s1",
      question: "Where should python crews go tonight?",
      view: {
        bbox: { west: -81, south: 25, east: -80, north: 26 },
        time: "2026-01-15T03:00:00.000Z",
        layers: ["sightings", "hotspots", "stations"],
        windowHours: 168,
        selection: "hotspot:python:243:145:1768446000000",
      },
    });
  });

  test("missing or unusable fields fall back to the region, the wall clock, the default window and nothing selected", () => {
    expect(agentView({}, NOW)).toEqual({ bbox: { ...REGION_BBOX }, time: "2026-09-30T12:00:00.000Z", layers: [], windowHours: 168, selection: null });
    expect(agentView({ layers: { sightingHours: 48 } }, NOW).windowHours).toBe(48);
    expect(agentView({ layers: { sightingHours: 99 } }, NOW).windowHours).toBe(168);
    // Voice's TIME shape uses at: null for "live".
    expect(agentView({ time: { at: null }, view: { bbox: { west: -80, south: 25, east: -81, north: 26 } } }, NOW)).toMatchObject({
      bbox: { ...REGION_BBOX },
      time: "2026-09-30T12:00:00.000Z",
    });
  });

  test("the species filter travels only when it hides an animal", () => {
    const all = { python: true, tegu: true, iguana: true, lionfish: true, animals: true, plants: false, others: false };
    expect(agentView({ layers: { visible: { sightings: true }, species: all } }, NOW).species).toBeUndefined();
    // Switching plants on hides nothing: no filter travels.
    expect(agentView({ layers: { visible: { sightings: true }, species: { ...all, plants: true } } }, NOW).species).toBeUndefined();
    expect(agentView({ layers: { visible: { sightings: true }, species: { ...all, python: false, tegu: false, lionfish: false, animals: false } } }, NOW).species).toEqual([
      "iguana",
    ]);
    // One animal chip hidden on its own counts as a filter too.
    expect(agentView({ layers: { species: { ...all, t116461: false } } }, NOW).species).toEqual(["python", "tegu", "iguana", "lionfish", "animals"]);
    // A hotspot pin is not a species.
    expect(agentView({ layers: { species: { ...all, hotspots: "python" } } }, NOW).species).toBeUndefined();
  });

  test("bbox validation", () => {
    expect(validBBox({ west: -81, south: 25, east: -80, north: 26 })).toBe(true);
    expect(validBBox({ west: -81, south: 25, east: -80 })).toBe(false);
    expect(validBBox({ west: -81, south: 26, east: -80, north: 25 })).toBe(false);
    expect(validBBox({ west: Number.NaN, south: 25, east: -80, north: 26 })).toBe(false);
    expect(validBBox(null)).toBe(false);
  });
});
