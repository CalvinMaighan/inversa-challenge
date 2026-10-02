import { beforeEach, describe, expect, test } from "bun:test";
import { PYTHON_LAYERS, selectPython } from "@/tests/client/python-app";
import { get, init, set } from "@calvinjs/active-state";

import { LAYERS, SELECTION, state, TIME, VIEW, VOICE } from "client/state";
import type { LayersState } from "client/state/layers";
import type { SelectionState } from "client/state/selection";
import { timeWindow, type TimeState } from "client/state/time";
import type { ViewState } from "client/state/view";
import type { VoiceState } from "client/state/voice";
import { resolvePlace } from "client/voice/gazetteer";
import { bboxAround, readHudState } from "client/voice/hud-state";
import { applyUiCommand } from "client/voice/ui-command-handler";

selectPython();

init(state);

const NOW = Date.parse("2026-09-30T20:40:00Z");
const WINDOW = timeWindow(NOW);

beforeEach(() => {
  set(VIEW, VIEW.defaults);
  set(TIME, { ...TIME.defaults, ...WINDOW });
  set(LAYERS, PYTHON_LAYERS);
  set(SELECTION, SELECTION.defaults);
  set(VOICE, VOICE.defaults);
});

const view = () => get<ViewState>(VIEW)!;
const time = () => get<TimeState>(TIME)!;
const layers = () => get<LayersState>(LAYERS)!;
const selection = () => get<SelectionState>(SELECTION)!;

