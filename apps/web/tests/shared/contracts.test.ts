import { describe, expect, test } from "bun:test";

import { isAgentStreamEvent } from "shared/agent/events";
import { type FeedState, worstHealth } from "shared/feed-state";
import { ENV_FLAGGED, ENV_MISSING, EVF_HEADER_BYTES, evfFrameBytes, evfFrameLayout, isEnvValue, readEvfHeader } from "shared/frames";
import { isVoiceControlRequest, VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE } from "shared/voice/protocol";
import { parseUiCommand, uiToolSchemasFor, UI_TOOL_NAMES } from "shared/voice/ui-tools";
import { appLayerIds, getApp } from "shared/apps";
import { z } from "zod";

describe("shared contracts", () => {
  test("agent events guard", () => {
    expect(isAgentStreamEvent({ type: "citation", id: "sighting:1", kind: "sighting", label: "x" })).toBe(true);
    expect(isAgentStreamEvent({ type: "nope" })).toBe(false);
  });

  test("feed health ranks worst first", () => {
    const base: Omit<FeedState, "state"> = {
      source: "a", mode: "poll", newestObservedAt: null, lastFetchAt: null, lastFetchRunId: "7", lagSeconds: null, note: null,
    };
    expect(worstHealth([{ ...base, state: "nominal" }, { ...base, state: "stale" }])).toBe("stale");
    expect(worstHealth([])).toBe("nominal");
  });

  test("EVF2 header round-trips and frame layout aligns", () => {
    const buf = new ArrayBuffer(EVF_HEADER_BYTES);
    const v = new DataView(buf);
    "EVF2".split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
    v.setUint32(4, 720, true);
    v.setUint32(8, 170, true);
    v.setUint32(12, 160, true);
    v.setFloat64(16, -83.2, true);
    v.setFloat64(24, 24.3, true);
    v.setFloat64(32, 0.02, true);
    v.setBigInt64(40, 1_700_000_000_000n, true);
    v.setUint32(48, 60, true);
    v.setUint32(52, 4, true);
    v.setUint16(56, 68, true);
    v.setUint16(58, 64, true);
    v.setFloat32(60, 0.05, true);
    v.setFloat32(64, 0.0125, true);
    const h = readEvfHeader(v);
    expect(h).toMatchObject({
      frameCount: 720, hsCols: 170, hsRows: 160, west: -83.2, south: 24.3, hsCellDeg: 0.02,
      frame0UnixMs: 1_700_000_000_000, stepMinutes: 60, speciesCount: 4, envCols: 68, envRows: 64, envCellDeg: 0.05,
    });
    expect(h.hotspotScale).toBeCloseTo(0.0125, 6);
    const layout = evfFrameLayout(h);
    expect(layout.lstOffset % 2).toBe(0);
    expect(layout.sightingsOffset % 4).toBe(0);
    expect(evfFrameBytes(h, 3)).toBe(layout.sightingsOffset + 4 + 3 * 16);
    expect(ENV_MISSING).toBe(-32768);
    expect(ENV_FLAGGED).toBe(-32767);
    expect([ENV_MISSING, ENV_FLAGGED, -32766, 0].map(isEnvValue)).toEqual([false, false, true, true]);
  });

  test("voice protocol rates and control guard", () => {
    expect(VOICE_INPUT_SAMPLE_RATE).toBe(16_000);
    expect(VOICE_OUTPUT_SAMPLE_RATE).toBe(24_000);
    expect(isVoiceControlRequest({ type: "interrupt" })).toBe(true);
    expect(isVoiceControlRequest({ type: "text" })).toBe(false);
  });

  test("ui tools validate", () => {
    expect(UI_TOOL_NAMES).toEqual(["fly_to", "set_time", "play_timeline", "toggle_layer", "select", "open_evidence", "set_look"]);
    const python = getApp("python");
    expect(parseUiCommand("fly_to", { place: "Flamingo" }, python)?.name).toBe("fly_to");
    expect(parseUiCommand("fly_to", {}, python)).toBeNull();
    expect(parseUiCommand("toggle_layer", { layer: "alerts", visible: false }, python)?.name).toBe("toggle_layer");
    expect(parseUiCommand("rm_rf", {}, python)).toBeNull();
  });

  test("ui tools: toggle_layer's layer and species enums are the app's (C-A5)", () => {
    const [carp, lionfish, python] = [getApp("carp"), getApp("lionfish"), getApp("python")];
    // Carp has no sightings layer and no species.
    expect(parseUiCommand("toggle_layer", { layer: "sightings", visible: true }, carp)).toBeNull();
    expect(parseUiCommand("toggle_layer", { layer: "stations", visible: true }, carp)?.name).toBe("toggle_layer");
    expect(parseUiCommand("toggle_layer", { layer: "alerts", visible: true, species: "python" }, carp)).toBeNull();
    // Lionfish and python have one species each, their own.
    expect(parseUiCommand("toggle_layer", { layer: "sightings", visible: false, species: "lionfish" }, lionfish)?.name).toBe("toggle_layer");
    expect(parseUiCommand("toggle_layer", { layer: "sightings", visible: false, species: "python" }, lionfish)).toBeNull();
    expect(parseUiCommand("toggle_layer", { layer: "lst", visible: true }, lionfish)).toBeNull();
    expect(parseUiCommand("toggle_layer", { layer: "sightings", visible: false, species: "python" }, python)?.name).toBe("toggle_layer");
    expect(parseUiCommand("toggle_layer", { layer: "sightings", visible: false, species: "lionfish" }, python)).toBeNull();
    const schema = z.toJSONSchema(uiToolSchemasFor(lionfish).toggle_layer, { io: "input" }) as unknown as { properties: { layer: { enum: string[] }; species: { enum: string[] } } };
    expect(schema.properties.layer.enum).toEqual(appLayerIds(lionfish));
    expect(schema.properties.species.enum).toEqual(["lionfish"]);
  });
});
