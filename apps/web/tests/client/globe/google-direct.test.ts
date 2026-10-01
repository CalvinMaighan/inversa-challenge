import { afterAll, describe, expect, test } from "bun:test";
import * as Cesium from "cesium";

import carp from "app-configs/carp.json";
import { setCesium, type Cesium as CesiumNs } from "client/globe/cesium";
import { installImagery } from "client/globe/imagery";
import {
  GOOGLE_3D_ZONES,
  GOOGLE_TILES_ROOT,
  googleZoneActive,
  insideBBox,
  loadGoogle3d,
  LOUISIANA_3D_ZONE,
  next3dRoute,
  planLadder,
  type Google3dRoute,
} from "client/globe/ladder";
import {
  GOOGLE_CAP_STORAGE_KEY,
  GOOGLE_DEFAULT_MONTHLY_CAP,
  GOOGLE_QUOTA_STORAGE_KEY,
  googleCapReached,
  readGoogleCap,
  readGoogleQuota,
  recordGoogleSession,
  writeGoogleCap,
  type QuotaStore,
} from "client/globe/quota";

const fresh = { month: "2026-10", sessions: 0, rootTiles: 0 };
const NOW = Date.parse("2026-10-01T12:00:00Z");
const google = { counts: { month: "2026-10", sessions: 0 }, cap: GOOGLE_DEFAULT_MONTHLY_CAP };
const MIAMI = { lon: -80.19, lat: 25.77 };
const KROTZ_SPRINGS = { lon: -91.7614, lat: 30.5689 };

function memoryStore(): QuotaStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

/** A stand-in Cesium: base imagery and terrain never resolve, Google loaders are spies. */
function fakeCesium(opts: { direct?: () => Promise<unknown>; ion?: () => Promise<unknown> }) {
  const calls: string[] = [];
  const pending = () => new Promise<never>(() => {});
  const event = () => ({ addEventListener() {}, removeEventListener() {} });
  const fake = {
    ...Cesium,
    ArcGisMapServerImageryProvider: { fromUrl: () => pending() },
    OpenStreetMapImageryProvider: class {},
    IonImageryProvider: { fromAssetId: () => pending() },
    CesiumTerrainProvider: { fromUrl: () => pending() },
    ImageryLayer: { fromProviderAsync: () => ({ errorEvent: event(), readyEvent: event() }) },
    IonResource: {
      fromAssetId: (id: number, o: { accessToken: string }) => {
        calls.push(`ion-resource:${id}:${o.accessToken}`);
        return Promise.resolve({ asset: id });
      },
    },
    Cesium3DTileset: {
      fromUrl: (resource: { asset?: number }) => {
        calls.push(`tileset:${resource.asset}`);
        return opts.ion ? opts.ion() : pending();
      },
    },
    createGooglePhotorealistic3DTileset: (api: { key?: string }) => {
      calls.push(`google-direct:${api.key}`);
      return opts.direct ? opts.direct() : pending();
    },
  };
  return { fake: fake as unknown as CesiumNs, calls };
}

function fakeTileset() {
  return { show: false, initialTilesLoaded: { addEventListener() {}, removeEventListener() {} }, destroy() {}, isDestroyed: () => false };
}

