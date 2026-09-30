/**
 * Applies a `LadderPlan` to a Cesium widget: terrain, one base imagery layer with automatic fallback down the
 * ladder, and the Google Photorealistic 3D tileset while the camera is low over Miami and the Keys.
 *
 * Every provider gets its token explicitly; `Ion.defaultAccessToken` (Cesium's shared demo token) is never
 * used. Every request is CORS (ion, Esri, OSM, Google via ion), which is what COEP `require-corp` allows.
 */
import type { Cesium3DTileset, CesiumWidget, ImageryLayer, ImageryProvider } from "cesium";

import { cesium } from "./cesium";
import { googleZoneActive, ION_ASSETS, nextRung, planLadder, type BaseImagery, type CameraSample, type LadderPlan } from "./ladder";
import { quotaExhausted, readQuota, recordQuota, type QuotaStore } from "./quota";

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
  opts: { ionToken: string | undefined; quotaStore: QuotaStore | null; now?: () => number; requestRender(): void; onChange?(state: ImageryState): void },
): ImageryController {
  const { Cesium3DTileset, CesiumTerrainProvider, ImageryLayer, IonResource } = cesium();
  const now = opts.now ?? Date.now;
  const token = (opts.ionToken ?? "").trim();
  const plan = planLadder({ ionToken: token, quota: readQuota(opts.quotaStore, now()) });
  const state: ImageryState = { plan, base: null, terrain: "ellipsoid", google3d: "off", errors: [] };
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

  if (plan.route === "ion") recordQuota(opts.quotaStore, "sessions", now());

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

  const loadGoogle = () => {
    if (state.google3d !== "off") return;
    if (quotaExhausted(readQuota(opts.quotaStore, now()))) {
      fail("google3d", "ion quota near limit");
      state.google3d = "failed";
      return;
    }
    state.google3d = "loading";
    IonResource.fromAssetId(ION_ASSETS.googlePhotorealistic, { accessToken: token })
      .then((resource) => Cesium3DTileset.fromUrl(resource, { showCreditsOnScreen: true, maximumScreenSpaceError: 16 }))
      .then((loaded) => {
        if (destroyed) {
          loaded.destroy();
          return;
        }
        recordQuota(opts.quotaStore, "rootTiles", now());
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
      const active = googleZoneActive(plan, camera);
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
