/**
 * Fly the globe to a chosen place: a VIEW write with `seq` bumped (client/globe/camera.ts `shouldFly`), straight
 * down over the place so it lands in the middle of the circular stage. A place with an area (a park, a bay) is
 * framed whole; a point gets a town-sized view.
 */
import { set } from "@calvinjs/active-state";

import { VIEW } from "client/state";
import { altitudeToFit, type ViewState } from "client/state/view";
import { bboxAround } from "client/voice/hud-state";
import type { PlaceHit } from "shared/places";

export const POINT_ALTITUDE_M = 12_000;
const MIN_ALTITUDE_M = 3_000;
const MAX_ALTITUDE_M = 400_000;

/** Camera height for a hit: its area fitted, clamped, or the point default. */
export function altitudeFor(hit: Pick<PlaceHit, "viewport">): number {
  if (!hit.viewport) return POINT_ALTITUDE_M;
  return Math.min(MAX_ALTITUDE_M, Math.max(MIN_ALTITUDE_M, altitudeToFit(hit.viewport)));
}

/** The next VIEW for a hit (pure, for the tests). */
export function viewForHit(prev: ViewState, hit: PlaceHit): ViewState {
  const altitudeM = altitudeFor(hit);
  return { ...prev, lat: hit.lat, lon: hit.lon, altitudeM, heading: 0, pitch: -90, bbox: bboxAround(hit.lat, hit.lon, altitudeM), place: hit.name, seq: prev.seq + 1 };
}

export function flyToHit(hit: PlaceHit): void {
  set<ViewState>(VIEW, (prev = VIEW.defaults) => viewForHit(prev, hit));
}
