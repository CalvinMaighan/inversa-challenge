import { describe, expect, test } from "bun:test";

import { railLayers } from "client/hud/layers/LayerRail";
import { layersFor } from "client/state/layers";
import { getApp } from "shared/apps";

const idsOf = (rail: { id: string }[]) => rail.map((l) => l.id);
const onIds = (rail: { id: string; on: boolean }[]) => rail.filter((l) => l.on).map((l) => l.id);

describe("layer rail", () => {
  test("a button for every layer the app can show, in the Layers panel's order; only sightings is on at first", () => {
    const lion = getApp("lionfish");
    const rail = railLayers(lion, layersFor(lion), { heat: false }, true);
    expect(idsOf(rail)).toEqual(["sightings", "reef", "sst-map", "radar", "lightning", "cyclones"]);
    expect(onIds(rail)).toEqual(["sightings"]);
    const py = getApp("python");
    expect(idsOf(railLayers(py, layersFor(py), { heat: false }, true))).toEqual(["sightings", "radar", "lightning", "cyclones"]);
    expect(onIds(railLayers(py, layersFor(py), { heat: false }, true))).toEqual(["sightings"]);
  });

  test("carp's sightings are the fish dots; the reef heat map is only a lionfish layer", () => {
    const carp = getApp("carp");
    expect(idsOf(railLayers(carp, layersFor(carp), { heat: true }, true))).toEqual(["sightings", "sst-map", "radar", "lightning", "cyclones"]);
    expect(onIds(railLayers(carp, layersFor(carp), { heat: false }, false))).toEqual([]);
    expect(onIds(railLayers(carp, layersFor(carp), { heat: false }, true))).toEqual(["sightings"]);
    const py = getApp("python");
    expect(idsOf(railLayers(py, layersFor(py), { heat: true }, true))).not.toContain("reef");
  });

  test("a layer that is switched on shows as on, and a click is a toggle", () => {
    const lion = getApp("lionfish");
    const layers = layersFor(lion);
    layers.visible.radar = true;
    const rail = railLayers(lion, layers, { heat: true }, true);
    expect(onIds(rail)).toEqual(["sightings", "reef", "radar"]);
    for (const l of rail) expect(typeof l.toggle).toBe("function");
    expect(rail.every((l) => l.label.length > 2)).toBe(true);
  });
});
