import { describe, expect, test } from "bun:test";

import { posesDiffer, shouldFly, viewFromPose, wrapDegrees, type CameraPose, type ViewValue } from "client/globe/camera";
import { VIEW } from "client/state/view";

const base: ViewValue = { ...VIEW.defaults };
const pose = (over: Partial<CameraPose> = {}): CameraPose => ({ lon: base.lon, lat: base.lat, altitudeM: base.altitudeM, heading: 0, pitch: -90, ...over });

describe("camera ↔ VIEW", () => {
  test("wrapDegrees normalises longitudes and heading deltas", () => {
    expect(wrapDegrees(190)).toBe(-170);
    expect(wrapDegrees(-190)).toBe(170);
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-180)).toBe(180);
  });

  test("posesDiffer ignores float noise, catches real moves", () => {
    expect(posesDiffer(pose(), pose({ lon: base.lon + 1e-6, altitudeM: base.altitudeM * 1.001 }))).toBe(false);
    expect(posesDiffer(pose(), pose({ lon: base.lon + 0.01 }))).toBe(true);
    expect(posesDiffer(pose(), pose({ altitudeM: base.altitudeM * 1.2 }))).toBe(true);
    expect(posesDiffer(pose({ heading: 359.9 }), pose({ heading: 0.1 }))).toBe(false);
    expect(posesDiffer(pose(), pose({ pitch: -45 }))).toBe(true);
  });

  test("viewFromPose keeps fields it does not own and the old bbox when no ground is in view", () => {
    const prev: ViewValue = { ...base, seq: 4, place: "Flamingo" };
    const next = viewFromPose(prev, pose({ lon: -80.912345678, lat: 25.1412345, altitudeM: 12_345.6, heading: -10, pitch: -60.04 }), null);
    expect(next).toMatchObject({ seq: 4, place: "Flamingo", lon: -80.91235, lat: 25.14123, altitudeM: 12_346, heading: 350, pitch: -60 });
    expect(next.bbox).toBe(prev.bbox);
    const withBox = viewFromPose(prev, pose(), { west: -81.123456, south: 25, east: -80, north: 26 });
    expect(withBox.bbox).toEqual({ west: -81.1235, south: 25, east: -80, north: 26 });
  });

  test("no loop: the globe ignores the VIEW it wrote", () => {
    const written = viewFromPose(base, pose({ lon: -80.5 }), null);
    const state = { lastWritten: written, handledSeq: undefined };
    expect(shouldFly(written, pose(), state)).toBe(false);
  });

  test("an external VIEW that matches the camera does not fly; one that differs does", () => {
    // The globe starts with the seq it mounted with, so the initial VIEW is not a fly request.
    const state = { lastWritten: null, handledSeq: base.seq as number | undefined };
    expect(shouldFly({ ...base }, pose(), state)).toBe(false);
    expect(shouldFly({ ...base, lon: -80.2, lat: 25.8 }, pose(), state)).toBe(true);
  });

  test("a seq bump always flies, once", () => {
    const state = { lastWritten: null, handledSeq: 2 as number | undefined };
    const v = { ...base, seq: 3, place: "Miami" };
    expect(shouldFly(v, pose(), state)).toBe(true);
    expect(state.handledSeq).toBe(3);
    expect(shouldFly({ ...v }, pose(), state)).toBe(false);
  });
});
