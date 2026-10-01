import { describe, expect, test } from "bun:test";

import { appBBox, cellAt, cellCentre, clampToApp, copyText, getApp, gridSize, hasLayer, legendTitle, primaryRegion, regionAt, speciesIds } from "shared/apps";

describe("app config regions", () => {
  test("app config: appBBox is the one region for python and the union of four for lionfish", () => {
    expect(appBBox(getApp("python"))).toEqual({ west: -83.2, south: 24.3, east: -79.8, north: 27.5 });
    expect(appBBox(getApp("lionfish"))).toEqual({ west: -88.5, south: 9.7, east: -74.0, north: 27.5 });
  });

  test("app config: regionAt and clampToApp", () => {
    const lionfish = getApp("lionfish");
    expect(regionAt(lionfish, 17, -88)?.id).toBe("belize");
    expect(regionAt(lionfish, 0, 0)).toBeNull();
    expect(clampToApp(getApp("python"), { west: -90, south: 20, east: -81, north: 26 })).toEqual({ west: -83.2, south: 24.3, east: -81, north: 26 });
    expect(clampToApp(getApp("python"), { west: 10, south: 10, east: 11, north: 11 })).toBeNull();
    // Open Gulf between lionfish's areas: inside their union box, in none of them.
    expect(clampToApp(lionfish, { west: -86, south: 23, east: -85, north: 24 })).toBeNull();
    expect(clampToApp(lionfish, { west: -88, south: 17, east: -87.5, north: 17.5 })).toEqual({ west: -88, south: 17, east: -87.5, north: 17.5 });
  });

  test("app config: cells on the primary region's grid round-trip (C14 0.01° grid for python)", () => {
    const region = primaryRegion(getApp("python"));
    expect(gridSize(region)).toEqual({ cols: 340, rows: 320 });
    expect(cellAt(region, 25.005, -80.995)).toBe("220:70");
    const c = cellCentre(region, "220:70")!;
    expect(c.lon).toBeCloseTo(-80.995, 6);
    expect(c.lat).toBeCloseTo(25.005, 6);
    expect(cellCentre(region, "9999:1")).toBeNull();
    expect(cellCentre(region, "x")).toBeNull();
  });

  test("app config: species ids and taxon ids follow config order", () => {
    expect(speciesIds(getApp("lionfish"))).toEqual(["lionfish"]);
    expect(speciesIds(getApp("carp"))).toEqual([]);
    expect(speciesIds(getApp("python"))).toEqual(["python", "tegu", "iguana", "lionfish"]);
  });

  test("app config: layers, copy and legend lookups", () => {
    expect(hasLayer(getApp("carp"), "sightings")).toBe(false);
    expect(hasLayer(getApp("carp"), "stations")).toBe(true);
    expect(copyText(getApp("carp"), "about", "x")).toContain("Louisiana");
    expect(copyText(getApp("carp"), "missing", "fallback")).toBe("fallback");
    expect(legendTitle(getApp("lionfish"))).toBe("Lionfish reports and reef conditions");
  });
});
