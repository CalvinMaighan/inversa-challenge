import { describe, expect, test } from "bun:test";

import { isAgentStreamEvent } from "shared/agent/events";
import { worstHealth } from "shared/feed-state";
import { EVF_HEADER_BYTES, readEvfHeader } from "shared/frames";
import { isVoiceControlRequest, VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE } from "shared/voice/protocol";
import { parseUiCommand, UI_TOOL_NAMES } from "shared/voice/ui-tools";

describe("shared contracts", () => {
  test("agent events guard", () => {
    expect(isAgentStreamEvent({ type: "citation", id: "sighting:1", kind: "sighting", label: "x" })).toBe(true);
    expect(isAgentStreamEvent({ type: "nope" })).toBe(false);
  });

  test("feed health ranks worst first", () => {
    const base = { source: "a", mode: "poll" as const, newestObservedAt: null, lastFetchAt: null, lagSeconds: null, note: null };
    expect(worstHealth([{ ...base, state: "nominal" }, { ...base, state: "stale" }])).toBe("stale");
    expect(worstHealth([])).toBe("nominal");
  });

  test("EVF header round-trips", () => {
    const buf = new ArrayBuffer(EVF_HEADER_BYTES);
    const v = new DataView(buf);
    "EVF1".split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
    v.setUint32(4, 96, true);
    v.setUint32(8, 340, true);
    v.setUint32(12, 320, true);
    v.setFloat64(16, -83.2, true);
    v.setFloat64(24, 24.3, true);
    v.setFloat64(32, 0.01, true);
    v.setBigInt64(40, 1_700_000_000_000n, true);
    v.setUint32(48, 15, true);
    v.setUint32(52, 4, true);
    expect(readEvfHeader(v)).toEqual({
      frameCount: 96, cols: 340, rows: 320, west: -83.2, south: 24.3, cellDeg: 0.01,
      frame0UnixMs: 1_700_000_000_000, stepMinutes: 15, speciesCount: 4,
    });
  });

  test("voice protocol rates and control guard", () => {
    expect(VOICE_INPUT_SAMPLE_RATE).toBe(16_000);
    expect(VOICE_OUTPUT_SAMPLE_RATE).toBe(24_000);
    expect(isVoiceControlRequest({ type: "interrupt" })).toBe(true);
    expect(isVoiceControlRequest({ type: "text" })).toBe(false);
  });

  test("ui tools validate", () => {
    expect(UI_TOOL_NAMES).toEqual(["fly_to", "set_time", "play_timeline", "toggle_layer", "select", "open_evidence"]);
    expect(parseUiCommand("fly_to", { place: "Flamingo" })?.name).toBe("fly_to");
    expect(parseUiCommand("fly_to", {})).toBeNull();
    expect(parseUiCommand("toggle_layer", { layer: "alerts", visible: false })?.name).toBe("toggle_layer");
    expect(parseUiCommand("rm_rf", {})).toBeNull();
  });
});
