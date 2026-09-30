import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { get, set } from "@calvinjs/active-state";

import { resolvePlace } from "client/voice/gazetteer";
import { bboxAround, readHudState } from "client/voice/hud-state";
import { ensureVoiceState, LAYERS, SELECTION, TIME, VIEW, VOICE } from "client/voice/state";
import { applyUiCommand } from "client/voice/ui-command-handler";

beforeAll(() => ensureVoiceState());

beforeEach(() => {
  set(VIEW, { ...VIEW.defaults });
  set(TIME, { ...TIME.defaults });
  set(LAYERS, { ...LAYERS.defaults, visible: { ...LAYERS.defaults.visible }, species: {} });
  set(SELECTION, { ...SELECTION.defaults });
  set(VOICE, { ...VOICE.defaults });
});

const view = () => get<typeof VIEW.defaults>(VIEW)!;
const time = () => get<typeof TIME.defaults>(TIME)!;

describe("ui command handler", () => {
  test("fly_to with lat/lon sets VIEW and bumps seq", () => {
    expect(applyUiCommand({ name: "fly_to", args: { lat: 25.5, lon: -80.9, altitudeM: 5000 } })).toBe(true);
    expect(view()).toEqual({ lat: 25.5, lon: -80.9, altitudeM: 5000, place: null, seq: 1 });
    applyUiCommand({ name: "fly_to", args: { lat: 25.5, lon: -80.9 } });
    expect(view().seq).toBe(2);
    expect(view().altitudeM).toBe(25_000);
    expect(get<typeof VOICE.defaults>(VOICE)!.lastCommand).toBe("fly_to");
  });

  test("fly_to with a place resolves through the gazetteer", () => {
    expect(applyUiCommand({ name: "fly_to", args: { place: "flamingo" } })).toBe(true);
    const flamingo = resolvePlace("Flamingo")!;
    expect(view()).toMatchObject({ lat: flamingo.lat, lon: flamingo.lon, place: "Flamingo", altitudeM: flamingo.altitudeM });
  });

  test("fly_to to an unknown place changes nothing", () => {
    expect(applyUiCommand({ name: "fly_to", args: { place: "Atlantis" } })).toBe(false);
    expect(view()).toEqual({ ...VIEW.defaults });
    expect(get<typeof VOICE.defaults>(VOICE)!.lastCommand).toBeNull();
  });

  test("invalid args are rejected on the client too", () => {
    expect(applyUiCommand({ name: "fly_to", args: { lat: 200, lon: 0 } })).toBe(false);
    expect(applyUiCommand({ name: "toggle_layer", args: { layer: "radar", visible: true } })).toBe(false);
    expect(applyUiCommand({ name: "rm_rf", args: {} })).toBe(false);
    expect(view()).toEqual({ ...VIEW.defaults });
  });

  test("set_time sets an ISO time or live, and pauses", () => {
    set(TIME, { ...TIME.defaults, playing: true });
    expect(applyUiCommand({ name: "set_time", args: { time: "2026-09-29T22:00:00-04:00" } })).toBe(true);
    expect(time()).toMatchObject({ at: "2026-09-30T02:00:00.000Z", playing: false });
    expect(applyUiCommand({ name: "set_time", args: { time: "now" } })).toBe(true);
    expect(time().at).toBeNull();
    expect(applyUiCommand({ name: "set_time", args: { time: "yesterday-ish" } })).toBe(false);
    expect(time().at).toBeNull();
  });

  test("play_timeline applies defaults and the window", () => {
    expect(
      applyUiCommand({ name: "play_timeline", args: { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" } }),
    ).toBe(true);
    expect(time()).toEqual({
      at: "2026-09-01T00:00:00.000Z",
      playing: true,
      speed: 8,
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-02T00:00:00.000Z",
    });
    expect(applyUiCommand({ name: "play_timeline", args: { playing: false } })).toBe(true);
    expect(time()).toMatchObject({ playing: false, from: "2026-09-01T00:00:00.000Z" });
  });

  test("toggle_layer sets visibility and the species filter", () => {
    expect(applyUiCommand({ name: "toggle_layer", args: { layer: "lst", visible: true } })).toBe(true);
    expect(applyUiCommand({ name: "toggle_layer", args: { layer: "hotspots", visible: true, species: "python" } })).toBe(true);
    const layers = get<typeof LAYERS.defaults>(LAYERS)!;
    expect(layers.visible.lst).toBe(true);
    expect(layers.species).toEqual({ hotspots: "python" });
    applyUiCommand({ name: "toggle_layer", args: { layer: "hotspots", visible: true } });
    expect(get<typeof LAYERS.defaults>(LAYERS)!.species).toEqual({});
  });

  test("select and open_evidence drive SELECTION", () => {
    expect(applyUiCommand({ name: "select", args: { evidenceId: "sighting:123" } })).toBe(true);
    expect(get<typeof SELECTION.defaults>(SELECTION)).toEqual({ evidenceId: "sighting:123", drawerOpen: false });
    expect(applyUiCommand({ name: "open_evidence", args: { evidenceId: "alert:9" } })).toBe(true);
    expect(get<typeof SELECTION.defaults>(SELECTION)).toEqual({ evidenceId: "alert:9", drawerOpen: true });
  });

  test("hud state reflects the keys", () => {
    applyUiCommand({ name: "fly_to", args: { place: "Key West" } });
    applyUiCommand({ name: "select", args: { evidenceId: "hotspot:python:10:20:1759190400000" } });
    const hud = readHudState(Date.parse("2026-09-30T12:00:00Z"));
    expect(hud.camera.place).toBe("Key West");
    expect(hud.time).toMatchObject({ live: true, at: "2026-09-30T12:00:00.000Z" });
    expect(hud.layers).toEqual(["sightings", "hotspots", "stations", "alerts", "missions", "peers"]);
    expect(hud.selection).toBe("hotspot:python:10:20:1759190400000");
    expect(hud.bbox.west).toBeLessThan(hud.camera.lon);
    expect(hud.bbox.east).toBeGreaterThan(hud.camera.lon);
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
