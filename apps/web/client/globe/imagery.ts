/**
 * Applies a `LadderPlan` to a Cesium widget: terrain, one base imagery layer with automatic fallback down the
 * ladder, and the Google Photorealistic 3D tileset while the camera is low over the app's zone: straight from the
 * Map Tiles API with the browser's Google key, else (or when that load fails) through ion.
 *
 * Every provider gets its token explicitly; `Ion.defaultAccessToken` (Cesium's shared demo token) is never
 * used, and the direct route is only called with a key (Cesium would quietly fall back to ion without one).
 * Every request is CORS (ion, Esri, OSM, tile.googleapis.com), which is what COEP `require-corp` allows.
 */
import type { Cesium3DTileset, CesiumWidget, ImageryLayer, ImageryProvider } from "cesium";

import type { BBox } from "shared/agent/events";

import { cesium } from "./cesium";
import {
  GOOGLE_3D_ZONE,
  googleZoneActive,
  ION_ASSETS,
  loadGoogle3d,
  nextRung,
  planLadder,
  type BaseImagery,
  type CameraSample,
  type Google3dRoute,
  type LadderPlan,
} from "./ladder";
import { googleCapReached, quotaExhausted, readGoogleQuota, readQuota, recordGoogleSession, recordQuota, type QuotaStore } from "./quota";

export const ESRI_WORLD_IMAGERY_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
export const OSM_TILE_URL = "https://tile.openstreetmap.org/";
const ESRI_CREDIT = "Powered by Esri. Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const OSM_CREDIT = "© OpenStreetMap contributors";
/** Tile failures on one base layer before the ladder steps down (a dead or throttled service). */
const TILE_ERROR_LIMIT = 12;

export type ImageryState = {
  plan: LadderPlan;
  base: BaseImagery | null;
  terrain: "world" | "ellipsoid";
  google3d: "off" | "loading" | "shown" | "hidden" | "failed";
  /** The route the loaded tileset came from. */
  google3dRoute: Google3dRoute | null;
  errors: string[];
};

export type ImageryController = {
  state(): ImageryState;
  /** Re-evaluate the Google 3D gate for a camera position. */
  update(camera: CameraSample): void;
  destroy(): void;
};

function baseProvider(rung: BaseImagery, token: string): Promise<ImageryProvider> {
  const { ArcGisMapServerImageryProvider, Credit, IonImageryProvider, OpenStreetMapImageryProvider } = cesium();
  switch (rung) {
    case "bing":
      return IonImageryProvider.fromAssetId(ION_ASSETS.bingAerial, { accessToken: token });
    case "esri":
      return ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY_URL, { enablePickFeatures: false, credit: new Credit(ESRI_CREDIT) });
    case "osm":
      return Promise.resolve(new OpenStreetMapImageryProvider({ url: OSM_TILE_URL, credit: new Credit(OSM_CREDIT) }));
  }
}

