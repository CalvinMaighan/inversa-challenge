"use client";

import { getGlobe } from "client/globe/api";
import { fitInPane } from "client/globe/fit";
import { isSurveyApp } from "client/lionfish/model";
import styled from "client/styled";

import { useActiveApp } from "../appselect/use-active-app";

/** The app's one location, inline above the timeline at its left, selected: a click frames it again. */
const Area = styled.div`
  position: absolute;
  left: 0;
  bottom: calc(100% + var(--gap-m));
  display: flex;
  gap: var(--gap-s);

  button {
    height: 28px;
    padding: 0 var(--gap-m);
    border: 1px solid var(--accent);
    border-radius: var(--radius-round);
    background: color-mix(in oklch, var(--accent) 22%, var(--surface));
    box-shadow: var(--shadow);
    color: var(--text);
    font: 600 12px / 1 var(--font-ui);
    cursor: pointer;
  }
  button:hover {
    border-color: var(--hud-line);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/**
 * A species app's location, from its region: "Florida" for python, "Florida Keys" for lionfish (the first of its four
 * areas, `fl-keys`). Rendered inside the timeline's root, which it sits above.
 */
export default function RegionChip() {
  const app = useActiveApp();
  const survey = isSurveyApp(app);
  const region = survey ? (app.regions.find((r) => r.id === "fl-keys") ?? app.regions[0]) : app.regions[0];
  if (app.kind !== "species" || !region) return null;
  const name = survey ? "Florida Keys" : /florida/i.test(region.name) ? "Florida" : region.name;
  const fly = () => {
    const pose = fitInPane(region.bbox, 24) ?? { lat: region.camera.lat, lon: region.camera.lon, altitudeM: region.camera.heightM, heading: 0, pitch: -90 };
    getGlobe()?.flyTo({ ...pose, durationS: 1.2 });
  };
  return (
    <Area role="group" aria-label="Location" data-testid="region-chip">
      <button type="button" aria-pressed="true" data-area={region.id} onClick={fly}>
        {name}
      </button>
    </Area>
  );
}
