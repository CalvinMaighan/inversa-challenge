"use client";

import { useEffect } from "react";
import { set } from "@calvinjs/active-state";

import { fitInPane } from "client/globe/fit";
import { gateOpen } from "client/intro/gate";
import { VIEW, type ViewState } from "client/state/view";

import { BASIN_BBOX } from "./areas";
import FishMarkers from "./FishMarkers";
import FishPanel from "./FishPanel";
import FishTimeline from "./FishTimeline";

/** The carp app's map: the Asian carp sightings of the Mississippi River Basin and their timeline. (The gauge locations, review board and stage timeline are not part of the demo.) */
export default function CarpFishHud() {
  // First view: the whole basin, fitted to the scope circle once the pane is laid out.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      // Behind the first-run gate the camera stays fully zoomed out; the gate flies it on entry.
      if (gateOpen()) return;
      const frame = fitInPane(BASIN_BBOX, 24);
      if (frame) set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, ...frame, place: null, seq: prev.seq + 1 }));
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <>
      <FishMarkers />
      <FishPanel />
      <FishTimeline />
    </>
  );
}
