"use client";

import FishMarkers from "./FishMarkers";
import FishTimeline from "./FishTimeline";

/** The carp app's map: the Asian carp sightings and their timeline. (The gauge locations, review board and stage timeline are not part of the demo.) */
export default function CarpFishHud() {
  return (
    <>
      <FishMarkers />
      <FishTimeline />
    </>
  );
}
