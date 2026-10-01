import { describe, expect, test } from "bun:test";
import { PYTHON_LAYERS, SPECIES_COLORS, SPECIES_IDS, selectPython } from "@/tests/client/python-app";

import type { LayerStats } from "client/globe/layers/types";
import { HEAT_STOPS, TEMP_STOPS } from "client/globe/ramp";

import { categoryCounts, formatCount, GAP_SWATCHES, HATCH_COLOR, legendRows, rampGradient } from "client/hud/legend/model";
import { CATEGORY_ANCESTORS, CATEGORY_COLORS, CATEGORY_IDS, categoryFromAncestry } from "shared/species-categories";
import type { TaxonInfo } from "client/state/taxa";
import { statsSignature } from "client/hud/legend/useGlobeStats";
import { type LayersState } from "client/state/layers";
import { LAYER_IDS } from "shared/voice/ui-tools";

selectPython();

const [SIGHTINGS, HOTSPOTS, LST, SST, STATIONS, ALERTS] = LAYER_IDS;

const stat = (id: (typeof LAYER_IDS)[number], count: number, breakdown?: Record<string, number>, over: Partial<LayerStats> = {}): LayerStats => ({
  id,
  enabled: true,
  count,
  frame: 3,
  updatedAt: 1,
  error: null,
  ...(breakdown ? { breakdown } : {}),
  ...over,
});

const layers = (over: Partial<LayersState> = {}): LayersState => ({ ...PYTHON_LAYERS, ...over });

