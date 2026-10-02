/**
 * The zoom controller's contract for the HUD (gates/leaf-GE8.md): the Cesium side (`controller.ts`) registers it
 * when the globe mounts, the zoom controls (`client/hud/zoom`) read and drive it without importing Cesium.
 */
import type { ImageryRoute, ZoomLimits } from "./model";

export type ZoomState = ZoomLimits & {
  /** Camera height above the ellipsoid, metres. */
  altitudeM: number;
  /** Camera height above the ground under it (terrain or 3D tiles), metres; null before the ground is known. */
  clearanceM: number | null;
  route: ImageryRoute | string;
  google3d: string;
  /** Google 3D under the camera: the 30 m limit and the oblique tilt apply. */
  threeD: boolean;
  /** Camera pitch, degrees (-90 straight down). */
  pitchDeg: number;
  /** Times a zoom tilted the view for Google 3D (the "3D city view" hint shows on the first). */
  autoTilts: number;
};

export type ZoomApi = {
  state(): ZoomState;
  /** Called (at most once a frame) when the altitude, the limits or the imagery change. */
  subscribe(cb: (state: ZoomState) => void): () => void;
  /** Animated steps about the screen centre: positive zooms in (×0.5 per press), negative out (×2). */
  step(presses: number): void;
  /** Go to an altitude about the screen centre, animated unless `animate` is false (a slider drag). */
  setAltitude(altitudeM: number, opts?: { animate?: boolean }): void;
};

let current: ZoomApi | null = null;
const listeners = new Set<(api: ZoomApi | null) => void>();

export function registerZoom(api: ZoomApi | null): void {
  current = api;
  for (const cb of listeners) cb(api);
}

export function getZoom(): ZoomApi | null {
  return current;
}

/** Calls `cb` with the controller now and whenever it changes (null when the globe unmounts). */
export function onZoom(cb: (api: ZoomApi | null) => void): () => void {
  cb(current);
  listeners.add(cb);
  return () => listeners.delete(cb);
}
