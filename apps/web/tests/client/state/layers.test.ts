import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { isSpeciesFiltered, LAYERS, setLayerVisible, setSpeciesVisible, shownSpecies, sightingHoursOf, layersFor, type LayersState } from "client/state/layers";
import { SIGHTING_WINDOW_HOURS, SIGHTING_WINDOW_OPTIONS } from "shared/frames";
import { applyApp } from "client/state/app-switch";
import { getApp, speciesIds } from "shared/apps";
import { LAYER_IDS } from "shared/voice/ui-tools";

init(state);
// These tests run in the python app (one focus species, every layer); the carp default is checked below.
applyApp("python");
const PYTHON = getApp("python");
const SPECIES_IDS = speciesIds(PYTHON);
/** Python's LAYERS preset. */
const PY = layersFor(PYTHON);

const [SIGHTINGS, HOTSPOTS, LST, SST, STATIONS, ALERTS, MISSIONS, PEERS, NOTES] = LAYER_IDS;
const now = () => get<LayersState>(LAYERS)!;

describe("LAYERS per app", () => {
  test("active app: LAYERS starts as carp's (the default app): alerts on, gauge readings off, no sightings, no species", () => {
    const carp = LAYERS.defaults;
    expect(LAYER_IDS.filter((id) => carp.visible[id])).toEqual(["alerts", "missions", "peers", "notes"]);
    expect(carp.species).toEqual({});
  });

  test("lionfish lists its one species and no land-surface layer; its window is 30 days", () => {
    const lionfish = layersFor(getApp("lionfish"));
    expect(lionfish.species).toEqual({ lionfish: true });
    expect(lionfish.visible.lst).toBe(false);
    expect(lionfish.visible.sightings).toBe(true);
    expect(lionfish.sightingHours).toBe(720);
  });
});

describe("LAYERS", () => {
  test("has a visibility entry for every layer id and a filter entry for the app's one species", () => {
    expect(Object.keys(PY.visible)).toEqual([...LAYER_IDS]);
    expect(SPECIES_IDS).toEqual(["python"]);
    expect(PY.species).toEqual({ python: true });
  });

  test("sightings-first defaults: sightings on; stations, alerts, hotspots, lst and sst hidden; team marks and field notes on; the python shown; 7-day window", () => {
    const on = LAYER_IDS.filter((id) => PY.visible[id]);
    expect(on).toEqual([SIGHTINGS, MISSIONS, PEERS, NOTES]);
    for (const id of [STATIONS, ALERTS, HOTSPOTS, LST, SST]) expect(PY.visible[id]).toBe(false);
    expect(PY.sightingHours).toBe(SIGHTING_WINDOW_HOURS);
    expect(SIGHTING_WINDOW_HOURS).toBe(168);
    expect(SIGHTING_WINDOW_OPTIONS).toEqual([48, 168, 720]);
    expect(isSpeciesFiltered(PY.species)).toBe(false);
    expect(shownSpecies(PY.species)).toEqual(["python"]);
  });

  test("setLayerVisible and setSpeciesVisible change one entry and leave the rest", () => {
    setLayerVisible(STATIONS, true);
    setSpeciesVisible("python", false);
    expect(now().visible[STATIONS]).toBe(true);
    expect(now().visible[SIGHTINGS]).toBe(true);
    expect(now().species.python).toBe(false);
    expect(shownSpecies(now().species)).toEqual([]);
    expect(isSpeciesFiltered(now().species)).toBe(true);
    setSpeciesVisible("python", true);
    expect(isSpeciesFiltered(now().species)).toBe(false);
    // Defaults are never mutated in place; a missing key reads as shown.
    expect(PY.visible[STATIONS]).toBe(false);
    expect(PY.species.python).toBe(true);
    expect(shownSpecies({})).toEqual(["python"]);
    set(LAYERS, PY);
  });

  test("the sightings window is one of 2, 7 or 30 days; anything else reads as the default", () => {
    expect(sightingHoursOf({ sightingHours: 48 })).toBe(48);
    expect(sightingHoursOf({ sightingHours: 720 })).toBe(720);
    expect(sightingHoursOf({ sightingHours: 99 as never })).toBe(SIGHTING_WINDOW_HOURS);
    expect(sightingHoursOf(undefined)).toBe(SIGHTING_WINDOW_HOURS);
  });
});
