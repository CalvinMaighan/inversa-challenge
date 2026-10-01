import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import {
  LAYERS,
  setLayerSpeciesPin,
  setLayerVisible,
  setSpeciesVisible,
  showAllSpecies,
  showOnlySpecies,
  shownSpecies,
  SPECIES_FILTER_IDS,
  type LayersState,
} from "client/state/layers";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

init(state);

const [SIGHTINGS, HOTSPOTS, LST, SST, STATIONS, ALERTS, MISSIONS, PEERS, NOTES] = LAYER_IDS;
const now = () => get<LayersState>(LAYERS)!;

describe("LAYERS", () => {
  test("has a visibility entry for every layer id and a filter entry for every species plus other", () => {
    expect(Object.keys(LAYERS.defaults.visible)).toEqual([...LAYER_IDS]);
    expect(SPECIES_FILTER_IDS).toEqual([...SPECIES_IDS, "other"]);
    expect(Object.keys(LAYERS.defaults.species)).toEqual([...SPECIES_FILTER_IDS]);
  });

  test("sightings-first defaults: sightings on; stations, alerts, hotspots, lst and sst hidden; team marks and field notes on", () => {
    const on = LAYER_IDS.filter((id) => LAYERS.defaults.visible[id]);
    expect(on).toEqual([SIGHTINGS, MISSIONS, PEERS, NOTES]);
    for (const id of [STATIONS, ALERTS, HOTSPOTS, LST, SST]) expect(LAYERS.defaults.visible[id]).toBe(false);
    expect(SPECIES_FILTER_IDS.every((id) => LAYERS.defaults.species[id])).toBe(true);
  });

  test("setLayerVisible and setSpeciesVisible change one entry and leave the rest", () => {
    setLayerVisible(STATIONS, true);
    setSpeciesVisible(SPECIES_IDS[1], false);
    setSpeciesVisible("other", false);
    expect(now().visible[STATIONS]).toBe(true);
    expect(now().visible[SIGHTINGS]).toBe(true);
    expect(now().species[SPECIES_IDS[1]]).toBe(false);
    expect(now().species.other).toBe(false);
    expect(now().species[SPECIES_IDS[0]]).toBe(true);
    // Defaults are never mutated in place.
    expect(LAYERS.defaults.visible[STATIONS]).toBe(false);
    expect(LAYERS.defaults.species.other).toBe(true);
    set(LAYERS, LAYERS.defaults);
  });

  test("showOnlySpecies keeps one species (and the layer pins); showAllSpecies brings every one back", () => {
    setLayerSpeciesPin(HOTSPOTS, "python");
    showOnlySpecies("iguana");
    expect(shownSpecies(now().species)).toEqual(["iguana"]);
    expect(now().species[HOTSPOTS]).toBe("python");
    showOnlySpecies("other");
    expect(shownSpecies(now().species)).toEqual(["other"]);
    showAllSpecies();
    expect(shownSpecies(now().species)).toEqual([...SPECIES_FILTER_IDS]);
    expect(now().species[HOTSPOTS]).toBe("python");
    // A filter saved before `other` existed reads as every species shown.
    expect(shownSpecies({ python: true, tegu: true, iguana: true, lionfish: true })).toEqual([...SPECIES_FILTER_IDS]);
    set(LAYERS, LAYERS.defaults);
  });

  test("setLayerSpeciesPin pins one layer to one species and unpins with null", () => {
    const iguana = SPECIES_IDS[2];
    setLayerSpeciesPin(HOTSPOTS, iguana);
    expect(now().species[HOTSPOTS]).toBe(iguana);
    // The species booleans are untouched.
    expect(SPECIES_FILTER_IDS.every((id) => now().species[id])).toBe(true);
    setLayerSpeciesPin(HOTSPOTS, null);
    expect(HOTSPOTS in now().species).toBe(false);
    expect(LAYERS.defaults.species[HOTSPOTS]).toBeUndefined();
    set(LAYERS, LAYERS.defaults);
  });
});
