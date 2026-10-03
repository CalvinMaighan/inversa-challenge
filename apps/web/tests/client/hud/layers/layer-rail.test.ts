import { describe, expect, test } from "bun:test";

import { activeLayers } from "client/hud/layers/LayerRail";
import { layersFor } from "client/state/layers";
import { getApp } from "shared/apps";

const reefOff = { heat: false, mode: "dhw" } as const;

describe("layer rail", () => {
  test("a fresh app has only sightings on, so the rail starts with one button", () => {
    for (const id of ["lionfish", "python"] as const) {
      const app = getApp(id);
      expect(activeLayers(app, layersFor(app), reefOff, true).map((l) => l.id)).toEqual(["sightings"]);
    }
  });

  test("carp's sightings are the fish dots: one button while they show, none once hidden", () => {
    const app = getApp("carp");
    expect(activeLayers(app, layersFor(app), reefOff, true).map((l) => l.id)).toEqual(["sightings"]);
    expect(activeLayers(app, layersFor(app), reefOff, false)).toEqual([]);
  });

  test("every layer that is switched on gets a button, in the panel's order: sightings, reef heat, then the overlays", () => {
    const app = getApp("lionfish");
    const layers = layersFor(app);
    layers.visible.radar = true;
    layers.visible["sst-map"] = true;
    const ids = activeLayers(app, layers, { heat: true, mode: "temp" }, true).map((l) => l.id);
    expect(ids).toEqual(["sightings", "reef", "sst-map", "radar"]);
  });

  test("each button knows how to switch its layer off", () => {
    const app = getApp("python");
    const layers = layersFor(app);
    layers.visible.lightning = true;
    const rail = activeLayers(app, layers, reefOff, true);
    expect(rail.map((l) => l.id)).toEqual(["sightings", "lightning"]);
    for (const l of rail) {
      expect(typeof l.off).toBe("function");
      expect(l.label.length).toBeGreaterThan(2);
      expect(l.blurb.length).toBeGreaterThan(8);
    }
  });

  test("the reef heat map is only a lionfish layer", () => {
    const app = getApp("python");
    expect(activeLayers(app, layersFor(app), { heat: true, mode: "dhw" }, true).map((l) => l.id)).toEqual(["sightings"]);
  });
});
