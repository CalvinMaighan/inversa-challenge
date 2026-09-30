import { describe, expect, test } from "bun:test";

import {
  GOOGLE_3D_MAX_ALTITUDE_M,
  GOOGLE_3D_ZONE,
  googleZoneActive,
  ION_ASSETS,
  nextRung,
  planLadder,
} from "client/globe/ladder";
import { recordQuota, readQuota, type QuotaStore } from "client/globe/quota";

const fresh = { month: "2026-09", sessions: 0, rootTiles: 0 };
const MIAMI = { lon: -80.19, lat: 25.77 };
const KEY_WEST = { lon: -81.78, lat: 24.56 };
const EVERGLADES_CITY = { lon: -81.38, lat: 25.86 };

describe("imagery ladder selection", () => {
  test("with an ion token: world terrain, Bing via ion, Google 3D allowed, Esri as the next rung", () => {
    expect(planLadder({ ionToken: "tok", quota: fresh })).toEqual({
      route: "ion",
      terrain: "world",
      base: "bing",
      fallback: "esri",
      google3d: true,
      reason: "token",
    });
  });

  test("without a token (missing, empty or whitespace): keyless Esri on the ellipsoid, OSM next", () => {
    for (const ionToken of [undefined, null, "", "   "]) {
      expect(planLadder({ ionToken, quota: fresh })).toEqual({
        route: "keyless",
        terrain: "ellipsoid",
        base: "esri",
        fallback: "osm",
        google3d: false,
        reason: "no-token",
      });
    }
  });

  test("quota fallback: a token near 90 % of the Community limit switches to keyless", () => {
    const map = new Map<string, string>();
    const store: QuotaStore = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
    const now = Date.parse("2026-09-20T00:00:00Z");
    recordQuota(store, "sessions", now, 899);
    expect(planLadder({ ionToken: "tok", quota: readQuota(store, now) }).route).toBe("ion");
    recordQuota(store, "sessions", now);
    const plan = planLadder({ ionToken: "tok", quota: readQuota(store, now) });
    expect(plan).toMatchObject({ route: "keyless", base: "esri", google3d: false, reason: "quota" });

    const tiles = planLadder({ ionToken: "tok", quota: { month: "2026-09", sessions: 3, rootTiles: 900 } });
    expect(tiles.reason).toBe("quota");
    // The next month resets the tally and ion comes back.
    expect(planLadder({ ionToken: "tok", quota: readQuota(store, Date.parse("2026-10-02T00:00:00Z")) }).route).toBe("ion");
  });

  test("runtime fallback walks bing → esri → osm → none", () => {
    expect(nextRung("bing")).toBe("esri");
    expect(nextRung("esri")).toBe("osm");
    expect(nextRung("osm")).toBeNull();
  });

  test("Google 3D only over Miami/Keys and below 30 km", () => {
    const ion = planLadder({ ionToken: "tok", quota: fresh });
    expect(googleZoneActive(ion, { ...MIAMI, altitudeM: 5_000 })).toBe(true);
    expect(googleZoneActive(ion, { ...KEY_WEST, altitudeM: 12_000 })).toBe(true);
    expect(googleZoneActive(ion, { ...MIAMI, altitudeM: GOOGLE_3D_MAX_ALTITUDE_M })).toBe(false);
    expect(googleZoneActive(ion, { ...MIAMI, altitudeM: 380_000 })).toBe(false);
    expect(googleZoneActive(ion, { ...EVERGLADES_CITY, altitudeM: 5_000 })).toBe(false);
    const keyless = planLadder({ ionToken: "", quota: fresh });
    expect(googleZoneActive(keyless, { ...MIAMI, altitudeM: 5_000 })).toBe(false);
    // Key Largo and Florida Bay (Flamingo) sit on either side of the Upper Keys box edge.
    expect(googleZoneActive(ion, { lon: -80.45, lat: 25.1, altitudeM: 8_000 })).toBe(true);
    expect(googleZoneActive(ion, { lon: -80.92, lat: 25.14, altitudeM: 8_000 })).toBe(false);
    expect(GOOGLE_3D_ZONE.length).toBe(3);
  });

  test("ion asset ids", () => {
    expect(ION_ASSETS).toEqual({ worldTerrain: 1, bingAerial: 2, googlePhotorealistic: 2275207 });
  });
});
