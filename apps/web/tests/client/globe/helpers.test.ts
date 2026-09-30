import { describe, expect, test } from "bun:test";

import { evidenceCell, hotspotEvidenceId, readingEvidenceId, sightingEvidenceId } from "client/globe/evidence";
import { cellAt, gridBounds } from "client/globe/geometry";
import { polygonsOf } from "client/globe/layers/geojson";
import { createKeyedFetch } from "client/globe/layers/keyed-fetch";
import { colorOfTaxon, enabledSpecies, OTHER_TAXON_COLOR, SPECIES_COLORS, speciesIndexOfTaxon } from "client/globe/species";
import { parseEvidenceId } from "client/state/selection";

import { flush } from "./fakes";

describe("evidence ids (C14)", () => {
  test("formats match the agent's", () => {
    expect(sightingEvidenceId(123)).toBe("sighting:123");
    expect(readingEvidenceId("8723970", "WATER_C", "2026-01-15T03:00:00Z", "MEASURED")).toBe("reading:8723970:water_c:1768446000000:measured");
    expect(evidenceCell(-83.2, 24.3)).toBe("0:0");
    expect(evidenceCell(-79.8001, 27.4999)).toBe("339:319");
    expect(evidenceCell(-79.8, 25)).toBeNull();
    expect(evidenceCell(-84, 25)).toBeNull();
    const id = hotspotEvidenceId(2, -80.505, 25.405, 1_768_446_000_000)!;
    expect(id).toBe("hotspot:iguana:269:110:1768446000000");
    expect(parseEvidenceId(id)).toEqual({ kind: "hotspot", key: "iguana:269:110:1768446000000" });
    expect(hotspotEvidenceId(7, -80.5, 25.4, 0)).toBeNull();
  });
});

describe("grid geometry", () => {
  test("defaults to the C4 grids over the C15 region; EVF2 header geometry places sub-grids", () => {
    const full = gridBounds({ hsCols: 170, hsRows: 160, envCols: 68, envRows: 64 }, undefined);
    expect(full.hotspot.west).toBe(-83.2);
    expect(full.hotspot.east).toBeCloseTo(-79.8);
    expect(full.hotspot.north).toBeCloseTo(27.5);
    expect(full.env.east).toBeCloseTo(-79.8);
    expect(full.env.north).toBeCloseTo(27.5);
    const patch = gridBounds({ hsCols: 10, hsRows: 5, envCols: 4, envRows: 2 }, { west: -80.5, south: 25.2, hsCellDeg: 0.02, envCellDeg: 0.05 });
    expect(patch.hotspot).toEqual({ west: -80.5, south: 25.2, east: -80.5 + 0.2, north: 25.2 + 0.1 });
    expect(cellAt(patch.hotspot, 10, 5, -80.41, 25.23)).toEqual([4, 1]);
    expect(cellAt(patch.hotspot, 10, 5, -80.6, 25.23)).toBeNull();
  });
});

describe("species", () => {
  test("taxon ids 1–4 map to SPECIES_IDS order; others are grey", () => {
    expect([1, 2, 3, 4, 0, 5].map(speciesIndexOfTaxon)).toEqual([0, 1, 2, 3, -1, -1]);
    expect(colorOfTaxon(4)).toBe(SPECIES_COLORS[3]!);
    expect(colorOfTaxon(17)).toBe(OTHER_TAXON_COLOR);
  });

  test("filter: booleans per species, or a voice pin of one layer to one species", () => {
    expect(enabledSpecies(undefined)).toEqual([0, 1, 2, 3]);
    expect(enabledSpecies({ python: true, tegu: false, iguana: true, lionfish: false })).toEqual([0, 2]);
    expect(enabledSpecies({ python: true, hotspots: "lionfish" }, "hotspots")).toEqual([3]);
    expect(enabledSpecies({ python: true, hotspots: "lionfish" }, "sightings")).toEqual([0, 1, 2, 3]);
    expect(enabledSpecies({ hotspots: "dodo" }, "hotspots")).toEqual([0, 1, 2, 3]);
  });
});

describe("alert GeoJSON", () => {
  const ring = [[-80, 25], [-79.9, 25], [-79.9, 25.1], [-80, 25]];

  test("Polygon, MultiPolygon, Feature, FeatureCollection and string payloads", () => {
    expect(polygonsOf({ type: "Polygon", coordinates: [ring] })).toEqual([[[-80, 25, -79.9, 25, -79.9, 25.1]]]);
    expect(polygonsOf({ type: "MultiPolygon", coordinates: [[ring], [ring]] }).length).toBe(2);
    expect(polygonsOf({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring, ring] } })[0]!.length).toBe(2);
    expect(polygonsOf({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] } }] }).length).toBe(1);
    expect(polygonsOf(JSON.stringify({ type: "Polygon", coordinates: [ring] })).length).toBe(1);
  });

  test("degenerate or malformed input yields nothing", () => {
    expect(polygonsOf(null)).toEqual([]);
    expect(polygonsOf("not json")).toEqual([]);
    expect(polygonsOf({ type: "Point", coordinates: [1, 2] })).toEqual([]);
    expect(polygonsOf({ type: "Polygon", coordinates: [[[-80, 25], [-79, 25], [-80, 25]]] })).toEqual([]);
    expect(polygonsOf({ type: "Polygon", coordinates: [[["x", 1], [-80, 25], [-79, 25], [-79, 26]]] })).toEqual([[[-80, 25, -79, 25, -79, 26]]]);
  });
});

describe("keyed fetch", () => {
  test("one request in flight; only the newest wanted key is fetched next; cache hits are synchronous", async () => {
    const loads: string[] = [];
    const got: string[] = [];
    const resolvers = new Map<string, (v: string) => void>();
    const f = createKeyedFetch<string>({
      cacheSize: 2,
      load: (key) => {
        loads.push(key);
        return new Promise((r) => resolvers.set(key, r));
      },
      onData: (key) => got.push(key),
      onError: () => {},
    });
    expect(f.want("a")).toBeUndefined();
    f.want("b");
    f.want("c");
    expect(loads).toEqual(["a"]);
    resolvers.get("a")!("A");
    await flush();
    expect(loads).toEqual(["a", "c"]);
    resolvers.get("c")!("C");
    await flush();
    expect(got).toEqual(["a", "c"]);
    expect(f.want("a")).toBe("A");
    expect(f.want("c")).toBe("C");
  });

  test("failures back off per key", async () => {
    let t = 0;
    let calls = 0;
    const f = createKeyedFetch<number>({
      cacheSize: 4,
      retryAfterMs: 1_000,
      now: () => t,
      load: async () => {
        calls += 1;
        throw new Error("down");
      },
      onData: () => {},
      onError: () => {},
    });
    f.want("k");
    await flush();
    f.want("k");
    expect(calls).toBe(1);
    t = 1_500;
    f.want("k");
    await flush();
    expect(calls).toBe(2);
  });
});
