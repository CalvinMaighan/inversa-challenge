import { key } from "@calvinjs/active-state";

import type { BBox } from "shared/agent/events";
import { appBBox, DEFAULT_APP_ID, getApp, type AppConfig } from "shared/apps";

export type ViewState = {
  /** Visible extent, kept in sync by the globe camera. */
  bbox: BBox;
  /** Camera position, degrees. */
  lat: number;
  lon: number;
  /** Camera height above the ellipsoid, metres. */
  altitudeM: number;
  /** Degrees clockwise from north. */
  heading: number;
  /** Degrees; -90 looks straight down. */
  pitch: number;
  /** Named target of the last fly command (voice `fly_to`), or null. */
  place: string | null;
  /** Bumped on every fly command, so the globe re-flies even to the same spot. */
  seq: number;
};

/**
 * Camera height that fits `bbox` in a 60° vertical field of view: half the larger side (converted to metres at
 * the box's mid latitude) over tan(30°), with 10 % margin.
 */
export function altitudeToFit(bbox: BBox): number {
  const midLat = ((bbox.south + bbox.north) / 2) * (Math.PI / 180);
  const metresPerDeg = 111_320;
  const width = (bbox.east - bbox.west) * metresPerDeg * Math.cos(midLat);
  const height = (bbox.north - bbox.south) * metresPerDeg;
  return Math.round(((Math.max(width, height) / 2) / Math.tan(Math.PI / 6)) * 1.1);
}

/**
 * The map preset of an app (C-A3): its whole extent (every region), looked at from the first region's camera
 * when the config gives one, else from the extent's centre, high enough to fit it.
 */
export function viewFor(app: AppConfig, seq = 0): ViewState {
  const bbox = appBBox(app);
  const camera = app.regions.length === 1 ? app.regions[0]!.camera : undefined;
  return {
    bbox,
    lat: camera?.lat ?? (bbox.south + bbox.north) / 2,
    lon: camera?.lon ?? (bbox.west + bbox.east) / 2,
    altitudeM: camera?.altitudeM ?? altitudeToFit(bbox),
    heading: camera?.heading ?? 0,
    pitch: camera?.pitch ?? -90,
    place: null,
    seq,
  };
}

/** Server HTML and first paint use the default app; `AppBoot` moves to the resolved one after hydration. */
export const VIEW = key("VIEW", viewFor(getApp(DEFAULT_APP_ID)));
