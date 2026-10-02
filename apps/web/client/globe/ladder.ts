/**
 * Imagery ladder decisions (after God's Eye View `src/maps/imagery.js` and `google3d.js`), kept free of Cesium
 * so they are unit-tested. `imagery.ts` turns a plan into providers.
 *
 * - Google Maps key, under its monthly cap: Google Photorealistic 3D Tiles straight from the Map Tiles API
 *   (route `google-direct`), tried before ion.
 * - ion token and quota headroom: Cesium World Terrain, Bing aerial through ion, and Google 3D through ion asset
 *   2275207 (first choice without a Google key, the fallback when the direct load fails).
 * - otherwise: keyless Esri World Imagery on the ellipsoid, with OpenStreetMap if Esri fails, and no Google 3D.
 *
 * Google 3D only shows while the camera is low over the active app's zone, where it pays off: Miami and the Keys
 * (python, lionfish), the Louisiana river sites (carp).
 */
import type { BBox } from "shared/agent/events";
import type { AppId } from "shared/apps";

import { googleCapReached, quotaExhausted, type GoogleQuota, type QuotaCounts } from "./quota";

/** ion asset ids (Community plan). */
export const ION_ASSETS = { worldTerrain: 1, bingAerial: 2, googlePhotorealistic: 2275207 } as const;

/** The Map Tiles API root of the photorealistic tileset; the key goes in the `key` query parameter. */
export const GOOGLE_TILES_ROOT = "https://tile.googleapis.com/v1/3dtiles/root.json";

const box = (west: number, south: number, east: number, north: number): Readonly<BBox> => Object.freeze({ west, south, east, north });

/**
 * Miami/Keys as three boxes, so the Everglades interior and Florida Bay between them stay on aerial imagery:
 * Miami-Dade and Broward, the Upper Keys (Key Largo to Islamorada), and the Middle and Lower Keys to Key West.
 */
export const GOOGLE_3D_ZONE: readonly Readonly<BBox>[] = Object.freeze([box(-80.55, 25.4, -79.95, 26.35), box(-80.75, 24.85, -80.2, 25.4), box(-82.1, 24.4, -80.7, 24.95)]);

/**
 * Louisiana (carp) around the demonstration river sites (spec/apps/carp.json): the Atchafalaya from Simmesport to
 * Morgan City with Baton Rouge on the Mississippi, the Red River at Alexandria, the Ouachita at Monroe, and the
 * Pearl near Bogalusa. The basin between them stays on aerial imagery.
 */
export const LOUISIANA_3D_ZONE: readonly Readonly<BBox>[] = Object.freeze([
  box(-92.0, 29.55, -91.0, 31.1),
  box(-92.6, 31.15, -92.3, 31.45),
  box(-92.25, 32.4, -92.0, 32.6),
  box(-89.95, 30.68, -89.7, 30.9),
]);

export const GOOGLE_3D_ZONES: Readonly<Record<AppId, readonly Readonly<BBox>[]>> = Object.freeze({
  python: GOOGLE_3D_ZONE,
  lionfish: GOOGLE_3D_ZONE,
  carp: LOUISIANA_3D_ZONE,
});

/** Above this the photorealistic mesh adds nothing over aerial imagery but costs tiles. */
export const GOOGLE_3D_MAX_ALTITUDE_M = 30_000;

export type BaseImagery = "bing" | "esri" | "osm";
/** Where the Google 3D tileset comes from: the Map Tiles API with the browser's key, or ion asset 2275207. */
export type Google3dRoute = "direct" | "ion";

export type LadderPlan = {
  route: "google-direct" | "ion" | "keyless";
  terrain: "world" | "ellipsoid";
  base: BaseImagery;
  /** Next rung if `base` fails to load. */
  fallback: BaseImagery | null;
  /** Google 3D routes in the order they are tried; empty: no Google 3D (still gated by camera position). */
  google3d: readonly Google3dRoute[];
  reason: "google-key" | "token" | "no-token" | "quota";
};

export type LadderInput = {
  ionToken: string | undefined | null;
  quota: QuotaCounts;
  /** Browser key for the Map Tiles API; without one no Google request is planned. */
  googleKey?: string | undefined | null;
  /** This month's direct sessions and the cap; required for the direct route. */
  google?: GoogleQuota;
};

export function planLadder({ ionToken, quota, googleKey, google }: LadderInput): LadderPlan {
  const token = (ionToken ?? "").trim();
  const key = (googleKey ?? "").trim();
  const ionCapped = Boolean(token) && quotaExhausted(quota);
  const googleCapped = Boolean(key) && google !== undefined && googleCapReached(google);
  const ion = Boolean(token) && !ionCapped;
  const direct = Boolean(key) && google !== undefined && !googleCapped;
  const google3d: Google3dRoute[] = [...(direct ? (["direct"] as const) : []), ...(ion ? (["ion"] as const) : [])];
  const base = ion
    ? ({ terrain: "world", base: "bing", fallback: "esri" } as const)
    : ({ terrain: "ellipsoid", base: "esri", fallback: "osm" } as const);
  const route = direct ? "google-direct" : ion ? "ion" : "keyless";
  const reason = direct ? "google-key" : ion ? "token" : ionCapped || googleCapped ? "quota" : "no-token";
  return { route, ...base, google3d, reason };
}

/** Rung to try after `failed`; null when the ladder is exhausted. */
export function nextRung(failed: BaseImagery): BaseImagery | null {
  return failed === "bing" ? "esri" : failed === "esri" ? "osm" : null;
}

/** The Google 3D route to try after `failed`; null when none is left (the globe keeps its base imagery). */
export function next3dRoute(plan: LadderPlan, failed: Google3dRoute): Google3dRoute | null {
  const i = plan.google3d.indexOf(failed);
  return i >= 0 ? (plan.google3d[i + 1] ?? null) : null;
}

/**
 * Load the Google 3D tileset down the plan's routes: the first route that loads wins; a failure is reported and
 * the next route tried. Resolves null when every route failed or the plan has none (keyless: no request at all).
 */
export async function loadGoogle3d<T>(
  plan: LadderPlan,
  loaders: Record<Google3dRoute, () => Promise<T>>,
  onFail: (route: Google3dRoute, err: unknown) => void = () => {},
): Promise<{ route: Google3dRoute; tileset: T } | null> {
  for (let route: Google3dRoute | null = plan.google3d[0] ?? null; route; route = next3dRoute(plan, route)) {
    try {
      return { route, tileset: await loaders[route]() };
    } catch (err) {
      onFail(route, err);
    }
  }
  return null;
}

export type CameraSample = { lon: number; lat: number; altitudeM: number };

export function insideBBox(bbox: Readonly<BBox>, lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

/** Whether the Google 3D tileset should be on for this camera, over `zones` (Miami/Keys unless given). */
export function googleZoneActive(plan: LadderPlan, camera: CameraSample, zones: readonly Readonly<BBox>[] = GOOGLE_3D_ZONE): boolean {
  return plan.google3d.length > 0 && camera.altitudeM < GOOGLE_3D_MAX_ALTITUDE_M && zones.some((b) => insideBBox(b, camera.lon, camera.lat));
}
