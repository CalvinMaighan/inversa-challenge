import { describe, expect, test } from "bun:test";

import type { LayerStats } from "client/globe/layers/types";
import { HEAT_STOPS, TEMP_STOPS } from "client/globe/ramp";
import { NEUTRAL_COLOR, SPECIES_COLORS, TAXON_PALETTE } from "client/globe/species";
import { formatCount, GAP_SWATCHES, groupCounts, HATCH_COLOR, legendRows, rampGradient } from "client/hud/legend/model";
import type { TaxonInfo } from "client/state/taxa";
import { statsSignature } from "client/hud/legend/useGlobeStats";
import { LAYERS, type LayersState } from "client/state/layers";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

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

const layers = (over: Partial<LayersState> = {}): LayersState => ({ ...LAYERS.defaults, ...over });

describe("legend", () => {
  test("one row per globe layer, none missing, none twice", () => {
    const rows = legendRows(layers(), null);
    expect(rows.map((r) => r.layer).sort()).toEqual([...LAYER_IDS].sort());
  });

  test("sightings: a row per focus species in the layer's own colours, plus the animal, plant and insect groups, with live counts", () => {
    const taxon = (id: number, iconicGroup: string): TaxonInfo => ({ id, scientificName: `T${id}`, commonName: "", focus: false, iconicGroup, summary: null, photoUrl: null, pageUrl: null });
    const taxa = { "42": taxon(42, "Reptilia"), "43": taxon(43, "Plantae"), "44": taxon(44, "Insecta") };
    const breakdown = { "1": 2, "2": 0, "3": 6, "4": 0, "42": 1, "43": 3, "44": 2, "45": 1 };
    const stats = [stat(SIGHTINGS, 9, breakdown)];
    const row = legendRows(layers(), stats, taxa).find((r) => r.layer === SIGHTINGS)!;
    expect(row.count).toBe(9);
    expect(row.swatches.map((s) => s.label)).toEqual(["Burmese python", "Argentine tegu", "Green iguana", "Red lionfish", "Other introduced animals", "Plants", "Insects & others"]);
    // Animals on in a palette colour; plants and insects off read neutral.
    expect(row.swatches.map((s) => s.color)).toEqual([...SPECIES_COLORS, TAXON_PALETTE[0]!, NEUTRAL_COLOR, NEUTRAL_COLOR]);
    // 45 is not loaded yet: counted as an animal.
    expect(row.swatches.map((s) => s.count)).toEqual([2, 0, 6, 0, 2, 3, 2]);
    expect(row.swatches.map((s) => s.species)).toEqual([...SPECIES_IDS, "animals", "plants", "others"]);
    expect(row.swatches.map((s) => s.on)).toEqual([true, true, true, true, true, false, false]);
    expect(groupCounts(undefined, taxa)).toBeNull();
    expect(row.note).toContain("last 7 days");
  });

  test("species toggles reflect the LAYERS filter", () => {
    const species = { ...LAYERS.defaults.species, [SPECIES_IDS[1]]: false };
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
    const pinned = { ...LAYERS.defaults.species, [HOTSPOTS]: SPECIES_IDS[2] };
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
