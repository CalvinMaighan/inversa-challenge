/**
 * The carp map's one set location: the Mississippi River Basin, selected by default. A click frames it again (the camera
 * fits `bbox` in the scope circle).
 */
import type { BBox } from "shared/agent/events";

export type Area = { id: string; name: string; lat: number; lon: number; altitudeM: number; bbox: BBox };

/** The basin's main corridor, Gulf to Minnesota: the box the sightings are pulled for (api/src/carp_fish.rs). */
export const BASIN_BBOX: BBox = { west: -97, south: 28.9, east: -82, north: 47 };

export const CARP_AREAS: readonly Area[] = [
  { id: "mississippi-basin", name: "Mississippi River Basin", lat: 38, lon: -89.5, altitudeM: 2_400_000, bbox: BASIN_BBOX },
];
