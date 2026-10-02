import { describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import { get } from "@calvinjs/active-state";

import { bboxCamera } from "client/agent/chat/effects";
import { registerGlobe, type CameraTarget, type GlobeApi } from "client/globe/api";
import { altitudeToSlider, clampAltitude, limitsFor, MAX_ALT_M, placeScale, sliderToAltitude } from "client/globe/zoom/model";
import { decodeShareLink, encodeShareLink } from "client/hud/share-link";
import { applyShareState, readShareState } from "client/hud/share-link-store";
import { VIEW, type ViewState } from "client/state/view";

selectPython();

const flat = limitsFor(false);
const threeD = limitsFor(true);
const camera = (altitudeM: number, pitch = -90) => ({ lat: 25.7617, lon: -80.1918, altitudeM, heading: 0, pitch });

describe("share link zoom state", () => {
  test("the altitude travels in `c`, quantised to whole metres, and lands on the same slider notch", () => {
    for (const alt of [30, 412.4, 850, 12_345.6, 45_000, 1_234_567.8, MAX_ALT_M]) {
      const decoded = decodeShareLink(encodeShareLink({ app: "python", camera: camera(alt) }));
      expect(decoded.camera!.altitudeM).toBe(Math.round(alt));
      for (const limits of [flat, threeD]) {
        const a = clampAltitude(alt, limits);
        const back = sliderToAltitude(altitudeToSlider(decoded.camera!.altitudeM, limits), limits);
        expect(Math.abs(back - a) / a).toBeLessThan(0.01);
      }
      expect(placeScale(decoded.camera!.altitudeM)).toBe(placeScale(alt));
    }
  });

  test("the oblique pitch of a 3D city view travels too", () => {
    const decoded = decodeShareLink(encodeShareLink({ app: "python", camera: camera(600, -47.3) }));
    expect(decoded.camera).toEqual(camera(600, -47.3));
  });

  test("the link's altitude range is the zoom range: beyond the whole planet clamps to it", () => {
    const decoded = decodeShareLink("#v=2&app=python&c=25.7617,-80.1918,99000000,0,-90");
    expect(decoded.camera!.altitudeM).toBe(MAX_ALT_M);
  });

  test("a reopened link restores the zoom and flies the globe there (the globe then applies its limits)", () => {
    const flights: CameraTarget[] = [];
    const globe: GlobeApi = { flyTo: (t) => flights.push(t), project: () => null, pick: () => null, onPostRender: () => () => {}, requestRender: () => {} };
    registerGlobe(globe);
    const link = encodeShareLink({ app: "python", camera: camera(12_000) });
    applyShareState(decodeShareLink(link))();
    const view = get<ViewState>(VIEW)!;
    expect(view.altitudeM).toBe(12_000);
    expect(flights).toEqual([{ ...camera(12_000), durationS: 0 }]);
    expect(decodeShareLink(encodeShareLink(readShareState())).camera!.altitudeM).toBe(12_000);
    registerGlobe(null);
  });

  test("the agent's set_view still frames areas inside the limits; a tiny box is held at the minimum", () => {
    // A county-sized box (Miami-Dade): well inside the limits, unchanged.
    const county = bboxCamera({ west: -80.87, south: 25.14, east: -80.12, north: 25.98 });
    expect(clampAltitude(county.altitudeM!, flat)).toBe(county.altitudeM!);
    expect(placeScale(county.altitudeM!)).toBe("County");
    // One boat ramp (about 50 m across): the camera stops at 400 m over flat imagery, 30 m over Google 3D.
    const ramp = bboxCamera({ west: -80.4, south: 25.5, east: -80.3995, north: 25.5005 });
    expect(ramp.altitudeM!).toBeLessThan(400);
    expect(clampAltitude(ramp.altitudeM!, flat)).toBe(400);
    expect(clampAltitude(ramp.altitudeM!, threeD)).toBe(Math.max(30, ramp.altitudeM!));
  });
});
