import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import { get, init, set } from "@calvinjs/active-state";

import {
  EVIDENCE_ALTITUDE_M,
  applyAgentSideEffects,
  applyViewEvent,
  bboxCamera,
  evidenceCoordinates,
  openEvidence,
} from "client/agent/chat/effects";
import { registerGlobe, type CameraTarget } from "client/globe/api";
import { SELECTION, TIME, state } from "client/state";
import { timeWindow, type TimeState } from "client/state/time";
import { altitudeToFit } from "client/state/view";

selectPython();

init(state);

const FIXTURE_NOW = Date.parse("2026-01-15T03:00:00Z");
let flights: CameraTarget[] = [];

beforeEach(() => {
  flights = [];
  registerGlobe({
    flyTo: (target) => flights.push(target),
    project: () => null,
    pick: () => null,
    onPostRender: () => () => {},
    requestRender: () => {},
  });
  set(SELECTION, { ...SELECTION.defaults });
  set<TimeState>(TIME, { ...TIME.defaults, ...timeWindow(FIXTURE_NOW) });
});

afterEach(() => registerGlobe(null));

describe("agent side effects", () => {
  test("hotspot ids carry their cell centre (C14 0.01° grid from 24.3N 83.2W)", () => {
    // Cell 243:145 is the Shark Valley levee cell in the eval fixtures.
    expect(evidenceCoordinates("hotspot:python:243:145:1768446000000")).toEqual({ lon: -80.765, lat: 25.755 });
    expect(evidenceCoordinates("hotspot:tegu:0:0:1")).toEqual({ lon: -83.195, lat: 24.305 });
  });

  test("ids without coordinates, malformed or off-grid cells give null", () => {
    for (const id of [
      "sighting:2001",
      "reading:NP205:stage_m:1768446000000:usgs",
      "alert:urn:oid:2.49.0.1",
      "hotspot:python:243:1768446000000",
      "hotspot:python:a:b:1",
      "hotspot:python:-1:4:1",
      "hotspot:python:340:0:1",
      "hotspot:python:0:320:1",
      "bogus:1",
    ]) {
      expect(evidenceCoordinates(id)).toBeNull();
    }
  });

  test("view event flies to the box centre at a height that fits it and moves TIME", () => {
    const bbox = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };
    applyViewEvent({ type: "view", bbox, time: "2026-01-14T21:07:00Z" }, FIXTURE_NOW);
    expect(flights).toEqual([{ lon: -80.445, lat: 25.47, altitudeM: altitudeToFit(bbox), heading: 0, pitch: -90 }]);
    // Snapped to the 15-minute frame grid.
    expect(get<TimeState>(TIME)!.at).toBe("2026-01-14T21:00:00.000Z");
    expect(get<TimeState>(TIME)!.playing).toBe(false);
  });

  test("view time after now lands on the live edge", () => {
    applyAgentSideEffects({ type: "view", bbox: { west: -81, south: 25, east: -80, north: 26 }, time: "2027-01-01T00:00:00Z" }, FIXTURE_NOW);
    expect(get<TimeState>(TIME)).toMatchObject(timeWindow(FIXTURE_NOW));
  });

  test("view time before the replay window recentres the window on it", () => {
    applyViewEvent({ type: "view", bbox: { west: -81, south: 25, east: -80, north: 26 }, time: "2025-11-01T17:05:00Z" }, FIXTURE_NOW);
    expect(get<TimeState>(TIME)).toMatchObject({
      at: "2025-11-01T17:00:00.000Z",
      from: "2025-10-17T17:00:00.000Z",
      to: "2025-11-16T17:00:00.000Z",
      playing: false,
    });
    // Back inside the new window only the cursor moves.
    applyViewEvent({ type: "view", bbox: { west: -81, south: 25, east: -80, north: 26 }, time: "2025-11-10T00:00:00Z" }, FIXTURE_NOW);
    expect(get<TimeState>(TIME)).toMatchObject({ at: "2025-11-10T00:00:00.000Z", from: "2025-10-17T17:00:00.000Z" });
  });

  test("an unreadable view time moves the camera but not TIME", () => {
    const before = get<TimeState>(TIME);
    applyViewEvent({ type: "view", bbox: { west: -81, south: 25, east: -80, north: 26 }, time: "not a date" }, FIXTURE_NOW);
    expect(flights).toHaveLength(1);
    expect(get<TimeState>(TIME)).toEqual(before);
  });

  test("other events have no side effects", () => {
    const before = get<TimeState>(TIME);
    applyAgentSideEffects({ type: "content_delta", text: "hi" });
    applyAgentSideEffects({ type: "citation", id: "sighting:1", kind: "sighting", label: "x" });
    expect(flights).toEqual([]);
    expect(get<TimeState>(TIME)).toEqual(before);
  });

  test("a citation click selects the evidence and opens the drawer", () => {
    openEvidence("sighting:2001");
    expect(get<Record<string, unknown>>(SELECTION)).toEqual({ evidenceId: "sighting:2001", drawerOpen: true });
    // No coordinates in a sighting id: the camera stays put.
    expect(flights).toEqual([]);
  });

  test("a hotspot citation also flies the globe to the cell", () => {
    openEvidence("hotspot:python:243:145:1768446000000");
    expect(get<Record<string, unknown>>(SELECTION)).toEqual({ evidenceId: "hotspot:python:243:145:1768446000000", drawerOpen: true });
    expect(flights).toEqual([{ lon: -80.765, lat: 25.755, altitudeM: EVIDENCE_ALTITUDE_M }]);
  });

  test("no globe registered: effects still update state", () => {
    registerGlobe(null);
    openEvidence("hotspot:python:243:145:1");
    expect(get<{ evidenceId: string }>(SELECTION)!.evidenceId).toBe("hotspot:python:243:145:1");
    expect(bboxCamera({ west: -1, south: -1, east: 1, north: 1 })).toMatchObject({ lon: 0, lat: 0 });
  });
});