export function installImagery(
  widget: CesiumWidget,
  opts: {
    ionToken: string | undefined;
    /** Browser key for the Map Tiles API (Developer panel or NEXT_PUBLIC_GOOGLE_MAPS_API_KEY). */
    googleKey?: string | undefined;
    quotaStore: QuotaStore | null;
    /** Where Google 3D may show, read on each camera update (the active app can change). Miami/Keys by default. */
    zones?: () => readonly Readonly<BBox>[];
    /** The highest the camera may be for Google 3D to show, read with the zones. */
    maxAltitudeM?: () => number;
    now?: () => number;
    requestRender(): void;
    onChange?(state: ImageryState): void;
  },
): ImageryController {
  const { Cesium3DTileset, CesiumTerrainProvider, ImageryLayer, IonResource, createGooglePhotorealistic3DTileset } = cesium();
  const now = opts.now ?? Date.now;
  const token = (opts.ionToken ?? "").trim();
  const googleKey = (opts.googleKey ?? "").trim();
  const zones = opts.zones ?? (() => GOOGLE_3D_ZONE);
  const plan = planLadder({ ionToken: token, quota: readQuota(opts.quotaStore, now()), googleKey, google: readGoogleQuota(opts.quotaStore, now()) });
  const state: ImageryState = { plan, base: null, terrain: "ellipsoid", google3d: "off", google3dRoute: null, errors: [] };
  const scene = widget.scene;
  let destroyed = false;
  let baseLayer: ImageryLayer | null = null;
  let tileset: Cesium3DTileset | null = null;
  let tilesetReady = false;
  const cleanups: (() => void)[] = [];

  const changed = () => {
    opts.onChange?.({ ...state, errors: [...state.errors] });
    opts.requestRender();
  };
  const fail = (what: string, err: unknown) => {
    state.errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    if (state.errors.length > 20) state.errors.shift();
  };

  // An ion imagery session whenever the base layer comes through ion (with or without the direct Google route).
  if (plan.base === "bing") recordQuota(opts.quotaStore, "sessions", now());

  const setBase = (rung: BaseImagery) => {
    if (destroyed) return;
    if (baseLayer) widget.imageryLayers.remove(baseLayer, true);
    const layer = ImageryLayer.fromProviderAsync(baseProvider(rung, token), {});
    baseLayer = layer;
    state.base = rung;
    let tileErrors = 0;
    let stepped = false;
    const stepDown = (reason: unknown) => {
      if (stepped || destroyed || baseLayer !== layer) return;
      stepped = true;
      fail(rung, reason);
      const next = nextRung(rung);
      if (next) setBase(next);
      else {
        state.base = null;
        changed();
      }
    };
    layer.errorEvent.addEventListener((err: unknown) => stepDown(err));
    layer.readyEvent.addEventListener((provider: ImageryProvider) => {
      provider.errorEvent.addEventListener((err: { error?: unknown; message?: string }) => {
        tileErrors += 1;
        if (tileErrors >= TILE_ERROR_LIMIT) stepDown(err.error ?? err.message ?? "tile errors");
      });
      changed();
    });
    widget.imageryLayers.add(layer, 0);
    changed();
  };
  setBase(plan.base);

  if (plan.terrain === "world") {
    CesiumTerrainProvider.fromUrl(IonResource.fromAssetId(ION_ASSETS.worldTerrain, { accessToken: token }), { requestVertexNormals: false, requestWaterMask: false })
      .then((terrain) => {
        if (destroyed) return;
        scene.terrainProvider = terrain;
        state.terrain = "world";
        changed();
      })
      .catch((err: unknown) => {
        fail("terrain", err);
        changed();
      });
  }

  const showGoogle = (on: boolean) => {
    if (!tileset) return;
    tileset.show = on;
    // The photorealistic mesh has its own ground; hiding the globe under it avoids z-fighting with terrain.
    scene.globe.show = !(on && tilesetReady);
    state.google3d = on ? "shown" : "hidden";
  };

  const tilesetOptions = { showCreditsOnScreen: true, maximumScreenSpaceError: 16 };
  const loaders: Record<Google3dRoute, () => Promise<Cesium3DTileset>> = {
    // The quota is re-read at load time: another tab may have used it up since the plan was made.
    async direct() {
      if (!googleKey) throw new Error("no Google key");
      if (googleCapReached(readGoogleQuota(opts.quotaStore, now()))) throw new Error("Google monthly cap near limit");
      // The root request opens a billed session whether or not the tileset then loads.
      recordGoogleSession(opts.quotaStore, now());
      return createGooglePhotorealistic3DTileset({ key: googleKey, onlyUsingWithGoogleGeocoder: true }, tilesetOptions);
    },
    async ion() {
      if (quotaExhausted(readQuota(opts.quotaStore, now()))) throw new Error("ion quota near limit");
      const loaded = await Cesium3DTileset.fromUrl(await IonResource.fromAssetId(ION_ASSETS.googlePhotorealistic, { accessToken: token }), tilesetOptions);
      recordQuota(opts.quotaStore, "rootTiles", now());
      return loaded;
    },
  };

  const loadGoogle = () => {
    if (state.google3d !== "off") return;
    state.google3d = "loading";
    loadGoogle3d(plan, loaders, (route, err) => fail(`google3d ${route}`, err))
      .then((result) => {
        if (!result) {
          state.google3d = "failed";
          changed();
          return;
        }
        const loaded = result.tileset;
        if (destroyed) {
          loaded.destroy();
          return;
        }
        state.google3dRoute = result.route;
        tileset = scene.primitives.add(loaded, 0) as Cesium3DTileset;
        const onInitial = () => {
          tilesetReady = true;
          if (tileset?.show) scene.globe.show = false;
          opts.requestRender();
        };
        loaded.initialTilesLoaded.addEventListener(onInitial);
        cleanups.push(() => loaded.initialTilesLoaded.removeEventListener(onInitial));
        state.google3d = "hidden";
        showGoogle(lastActive);
        changed();
      })
      .catch((err: unknown) => {
        fail("google3d", err);
        state.google3d = "failed";
        changed();
      });
  };

  let lastActive = false;
  return {
    state: () => ({ ...state, errors: [...state.errors] }),
    update(camera) {
      if (destroyed) return;
      const active = googleZoneActive(plan, camera, zones(), opts.maxAltitudeM?.());
      if (active === lastActive && (tileset || !active)) return;
      lastActive = active;
      if (active && !tileset) loadGoogle();
      else if (tileset) {
        showGoogle(active);
        changed();
      }
    },
    destroy() {
      destroyed = true;
      for (const off of cleanups) off();
      if (tileset && !tileset.isDestroyed()) scene.primitives.remove(tileset);
      tileset = null;
    },
  };
}