describe("ui command handler", () => {
  test("fly_to with lat/lon moves the camera, updates bbox and bumps seq", () => {
    expect(applyUiCommand({ name: "fly_to", args: { lat: 25.5, lon: -80.9, altitudeM: 5000 } }, NOW)).toBe(true);
    expect(view()).toEqual({
      ...VIEW.defaults,
      lat: 25.5,
      lon: -80.9,
      altitudeM: 5000,
      bbox: bboxAround(25.5, -80.9, 5000),
      place: null,
      seq: 1,
    });
    applyUiCommand({ name: "fly_to", args: { lat: 25.5, lon: -80.9 } }, NOW);
    expect(view().seq).toBe(2);
    expect(view().altitudeM).toBe(25_000);
    expect(get<VoiceState>(VOICE)!.lastCommand).toBe("fly_to");
  });

  test("fly_to with a place resolves through the gazetteer", () => {
    expect(applyUiCommand({ name: "fly_to", args: { place: "flamingo" } }, NOW)).toBe(true);
    const flamingo = resolvePlace("Flamingo")!;
    expect(view()).toMatchObject({ lat: flamingo.lat, lon: flamingo.lon, place: "Flamingo", altitudeM: flamingo.altitudeM });
    expect(view().heading).toBe(VIEW.defaults.heading);
  });

  test("fly_to to an unknown place changes nothing", () => {
    expect(applyUiCommand({ name: "fly_to", args: { place: "Atlantis" } }, NOW)).toBe(false);
    expect(view()).toEqual(VIEW.defaults);
    expect(get<VoiceState>(VOICE)!.lastCommand).toBeNull();
  });

  test("invalid args are rejected on the client too", () => {
    expect(applyUiCommand({ name: "fly_to", args: { lat: 200, lon: 0 } }, NOW)).toBe(false);
    // `radar` became a real layer in GE5; `traffic` is one no app has.
    expect(applyUiCommand({ name: "toggle_layer", args: { layer: "traffic", visible: true } }, NOW)).toBe(false);
    expect(applyUiCommand({ name: "select", args: { evidenceId: "mission:12" } }, NOW)).toBe(false);
    expect(applyUiCommand({ name: "rm_rf", args: {} }, NOW)).toBe(false);
    expect(view()).toEqual(VIEW.defaults);
    expect(selection()).toEqual(SELECTION.defaults);
  });

  test("set_time snaps into the two-year window and pauses; now is the live edge", () => {
    set(TIME, { ...time(), playing: true });
    expect(applyUiCommand({ name: "set_time", args: { time: "2026-09-29T22:07:00-04:00" } }, NOW)).toBe(true);
    expect(time()).toMatchObject({ at: "2026-09-30T02:00:00.000Z", playing: false, ...{ from: WINDOW.from, to: WINDOW.to } });
    expect(applyUiCommand({ name: "set_time", args: { time: "2027-01-01T00:00:00Z" } }, NOW)).toBe(true);
    expect(time()).toMatchObject({ at: WINDOW.to, from: WINDOW.from });
    expect(applyUiCommand({ name: "set_time", args: { time: "now" } }, NOW)).toBe(true);
    expect(time().at).toBe(WINDOW.to);
    expect(applyUiCommand({ name: "set_time", args: { time: "yesterday-ish" } }, NOW)).toBe(false);
    expect(time().at).toBe(WINDOW.to);
  });

  test("set_time before the two-year window recentres the window on it", () => {
    expect(applyUiCommand({ name: "set_time", args: { time: "2024-02-01T17:00:00Z" } }, NOW)).toBe(true);
    expect(time()).toMatchObject({
      at: "2024-02-01T17:00:00.000Z",
      from: "2023-02-01T17:00:00.000Z",
      to: "2025-01-31T17:00:00.000Z",
      playing: false,
    });
    // Back into the live window: the live window returns.
    expect(applyUiCommand({ name: "set_time", args: { time: "2026-09-20T00:00:00Z" } }, NOW)).toBe(true);
    expect(time()).toMatchObject({ at: "2026-09-20T00:00:00.000Z", from: WINDOW.from, to: WINDOW.to });
  });

  test("play_timeline accepts a window before the live one, capped at two years and at now", () => {
    expect(
      applyUiCommand({ name: "play_timeline", args: { from: "2026-01-30T00:00:00Z", to: "2026-02-04T00:00:00Z" } }, NOW),
    ).toBe(true);
    expect(time()).toMatchObject({ at: "2026-01-30T00:00:00.000Z", from: "2026-01-30T00:00:00.000Z", to: "2026-02-04T00:00:00.000Z", playing: true });
    // Only from: keeps the current end when that makes a window of at most a year.
    expect(applyUiCommand({ name: "play_timeline", args: { from: "2026-02-01T00:00:00Z" } }, NOW)).toBe(true);
    expect(time()).toMatchObject({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-04T00:00:00.000Z" });
    // Only from, far from the current end: the year from it.
    expect(applyUiCommand({ name: "play_timeline", args: { from: "2023-06-01T00:00:00Z" } }, NOW)).toBe(true);
    expect(time()).toMatchObject({ from: "2023-06-01T00:00:00.000Z", to: "2025-05-31T00:00:00.000Z" });
    // A span over a year keeps its end; an end in the future stops at now.
    expect(applyUiCommand({ name: "play_timeline", args: { from: "2023-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" } }, NOW)).toBe(true);
    expect(time()).toMatchObject({ from: WINDOW.from, to: WINDOW.to, at: WINDOW.from });
  });

  test("play_timeline narrows the window, starts at from, and applies speed defaults", () => {
    expect(
      applyUiCommand({ name: "play_timeline", args: { from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z" } }, NOW),
    ).toBe(true);
    expect(time()).toEqual({
      at: "2026-09-20T00:00:00.000Z",
      playing: true,
      speed: 8,
      from: "2026-09-20T00:00:00.000Z",
      to: "2026-09-21T00:00:00.000Z",
    });
    expect(applyUiCommand({ name: "play_timeline", args: { playing: false, speed: 4 } }, NOW)).toBe(true);
    expect(time()).toMatchObject({ playing: false, speed: 4, from: "2026-09-20T00:00:00.000Z" });
    expect(
      applyUiCommand({ name: "play_timeline", args: { from: "2026-09-21T00:00:00Z", to: "2026-09-20T00:00:00Z" } }, NOW),
    ).toBe(false);
  });

  test("toggle_layer maps to setLayerVisible and setSpeciesVisible", () => {
    expect(applyUiCommand({ name: "toggle_layer", args: { layer: "lst", visible: true } }, NOW)).toBe(true);
    expect(layers().visible.lst).toBe(true);

    // Hiding the species filters it without hiding the layer; another app's species is refused.
    expect(applyUiCommand({ name: "toggle_layer", args: { layer: "sightings", visible: false, species: "lionfish" } }, NOW)).toBe(false);
    expect(applyUiCommand({ name: "toggle_layer", args: { layer: "sightings", visible: false, species: "python" } }, NOW)).toBe(true);
    expect(layers().species.python).toBe(false);
    expect(layers().visible.sightings).toBe(true);

    // Showing a species on a hidden layer turns the layer on.
    applyUiCommand({ name: "toggle_layer", args: { layer: "sightings", visible: false } }, NOW);
    expect(layers().visible.sightings).toBe(false);
    applyUiCommand({ name: "toggle_layer", args: { layer: "sightings", visible: true, species: "python" } }, NOW);
    expect(layers().visible.sightings).toBe(true);
    expect(layers().species.python).toBe(true);
  });

  test("select and open_evidence drive SELECTION", () => {
    expect(applyUiCommand({ name: "select", args: { evidenceId: "sighting:123" } }, NOW)).toBe(true);
    expect(selection()).toEqual({ evidenceId: "sighting:123", drawerOpen: false });
    expect(applyUiCommand({ name: "open_evidence", args: { evidenceId: "alert:9" } }, NOW)).toBe(true);
    expect(selection()).toEqual({ evidenceId: "alert:9", drawerOpen: true });
  });

  test("hud state reflects the keys", () => {
    applyUiCommand({ name: "fly_to", args: { place: "Key West" } }, NOW);
    applyUiCommand({ name: "select", args: { evidenceId: "hotspot:python:10:20:1759190400000" } }, NOW);
    applyUiCommand({ name: "toggle_layer", args: { layer: "hotspots", visible: false, species: "python" } }, NOW);
    const hud = readHudState();
    expect(hud.camera.place).toBe("Key West");
    expect(hud.bbox).toEqual(view().bbox);
    expect(hud.time).toMatchObject({ live: true, at: WINDOW.to });
    expect(hud.layers).toEqual(["sightings", "missions", "peers", "notes"]);
    // "Hide pythons on hotspots" switches the species off: nothing is shown.
    expect(hud.species).toEqual([]);
    expect(hud.selection).toBe("hotspot:python:10:20:1759190400000");
  });

  test("bbox span scales with altitude", () => {
    const low = bboxAround(25, -81, 10_000);
    const high = bboxAround(25, -81, 100_000);
    expect(high.north - high.south).toBeGreaterThan((low.north - low.south) * 9);
    expect(low.north - low.south).toBeCloseTo((2 * 10_000 * Math.tan(Math.PI / 6)) / 111_320, 3);
  });
});

describe("gazetteer", () => {
  test("matches names and aliases, case and punctuation insensitive", () => {
    expect(resolvePlace("FLAMINGO")?.name).toBe("Flamingo");
    expect(resolvePlace("the Anhinga Trail")?.name).toBe("Royal Palm");
    expect(resolvePlace("Key West, FL")?.name).toBe("Key West");
    expect(resolvePlace("Florida City")?.name).toBe("Florida City");
    expect(resolvePlace("")).toBeNull();
    expect(resolvePlace("Gotham")).toBeNull();
  });
});
