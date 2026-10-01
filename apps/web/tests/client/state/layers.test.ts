import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { LAYERS, setLayerSpeciesPin, setLayerVisible, setSpeciesVisible, type LayersState } from "client/state/layers";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

init(state);

describe("LAYERS", () => {
  test("has a visibility entry for every layer id and a filter entry for every species", () => {
    expect(Object.keys(LAYERS.defaults.visible)).toEqual([...LAYER_IDS]);
    expect(Object.keys(LAYERS.defaults.species)).toEqual([...SPECIES_IDS]);
  });

  test("everything is on except the two temperature rasters", () => {
    const hidden = LAYER_IDS.filter((id) => !LAYERS.defaults.visible[id]);
    expect(hidden).toEqual([LAYER_IDS[2], LAYER_IDS[3]]);
    expect(SPECIES_IDS.every((id) => LAYERS.defaults.species[id])).toBe(true);
  });

  test("setLayerVisible and setSpeciesVisible change one entry and leave the rest", () => {
    const [first, second] = LAYER_IDS;
    setLayerVisible(first, false);
    setSpeciesVisible(SPECIES_IDS[1], false);
    const now = get<LayersState>(LAYERS)!;
    expect(now.visible[first]).toBe(false);
    expect(now.visible[second]).toBe(true);
    expect(now.species[SPECIES_IDS[1]]).toBe(false);
    expect(now.species[SPECIES_IDS[0]]).toBe(true);
    // Defaults are never mutated in place.
    expect(LAYERS.defaults.visible[first]).toBe(true);
    set(LAYERS, LAYERS.defaults);
  });

  test("setLayerSpeciesPin pins one layer to one species and unpins with null", () => {
    const hotspots = LAYER_IDS[1];
    const iguana = SPECIES_IDS[2];
    setLayerSpeciesPin(hotspots, iguana);
    expect(get<LayersState>(LAYERS)!.species[hotspots]).toBe(iguana);
    // The species booleans are untouched.
    expect(SPECIES_IDS.every((id) => get<LayersState>(LAYERS)!.species[id])).toBe(true);
    setLayerSpeciesPin(hotspots, null);
    expect(hotspots in get<LayersState>(LAYERS)!.species).toBe(false);
    expect(LAYERS.defaults.species[hotspots]).toBeUndefined();
    set(LAYERS, LAYERS.defaults);
  });
});
