import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import {
  isSpeciesFiltered,
  LAYERS,
  setLayerSpeciesPin,
  setLayerVisible,
  setSightingHours,
  setSpeciesVisible,
  setTaxonVisible,
  showAllSpecies,
  showOnlySpecies,
  showOnlyTaxon,
  shownSpecies,
  sightingHoursOf,
  SPECIES_FILTER_IDS,
  SPECIES_GROUP_IDS,
  taxonKey,
  taxonOverrides,
  type LayersState,
} from "client/state/layers";
import { SIGHTING_WINDOW_HOURS, SIGHTING_WINDOW_OPTIONS } from "shared/frames";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

init(state);

const [SIGHTINGS, HOTSPOTS, LST, SST, STATIONS, ALERTS, MISSIONS, PEERS, NOTES] = LAYER_IDS;
const now = () => get<LayersState>(LAYERS)!;

describe("LAYERS", () => {
  test("has a visibility entry for every layer id and a filter entry for every focus species plus the three groups", () => {
    expect(Object.keys(LAYERS.defaults.visible)).toEqual([...LAYER_IDS]);
    expect(SPECIES_GROUP_IDS).toEqual(["animals", "plants", "others"]);
    expect(SPECIES_FILTER_IDS).toEqual([...SPECIES_IDS, ...SPECIES_GROUP_IDS]);
    expect(Object.keys(LAYERS.defaults.species)).toEqual([...SPECIES_FILTER_IDS]);
  });

  test("sightings-first defaults: sightings on; stations, alerts, hotspots, lst and sst hidden; team marks and field notes on; every animal on, plants and insects off; 7-day window", () => {
    const on = LAYER_IDS.filter((id) => LAYERS.defaults.visible[id]);
    expect(on).toEqual([SIGHTINGS, MISSIONS, PEERS, NOTES]);
    for (const id of [STATIONS, ALERTS, HOTSPOTS, LST, SST]) expect(LAYERS.defaults.visible[id]).toBe(false);
    expect(SPECIES_IDS.every((id) => LAYERS.defaults.species[id])).toBe(true);
    expect(LAYERS.defaults.species.animals).toBe(true);
    expect(LAYERS.defaults.species.plants).toBe(false);
    expect(LAYERS.defaults.species.others).toBe(false);
    expect(LAYERS.defaults.sightingHours).toBe(SIGHTING_WINDOW_HOURS);
    expect(SIGHTING_WINDOW_HOURS).toBe(168);
    expect(SIGHTING_WINDOW_OPTIONS).toEqual([48, 168, 720]);
    expect(isSpeciesFiltered(LAYERS.defaults.species)).toBe(false);
  });

  test("setLayerVisible and setSpeciesVisible change one entry and leave the rest", () => {
    setLayerVisible(STATIONS, true);
    setSpeciesVisible(SPECIES_IDS[1], false);
    setSpeciesVisible("plants", true);
    expect(now().visible[STATIONS]).toBe(true);
    expect(now().visible[SIGHTINGS]).toBe(true);
    expect(now().species[SPECIES_IDS[1]]).toBe(false);
    expect(now().species.plants).toBe(true);
    expect(now().species[SPECIES_IDS[0]]).toBe(true);
    expect(isSpeciesFiltered(now().species)).toBe(true);
    // Defaults are never mutated in place.
    expect(LAYERS.defaults.visible[STATIONS]).toBe(false);
    expect(LAYERS.defaults.species.plants).toBe(false);
    set(LAYERS, LAYERS.defaults);
  });

  test("taxon overrides: one chip off on its own, 'only this one', and All drops the overrides", () => {
    setTaxonVisible(116461, false);
    expect(now().species[taxonKey(116461)]).toBe(false);
    expect(taxonOverrides(now().species)).toEqual([[116461, false]]);
    expect(isSpeciesFiltered(now().species)).toBe(true);
    setTaxonVisible(116461, null);
    expect(taxonKey(116461) in now().species).toBe(false);
    expect(isSpeciesFiltered(now().species)).toBe(false);

    setSpeciesVisible("plants", true);
    showOnlyTaxon(24382);
    // "Only this one" switches every key off (plants included) and keeps one override on.
    expect(shownSpecies(now().species)).toEqual([]);
    expect(taxonOverrides(now().species)).toEqual([[24382, true]]);
    showAllSpecies();
    expect(shownSpecies(now().species)).toEqual([...SPECIES_IDS, "animals"]);
    expect(taxonOverrides(now().species)).toEqual([]);
    set(LAYERS, LAYERS.defaults);
  });

  test("showOnlySpecies keeps one species (and the layer pins); showAllSpecies brings every animal back and keeps the plant switch", () => {
    setLayerSpeciesPin(HOTSPOTS, "python");
    showOnlySpecies("iguana");
    expect(shownSpecies(now().species)).toEqual(["iguana"]);
    expect(now().species[HOTSPOTS]).toBe("python");
    showOnlySpecies("plants");
    expect(shownSpecies(now().species)).toEqual(["plants"]);
    showAllSpecies();
    expect(shownSpecies(now().species)).toEqual([...SPECIES_IDS, "animals", "plants"]);
    expect(now().species[HOTSPOTS]).toBe("python");
    // A filter saved before the groups existed reads as the defaults for them.
    expect(shownSpecies({ python: true, tegu: true, iguana: true, lionfish: true })).toEqual([...SPECIES_IDS, "animals"]);
    set(LAYERS, LAYERS.defaults);
  });

  test("setLayerSpeciesPin pins one layer to one species and unpins with null", () => {
    const iguana = SPECIES_IDS[2];
    setLayerSpeciesPin(HOTSPOTS, iguana);
    expect(now().species[HOTSPOTS]).toBe(iguana);
    // The species booleans are untouched.
    expect(SPECIES_IDS.every((id) => now().species[id])).toBe(true);
    setLayerSpeciesPin(HOTSPOTS, null);
    expect(HOTSPOTS in now().species).toBe(false);
    expect(LAYERS.defaults.species[HOTSPOTS]).toBeUndefined();
    set(LAYERS, LAYERS.defaults);
  });

  test("the sightings window is one of 2, 7 or 30 days; anything else reads as the default", () => {
    setSightingHours(48);
    expect(now().sightingHours).toBe(48);
    expect(sightingHoursOf(now())).toBe(48);
    setSightingHours(720);
    expect(sightingHoursOf(now())).toBe(720);
    expect(sightingHoursOf({ sightingHours: 99 as never })).toBe(SIGHTING_WINDOW_HOURS);
    expect(sightingHoursOf(undefined)).toBe(SIGHTING_WINDOW_HOURS);
    set(LAYERS, LAYERS.defaults);
  });
});
