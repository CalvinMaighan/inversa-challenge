import { describe, expect, test } from "bun:test";

import { agentViewFromHud } from "server/voice/agent-runner";

/** spawn_thinking through the real agent runs live: tests/live/agent/voice-runner.test.ts. */

const HUD = {
  camera: { lat: 25.1417, lon: -80.9237, altitudeM: 15_000, place: "Flamingo" },
  bbox: { west: -81.02, south: 25.06, east: -80.83, north: 25.22 },
  time: { at: "2026-09-30T12:00:00.000Z", live: false, playing: false, speed: 8, from: "2026-08-31T12:00:00.000Z", to: "2026-09-30T12:00:00.000Z" },
  layers: ["sightings", "hotspots"],
  species: ["python"],
  selection: "sighting:inat-1",
  drawerOpen: false,
};

describe("default agent runner", () => {
  test("HUD state maps to the agent view input", () => {
    expect(agentViewFromHud(HUD)).toEqual({
      bbox: HUD.bbox,
      time: "2026-09-30T12:00:00.000Z",
      layers: ["sightings", "hotspots"],
      selection: "sighting:inat-1",
    });
    expect(agentViewFromHud(null)).toBeUndefined();
    expect(agentViewFromHud({ bbox: { west: 1 }, time: { at: "2026-09-30T12:00:00Z" } })).toBeUndefined();
    expect(agentViewFromHud({ ...HUD, time: { at: "not a time" } })).toBeUndefined();
  });
});
