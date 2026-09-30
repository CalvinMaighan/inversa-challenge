/**
 * Imagery ladder decisions (after God's Eye View `src/maps/imagery.js` and `google3d.js`), kept free of Cesium
 * so they are unit-tested. `imagery.ts` turns a plan into providers.
 *
 * - ion token and quota headroom: Cesium World Terrain, Bing aerial through ion, and Google Photorealistic 3D
 *   Tiles (ion asset 2275207) only while the camera is low over Miami and the Keys, where they pay off.
 * - otherwise: keyless Esri World Imagery on the ellipsoid, with OpenStreetMap if Esri fails.
 */
import type { BBox } from "shared/agent/events";

import { quotaExhausted, type QuotaCounts } from "./quota";

/** ion asset ids (Community plan). */
export const ION_ASSETS = { worldTerrain: 1, bingAerial: 2, googlePhotorealistic: 2275207 } as const;

/**
 * Miami/Keys as three boxes, so the Everglades interior and Florida Bay between them stay on aerial imagery:
 * Miami-Dade and Broward, the Upper Keys (Key Largo to Islamorada), and the Middle and Lower Keys to Key West.
 */
export const GOOGLE_3D_ZONE: readonly Readonly<BBox>[] = Object.freeze([
  Object.freeze({ west: -80.55, south: 25.4, east: -79.95, north: 26.35 }),
  Object.freeze({ west: -80.75, south: 24.85, east: -80.2, north: 25.4 }),
  Object.freeze({ west: -82.1, south: 24.4, east: -80.7, north: 24.95 }),
]);
/** Above this the photorealistic mesh adds nothing over aerial imagery but costs tiles. */
export const GOOGLE_3D_MAX_ALTITUDE_M = 30_000;

export type BaseImagery = "bing" | "esri" | "osm";

export type LadderPlan = {
  route: "ion" | "keyless";
  terrain: "world" | "ellipsoid";
  base: BaseImagery;
  /** Next rung if `base` fails to load. */
  fallback: BaseImagery | null;
  /** Google 3D may be shown (still gated by camera position). */
  google3d: boolean;
  reason: "token" | "no-token" | "quota";
};

export function planLadder({ ionToken, quota }: { ionToken: string | undefined | null; quota: QuotaCounts }): LadderPlan {
  const token = (ionToken ?? "").trim();
  if (!token) return { route: "keyless", terrain: "ellipsoid", base: "esri", fallback: "osm", google3d: false, reason: "no-token" };
  if (quotaExhausted(quota)) return { route: "keyless", terrain: "ellipsoid", base: "esri", fallback: "osm", google3d: false, reason: "quota" };
  return { route: "ion", terrain: "world", base: "bing", fallback: "esri", google3d: true, reason: "token" };
}

/** Rung to try after `failed`; null when the ladder is exhausted. */
export function nextRung(failed: BaseImagery): BaseImagery | null {
  return failed === "bing" ? "esri" : failed === "esri" ? "osm" : null;
}

export type CameraSample = { lon: number; lat: number; altitudeM: number };

export function insideBBox(bbox: Readonly<BBox>, lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

/** Whether the Google 3D tileset should be on for this camera. */
export function googleZoneActive(plan: LadderPlan, camera: CameraSample): boolean {
  return plan.google3d && camera.altitudeM < GOOGLE_3D_MAX_ALTITUDE_M && GOOGLE_3D_ZONE.some((box) => insideBBox(box, camera.lon, camera.lat));
}
