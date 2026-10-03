import { describe, expect, test } from "bun:test";

import { areasOf } from "client/lionfish/model";
import { reefUrl, WIDE_PX_PER_CELL, WIDE_TILE_DEG, wideTiles, wideUrls } from "client/lionfish/reef";
import { getApp } from "shared/apps";

const areas = areasOf(getApp("lionfish"));
const NOW = Date.parse("2026-10-03T12:00:00Z");

describe("wide reef heat backdrop", () => {
  test("tiles sit on a fixed global 20 degree grid, so every visitor asks for the same pictures", () => {
    const tiles = wideTiles(areas);
    for (const t of tiles) {
      expect(Math.abs(t.west % WIDE_TILE_DEG)).toBe(0);
      expect(Math.abs(t.south % WIDE_TILE_DEG)).toBe(0);
      expect(t.east - t.west).toBe(WIDE_TILE_DEG);
      expect(t.north - t.south).toBe(WIDE_TILE_DEG);
    }
    expect(new Set(tiles.map((t) => `${t.west},${t.south}`)).size).toBe(tiles.length);
  });

  test("they cover every area and the room a camera 5,000 km up sees around them", () => {
    const tiles = wideTiles(areas);
    const covered = (lon: number, lat: number) => tiles.some((t) => lon >= t.west && lon < t.east && lat >= t.south && lat < t.north);
    for (const a of areas) for (const [lon, lat] of [[a.bbox.west, a.bbox.south], [a.bbox.east, a.bbox.north], [a.bbox.west, a.bbox.north], [a.bbox.east, a.bbox.south]] as const) expect(covered(lon, lat)).toBe(true);
    // The Keys' camera sits at about 18.6 N, 81 W: 26 degrees each way is in.
    for (const [lon, lat] of [[-105, 18], [-58, 18], [-81, -6], [-81, 44]] as const) expect(covered(lon, lat)).toBe(true);
    expect(tiles.length).toBeGreaterThanOrEqual(9);
    expect(tiles.length).toBeLessThanOrEqual(25);
  });

  test("a picture is 1.25 px per 5 km cell (500 px), and its URL names the tile, the map and the product day", () => {
    expect(WIDE_PX_PER_CELL).toBe(1.25);
    const [url] = wideUrls(areas, "dhw", NOW, NOW);
    const p = new URL(url!, "http://x").searchParams;
    expect(p.get("v")).toBe("CRW_DHW");
    expect(p.get("time")).toBe("last");
    expect(Number(p.get("cols"))).toBe(500);
    expect(Number(p.get("rows"))).toBe(500);
    // The area picture keeps its finer 6 px per cell.
    const area = new URL(reefUrl(areas[0]!, "dhw", NOW, NOW), "http://x").searchParams;
    expect(Number(area.get("cols"))).toBeGreaterThan(0);
    expect(wideUrls(areas, "dhw", NOW, NOW)).toEqual(wideUrls(areas, "dhw", NOW, NOW));
  });

  test("a past day asks for that product day", () => {
    const [url] = wideUrls(areas, "temp", Date.parse("2026-08-01T10:00:00Z"), NOW);
    expect(new URL(url!, "http://x").searchParams.get("time")).toBe("2026-08-01T12:00:00Z");
  });
});