function fakeWidget() {
  const primitives: unknown[] = [];
  return {
    primitives,
    widget: {
      scene: { primitives: { add: (p: unknown) => (primitives.push(p), p), remove() {} }, globe: { show: true }, terrainProvider: null },
      imageryLayers: { add() {}, remove() {} },
    } as unknown as Parameters<typeof installImagery>[0],
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

afterAll(() => setCesium(Cesium));

describe("google direct", () => {
  test("a Google key selects route google-direct before ion; ion stays the fallback and supplies the base imagery", () => {
    expect(planLadder({ ionToken: "tok", quota: fresh, googleKey: "g", google })).toEqual({
      route: "google-direct",
      terrain: "world",
      base: "bing",
      fallback: "esri",
      google3d: ["direct", "ion"],
      reason: "google-key",
    });
    // Google key alone: Google 3D direct over keyless Esri imagery.
    expect(planLadder({ ionToken: "", quota: fresh, googleKey: " g ", google })).toEqual({
      route: "google-direct",
      terrain: "ellipsoid",
      base: "esri",
      fallback: "osm",
      google3d: ["direct"],
      reason: "google-key",
    });
  });

  test("no key, no Google request: blank keys or a missing quota never plan the direct route", () => {
    for (const googleKey of [undefined, null, "", "   "]) {
      expect(planLadder({ ionToken: "tok", quota: fresh, googleKey, google }).google3d).toEqual(["ion"]);
      expect(planLadder({ ionToken: "", quota: fresh, googleKey, google })).toMatchObject({ route: "keyless", google3d: [], reason: "no-token" });
    }
    expect(planLadder({ ionToken: "", quota: fresh, googleKey: "g" }).google3d).toEqual([]);
  });

  test("a failed direct load falls to ion, then to keyless (no tileset, base imagery stays)", async () => {
    const plan = planLadder({ ionToken: "tok", quota: fresh, googleKey: "g", google });
    expect(next3dRoute(plan, "direct")).toBe("ion");
    expect(next3dRoute(plan, "ion")).toBeNull();
    const tried: string[] = [];
    const failures: string[] = [];
    const loaders = (ok: Google3dRoute | null) => ({
      direct: async () => (tried.push("direct"), ok === "direct" ? "direct-tileset" : Promise.reject(new Error("403 API key not valid"))),
      ion: async () => (tried.push("ion"), ok === "ion" ? "ion-tileset" : Promise.reject(new Error("ion 401"))),
    });
    expect(await loadGoogle3d(plan, loaders("direct"))).toEqual({ route: "direct", tileset: "direct-tileset" });
    expect(tried).toEqual(["direct"]);
    tried.length = 0;
    expect(await loadGoogle3d(plan, loaders("ion"), (r) => failures.push(r))).toEqual({ route: "ion", tileset: "ion-tileset" });
    expect(tried).toEqual(["direct", "ion"]);
    expect(failures).toEqual(["direct"]);
    tried.length = 0;
    expect(await loadGoogle3d(plan, loaders(null))).toBeNull();
    expect(tried).toEqual(["direct", "ion"]);
    tried.length = 0;
    expect(await loadGoogle3d(planLadder({ ionToken: "", quota: fresh }), loaders("direct"))).toBeNull();
    expect(tried).toEqual([]);
  });

  test("the monthly cap (default 1,000 per browser) drops the direct route to the next rung at 90 %", () => {
    const store = memoryStore();
    expect(readGoogleCap(store)).toBe(1_000);
    for (let i = 0; i < 899; i++) recordGoogleSession(store, NOW);
    expect(planLadder({ ionToken: "tok", quota: fresh, googleKey: "g", google: readGoogleQuota(store, NOW) }).route).toBe("google-direct");
    recordGoogleSession(store, NOW);
    expect(googleCapReached(readGoogleQuota(store, NOW))).toBe(true);
    expect(planLadder({ ionToken: "tok", quota: fresh, googleKey: "g", google: readGoogleQuota(store, NOW) })).toMatchObject({ route: "ion", google3d: ["ion"], reason: "token" });
    expect(planLadder({ ionToken: "", quota: fresh, googleKey: "g", google: readGoogleQuota(store, NOW) })).toMatchObject({ route: "keyless", google3d: [], reason: "quota" });
    // The panel raises the cap; nonsense keeps it.
    expect(writeGoogleCap(store, 2_000)).toBe(2_000);
    expect(planLadder({ ionToken: "tok", quota: fresh, googleKey: "g", google: readGoogleQuota(store, NOW) }).route).toBe("google-direct");
    for (const bad of [0, -5, 1.5, Number.NaN, 1e9]) expect(writeGoogleCap(store, bad)).toBe(2_000);
    store.map.set(GOOGLE_CAP_STORAGE_KEY, "abc");
    expect(readGoogleCap(store)).toBe(1_000);
    // Counts are per UTC month.
    expect(JSON.parse(store.map.get(GOOGLE_QUOTA_STORAGE_KEY)!)).toEqual({ month: "2026-10", sessions: 900 });
    expect(readGoogleQuota(store, Date.parse("2026-11-01T00:00:01Z")).counts.sessions).toBe(0);
    // Storage that throws reads as zero and the default cap.
    const throwing: QuotaStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readGoogleQuota(throwing, NOW)).toEqual({ counts: { month: "2026-10", sessions: 0 }, cap: 1_000 });
    expect(recordGoogleSession(throwing, NOW).sessions).toBe(1);
  });

  test("Louisiana zone for carp: every demonstration river site, not Miami; Miami/Keys stay python and lionfish", () => {
    const plan = planLadder({ ionToken: "", quota: fresh, googleKey: "g", google });
    expect(GOOGLE_3D_ZONES.carp).toBe(LOUISIANA_3D_ZONE);
    expect(googleZoneActive(plan, { ...KROTZ_SPRINGS, altitudeM: 5_000 }, GOOGLE_3D_ZONES.carp)).toBe(true);
    expect(googleZoneActive(plan, { ...KROTZ_SPRINGS, altitudeM: 40_000 }, GOOGLE_3D_ZONES.carp)).toBe(false);
    expect(googleZoneActive(plan, { ...MIAMI, altitudeM: 5_000 }, GOOGLE_3D_ZONES.carp)).toBe(false);
    expect(googleZoneActive(plan, { ...KROTZ_SPRINGS, altitudeM: 5_000 }, GOOGLE_3D_ZONES.python)).toBe(false);
    expect(googleZoneActive(plan, { ...MIAMI, altitudeM: 5_000 }, GOOGLE_3D_ZONES.lionfish)).toBe(true);
    const sites = (carp as { locations: { name: string; lat: number; lon: number; group?: unknown }[] }).locations.filter((l) => !/^All sites$/.test(l.name));
    expect(sites.length).toBeGreaterThanOrEqual(8);
    for (const s of sites) expect([s.name, LOUISIANA_3D_ZONE.some((b) => insideBBox(b, s.lon, s.lat))]).toEqual([s.name, true]);
    expect(GOOGLE_TILES_ROOT).toBe("https://tile.googleapis.com/v1/3dtiles/root.json");
  });

  test("imagery: without a Google key the direct loader is never called; with one it is called once with the key and falls to ion", async () => {
    const camera = { ...MIAMI, altitudeM: 5_000 };
    // No key: ion only.
    const a = fakeCesium({ ion: async () => fakeTileset() });
    setCesium(a.fake);
    const wa = fakeWidget();
    const ctrlA = installImagery(wa.widget, { ionToken: "ion-tok", googleKey: "  ", quotaStore: memoryStore(), now: () => NOW, requestRender() {} });
    ctrlA.update(camera);
    await settle();
    expect(a.calls.filter((c) => c.startsWith("google-direct"))).toEqual([]);
    expect(ctrlA.state()).toMatchObject({ google3d: "shown", google3dRoute: "ion", plan: { route: "ion" } });
    ctrlA.destroy();

    // Key, direct rejected (bad key): ion takes over; one session counted.
    const store = memoryStore();
    const b = fakeCesium({ direct: () => Promise.reject(new Error("Request has failed. Status Code: 403")), ion: async () => fakeTileset() });
    setCesium(b.fake);
    const wb = fakeWidget();
    const ctrlB = installImagery(wb.widget, { ionToken: "ion-tok", googleKey: "dummy-google-key", quotaStore: store, now: () => NOW, requestRender() {} });
    expect(ctrlB.state().plan.route).toBe("google-direct");
    ctrlB.update(camera);
    await settle();
    // World terrain (asset 1) at install, then Google 3D: direct first, ion asset 2275207 after it failed.
    expect(b.calls).toEqual(["ion-resource:1:ion-tok", "google-direct:dummy-google-key", "ion-resource:2275207:ion-tok", "tileset:2275207"]);
    expect(ctrlB.state()).toMatchObject({ google3d: "shown", google3dRoute: "ion" });
    expect(ctrlB.state().errors.some((e) => e.startsWith("google3d direct: Request has failed"))).toBe(true);
    expect(readGoogleQuota(store, NOW).counts.sessions).toBe(1);
    ctrlB.destroy();

    // Key, direct loads: no ion request for 3D.
    const c = fakeCesium({ direct: async () => fakeTileset() });
    setCesium(c.fake);
    const ctrlC = installImagery(fakeWidget().widget, { ionToken: "", googleKey: "dummy-google-key", quotaStore: memoryStore(), now: () => NOW, requestRender() {} });
    ctrlC.update({ ...camera, altitudeM: 380_000 });
    await settle();
    expect(c.calls).toEqual([]);
    ctrlC.update(camera);
    await settle();
    expect(c.calls).toEqual(["google-direct:dummy-google-key"]);
    expect(ctrlC.state()).toMatchObject({ google3d: "shown", google3dRoute: "direct", plan: { route: "google-direct", base: "esri" } });
    ctrlC.destroy();

    // Over Louisiana with the carp zone the tileset loads; with the default (Miami/Keys) zone it does not.
    const d = fakeCesium({ direct: async () => fakeTileset() });
    setCesium(d.fake);
    const ctrlD = installImagery(fakeWidget().widget, { ionToken: "", googleKey: "k", zones: () => GOOGLE_3D_ZONES.carp, quotaStore: memoryStore(), now: () => NOW, requestRender() {} });
    ctrlD.update({ ...KROTZ_SPRINGS, altitudeM: 5_000 });
    await settle();
    expect(d.calls).toEqual(["google-direct:k"]);
    ctrlD.destroy();
  });
});