describe("legend", () => {
  test("one row per globe layer, none missing, none twice", () => {
    const rows = legendRows(layers(), null);
    expect(rows.map((r) => r.layer).sort()).toEqual([...LAYER_IDS].sort());
  });

  test("sightings: a row per focus species in the layer's own colours with its kind's icon, then every category with its icon, colour and live count", () => {
    const taxon = (id: number, ancestor: number): TaxonInfo => ({ id, scientificName: `T${id}`, commonName: "", focus: false, iconicGroup: null, ancestorIds: [1, ancestor], category: categoryFromAncestry([ancestor]), summary: null, photoUrl: null, pageUrl: null });
    const taxa = { "42": taxon(42, CATEGORY_ANCESTORS.lizards), "43": taxon(43, CATEGORY_ANCESTORS.plants), "44": taxon(44, CATEGORY_ANCESTORS.insects) };
    const breakdown = { "1": 2, "2": 0, "3": 6, "4": 0, "42": 1, "43": 3, "44": 2, "45": 1 };
    const stats = [stat(SIGHTINGS, 9, breakdown)];
    const row = legendRows(layers(), stats, taxa).find((r) => r.layer === SIGHTINGS)!;
    expect(row.count).toBe(9);
    expect(row.swatches.slice(0, 5).map((s) => s.label)).toEqual(["Burmese python", "Argentine black and white tegu", "Green iguana", "Lionfish", "Snakes"]);
    expect(row.swatches.map((s) => s.shape).every((s) => s === "icon")).toBe(true);
    expect(row.swatches.slice(0, 4).map((s) => s.icon)).toEqual(["snakes", "lizards", "lizards", "fish"]);
    expect(row.swatches.slice(4).map((s) => s.icon)).toEqual([...CATEGORY_IDS]);
    // Focus colours, then each category's own colour (an off category keeps its colour, dimmed by the panel).
    expect(row.swatches.map((s) => s.color)).toEqual([...SPECIES_COLORS, ...CATEGORY_IDS.map((id) => CATEGORY_COLORS[id])]);
    const by = Object.fromEntries(row.swatches.map((s) => [s.key, s]));
    // 45 is not loaded yet: counted under Other.
    expect([by.python, by.iguana, by.lizards, by.plants, by.insects, by.other].map((s) => s!.count)).toEqual([2, 6, 1, 3, 2, 1]);
    expect(by.birds!.count).toBe(0);
    expect(row.swatches.map((s) => s.species)).toEqual([...SPECIES_IDS, ...CATEGORY_IDS]);
    expect([by.python, by.lizards, by.plants, by.insects, by.other].map((s) => s!.on)).toEqual([true, true, false, false, false]);
    expect(by.other!.label).toBe("Other kinds");
    expect(categoryCounts(undefined, taxa)).toBeNull();
    expect(row.note).toContain("last 7 days");
  });

  test("species toggles reflect the LAYERS filter", () => {
    const species = { ...PYTHON_LAYERS.species, [SPECIES_IDS[1]]: false };
    const row = legendRows(layers({ species }), null).find((r) => r.layer === SIGHTINGS)!;
    expect(row.swatches.slice(0, 4).map((s) => s.on)).toEqual([true, false, true, true]);
  });

  test("stations: the three networks in their marker colours (the blue, teal and violet squares)", () => {
    const row = legendRows(layers(), [stat(STATIONS, 5, { usgs: 3, ndbc: 1, coops: 1, other: 0 })]).find((r) => r.layer === STATIONS)!;
    expect(row.swatches.map((s) => [s.label, s.color, s.shape, s.count])).toEqual([
      ["USGS gauge", "#4fb3ff", "square", 3],
      ["NDBC buoy", "#3fd6c6", "square", 1],
      ["NOAA tide gauge", "#c89bff", "square", 1],
    ]);
  });

  test("hotspots: the heat ramp low to high, labelled heuristic score, with the species pin", () => {
    const pinned = { ...PYTHON_LAYERS.species, [HOTSPOTS]: SPECIES_IDS[2] };
    const row = legendRows(layers({ species: pinned }), null).find((r) => r.layer === HOTSPOTS)!;
    expect(row.ramp).toEqual({ css: rampGradient(HEAT_STOPS), min: "low", max: "high", caption: "heuristic score" });
    expect(row.pin).toBe(SPECIES_IDS[2]);
    expect(legendRows(layers(), null).find((r) => r.layer === HOTSPOTS)!.pin).toBeNull();
  });

  test("LST and SST: the temperature ramp with their °C ranges, hidden by default", () => {
    const rows = legendRows(layers(), null);
    const lst = rows.find((r) => r.layer === LST)!;
    const sst = rows.find((r) => r.layer === SST)!;
    expect([lst.ramp!.min, lst.ramp!.max, sst.ramp!.min, sst.ramp!.max]).toEqual(["0 °C", "45 °C", "16 °C", "33 °C"]);
    expect(lst.ramp!.css).toBe(rampGradient(TEMP_STOPS));
    expect([lst.visible, sst.visible]).toEqual([false, false]);
  });

  test("alerts: a swatch per severity; errors surface on the row", () => {
    const row = legendRows(layers(), [stat(ALERTS, 2, undefined, { error: "graphql http 502" })]).find((r) => r.layer === ALERTS)!;
    expect(row.swatches.map((s) => s.label)).toEqual(["Extreme", "Severe", "Moderate", "Minor"]);
    expect(row.count).toBe(2);
    expect(row.error).toBe("graphql http 502");
  });

  test("before the globe reports, counts are unknown, not zero", () => {
    const rows = legendRows(layers(), null);
    expect(rows.every((r) => r.count === null)).toBe(true);
    expect(rows.find((r) => r.layer === SIGHTINGS)!.swatches.every((s) => s.count === null)).toBe(true);
    expect(formatCount(null)).toBe("—");
    expect(formatCount(12345)).toBe("12,345");
  });

  test("ramp gradients run through every stop in order", () => {
    expect(rampGradient([
      [0, 0, 0, 0, 0],
      [1, 255, 128, 0, 1],
    ])).toBe("linear-gradient(90deg, rgb(0 0 0) 0%, rgb(255 128 0) 100%)");
  });

  test("data gaps: the raster hatch and the three timeline gap kinds", () => {
    expect(GAP_SWATCHES.map((g) => g.label)).toEqual(["Cloud or masked", "No data", "Cloud", "Quiet"]);
    expect(HATCH_COLOR).toBe("rgb(214 219 228 / 0.38)");
  });

  test("stats signature changes only when what the legend shows changes", () => {
    const a = [stat(SIGHTINGS, 3, { python: 3 })];
    expect(statsSignature(a)).toBe(statsSignature([{ ...a[0]!, updatedAt: 99, frame: 7 }]));
    expect(statsSignature(a)).not.toBe(statsSignature([stat(SIGHTINGS, 4, { python: 4 })]));
    expect(statsSignature(a)).not.toBe(statsSignature([{ ...a[0]!, enabled: false }]));
    expect(statsSignature(null)).toBe("");
  });
});
