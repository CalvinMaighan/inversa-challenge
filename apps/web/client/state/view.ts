import { key } from "@calvinjs/active-state";

import type { BBox } from "shared/agent/events";

/** South Florida region (PLAN.md C15). */
export const REGION_BBOX: Readonly<BBox> = Object.freeze({ west: -83.2, south: 24.3, east: -79.8, north: 27.5 });

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

const defaults: ViewState = {
  bbox: { ...REGION_BBOX },
  lat: (REGION_BBOX.south + REGION_BBOX.north) / 2,
  lon: (REGION_BBOX.west + REGION_BBOX.east) / 2,
  altitudeM: altitudeToFit(REGION_BBOX),
  heading: 0,
  pitch: -90,
  place: null,
  seq: 0,
};

export const VIEW = key("VIEW", defaults);
