import { describe, expect, test } from "bun:test";

import { agentViewFromHud } from "server/voice/agent-runner";

/** spawn_thinking through the real agent runs live: tests/live/agent/voice-runner.test.ts. */

const HUD = {
  camera: { lat: 25.1417, lon: -80.9237, altitudeM: 15_000, place: "Flamingo" },
  bbox: { west: -81.02, south: 25.06, east: -80.83, north: 25.22 },
  time: { at: "2026-09-30T12:00:00.000Z", live: false, playing: false, speed: 8, from: "2026-08-31T12:00:00.000Z", to: "2026-09-30T12:00:00.000Z" },
  layers: ["sightings", "hotspots"],
  // The python hidden: a filter the agent hears about.
  species: [],
  selection: "sighting:inat-1",
  drawerOpen: false,
};

describe("default agent runner", () => {
  test("HUD state maps to the agent view input", () => {
    expect(agentViewFromHud(HUD, "python")).toEqual({
      bbox: HUD.bbox,
      time: "2026-09-30T12:00:00.000Z",
      layers: ["sightings", "hotspots"],
      species: [],
      selection: "sighting:inat-1",
    });
    // The app's species shown (the default): no filter to pass on.
    expect(agentViewFromHud({ ...HUD, species: ["python"] }, "python")?.species).toBeUndefined();
    expect(agentViewFromHud(null, "python")).toBeUndefined();
    expect(agentViewFromHud({ bbox: { west: 1 }, time: { at: "2026-09-30T12:00:00Z" } }, "python")).toBeUndefined();
    expect(agentViewFromHud({ ...HUD, time: { at: "not a time" } }, "python")).toBeUndefined();
  });

  test("the species filter is read against the voice session's app", () => {
    // Lionfish's one species: python is not one of its keys, so it is dropped; lionfish shown is the default.
    expect(agentViewFromHud({ ...HUD, species: ["python"] }, "lionfish")?.species).toEqual([]);
    expect(agentViewFromHud({ ...HUD, species: ["lionfish", "python"] }, "lionfish")?.species).toBeUndefined();
  });
});
