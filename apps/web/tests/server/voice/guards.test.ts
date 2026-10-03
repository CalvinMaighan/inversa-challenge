import { describe, expect, test } from "bun:test";

import { AnnouncementWindow } from "server/voice/announcement-window";
import { claimTurn, looksLikeHangUp, looksLikeStop } from "server/voice/stop-intent";
import { isUiToolName, validateUiToolCall } from "server/voice/ui-command";
import {
  isVoiceControlMessage,
  isVoiceViewStateRequest,
  VIEW_STATE_MAX_CHARS,
} from "server/voice/view-state-control";
import {
  formatProgressContext,
  formatResultContext,
  RESULT_CONTEXT_MAX_CHARS,
  RESULT_TRUNCATION_NOTE,
  uiToolsFor,
} from "server/voice/voice-prompt";
import { getApp } from "shared/apps";
import { isVoiceControlRequest } from "shared/voice/protocol";

const PYTHON = getApp("python");

describe("protocol and control guards", () => {
  test("protocol control requests", () => {
    expect(isVoiceControlRequest({ type: "interrupt" })).toBe(true);
    expect(isVoiceControlRequest({ type: "close" })).toBe(true);
    expect(isVoiceControlRequest({ type: "text", text: "hi" })).toBe(true);
    expect(isVoiceControlRequest({ type: "text", text: 3 })).toBe(false);
    expect(isVoiceControlRequest({ type: "playback", responseId: "r", state: "ended" })).toBe(true);
    expect(isVoiceControlRequest({ type: "playback", responseId: "r", state: "paused" })).toBe(false);
    expect(isVoiceControlRequest({ type: "mode", mode: "dictate" })).toBe(true);
    expect(isVoiceControlRequest({ type: "mode", mode: "shout" })).toBe(false);
    expect(isVoiceControlRequest({ type: "view_state", state: {} })).toBe(false);
    expect(isVoiceControlRequest(null)).toBe(false);
  });

  test("view_state extension", () => {
    expect(isVoiceViewStateRequest({ type: "view_state", state: { camera: { lat: 25 } } })).toBe(true);
    expect(isVoiceViewStateRequest({ type: "view_state", state: {} })).toBe(true);
    expect(isVoiceViewStateRequest({ type: "view_state", state: null })).toBe(false);
    expect(isVoiceViewStateRequest({ type: "view_state", state: [] })).toBe(false);
    expect(isVoiceViewStateRequest({ type: "view_state", state: "camera" })).toBe(false);
    expect(isVoiceViewStateRequest({ type: "view_state", state: { blob: "x".repeat(VIEW_STATE_MAX_CHARS) } })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isVoiceViewStateRequest({ type: "view_state", state: cyclic })).toBe(false);
    expect(isVoiceControlMessage({ type: "view_state", state: { a: 1 } })).toBe(true);
    expect(isVoiceControlMessage({ type: "interrupt" })).toBe(true);
    expect(isVoiceControlMessage({ type: "nope" })).toBe(false);
  });
});

describe("ui tool validation", () => {
  test("names", () => {
    expect(isUiToolName("fly_to")).toBe(true);
    expect(isUiToolName("spawn_thinking")).toBe(false);
  });

  test("fly_to resolves a place and fills coordinates", () => {
    const result = validateUiToolCall("fly_to", { place: "Key Largo" }, PYTHON);
    expect(result).toEqual({
      ok: true,
      command: { name: "fly_to", args: { place: "Key Largo", lat: 25.0865, lon: -80.4473, altitudeM: 15_000 } },
    });
    expect(validateUiToolCall("fly_to", { lat: 25, lon: -81 }, PYTHON)).toMatchObject({ ok: true });
    expect(validateUiToolCall("fly_to", {}, PYTHON)).toMatchObject({ ok: false });
    expect(validateUiToolCall("fly_to", { place: "Atlantis" }, PYTHON)).toMatchObject({ ok: false });
  });

  test("times must parse", () => {
    expect(validateUiToolCall("set_time", { time: "now" }, PYTHON)).toMatchObject({ ok: true });
    expect(validateUiToolCall("set_time", { time: "2026-09-30T10:00:00Z" }, PYTHON)).toMatchObject({ ok: true });
    expect(validateUiToolCall("set_time", { time: "soonish" }, PYTHON)).toMatchObject({ ok: false });
    expect(validateUiToolCall("play_timeline", { from: "2026-09-02T00:00:00Z", to: "2026-09-01T00:00:00Z" }, PYTHON)).toMatchObject({ ok: false });
    expect(validateUiToolCall("play_timeline", {}, PYTHON)).toEqual({
      ok: true,
      command: { name: "play_timeline", args: { speed: 8, playing: true } },
    });
  });

  test("tool schemas exported to Grok match the zod contract", () => {
    const UI_TOOLS = uiToolsFor(PYTHON);
    const toggle = UI_TOOLS.find((t) => t.name === "toggle_layer")!;
    expect(toggle.parameters).toMatchObject({ type: "object", required: ["layer", "visible"] });
    const play = UI_TOOLS.find((t) => t.name === "play_timeline")!;
    expect((play.parameters as { required?: string[] }).required ?? []).not.toContain("speed");
  });

  test("voice tools per app: toggle_layer offers only the app's layers and species (C-A5)", () => {
    const toggle = (id: "carp" | "lionfish" | "python") => uiToolsFor(getApp(id)).find((t) => t.name === "toggle_layer")!;
    const props = (id: "carp" | "lionfish" | "python") => (toggle(id).parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    // Config order; carp's `locations` layer has no client layer yet, so voice cannot toggle it. The GE5 water
    // and weather overlays follow (docs/GODS_EYE.md GC5).
    expect(props("carp").layer!.enum).toEqual(["alerts", "stations", "missions", "peers", "notes", "sst-map", "radar", "lightning", "cyclones"]);
    expect(props("python").layer!.enum).not.toContain("vessels");
    expect(props("carp").species?.enum).toBeUndefined();
    expect(toggle("carp").description).not.toContain("python");
    expect(props("lionfish").species!.enum).toEqual(["lionfish"]);
    expect(props("python").species!.enum).toEqual(["python"]);
    expect(validateUiToolCall("toggle_layer", { layer: "sightings", visible: true }, getApp("carp"))).toMatchObject({ ok: false });
    expect(validateUiToolCall("toggle_layer", { layer: "sightings", visible: true, species: "lionfish" }, getApp("lionfish"))).toMatchObject({ ok: true });
  });
});

describe("announcement window", () => {
  test("blocks while speaking, while the turn is pending, and while audio plays", () => {
    const w = new AnnouncementWindow();
    expect(w.isBlocked()).toBe(false);
    w.beginTurn("t1");
    expect(w.isBlocked()).toBe(true);
    w.endSpeech();
    expect(w.isBlocked()).toBe(true);
    w.queueAudio("r1", { turnId: "t1", origin: "turn" });
    w.startPlayback("r1");
    expect(w.isPlaying()).toBe(true);
    w.finishPlayback("r1");
    expect(w.isBlocked()).toBe(false);
  });

  test("a tool-call response keeps the turn pending; a silent reply clears it", () => {
    const w = new AnnouncementWindow();
    w.beginTurn("t1");
    w.endSpeech();
    w.responseDone({ turnId: "t1", awaitsToolFollowUp: true });
    expect(w.isBlocked()).toBe(true);
    w.responseDone({ turnId: "t1" });
    expect(w.isBlocked()).toBe(false);
  });

  test("interrupt clears everything", () => {
    const w = new AnnouncementWindow();
    w.beginTurn("t1");
    w.endSpeech();
    w.queueAudio("r1", { turnId: "t1", origin: "turn" });
    w.interrupt();
    expect(w.isBlocked()).toBe(false);
  });
});

describe("stop intents and prompt formatting", () => {
  test("stop and hang-up phrases", () => {
    expect(looksLikeStop("Stop.")).toBe(true);
    expect(looksLikeStop("never mind")).toBe(true);
    expect(looksLikeStop("stop showing hotspots")).toBe(false);
    for (const said of ["Okay, stop talking please.", "stop now", "Hey stop", "be quiet", "enough", "hold on"]) expect(looksLikeStop(said)).toBe(true);
    expect(looksLikeStop("stop the carp filter and show python")).toBe(false);
    expect(looksLikeHangUp("Hang up!")).toBe(true);
    expect(looksLikeHangUp("stop")).toBe(false);
    expect(claimTurn("task-1")).toEqual({ action: "attach", taskId: "task-1" });
    expect(claimTurn(null)).toEqual({ action: "start" });
  });

  test("result context is tagged and capped", () => {
    const short = formatResultContext([{ taskId: "a", status: "completed", objective: "q", result: "r", error: null }]);
    expect(short.startsWith("<result_context>")).toBe(true);
    expect(short).toContain("result: r");
    const long = formatResultContext([
      { taskId: "a", status: "completed", objective: "q", result: "x".repeat(RESULT_CONTEXT_MAX_CHARS * 2), error: null },
    ]);
    expect(long).toContain(RESULT_TRUNCATION_NOTE);
    expect(long.length).toBeLessThan(RESULT_CONTEXT_MAX_CHARS + 400);
    expect(formatProgressContext("a", "sightings")).toContain("progress: sightings");
  });
});

describe("result context sources", () => {
  test("the analyst's sources reach the voice for show_card, with a note that they are not read aloud", () => {
    const text = formatResultContext([
      { taskId: "t1", status: "completed", objective: "newest bighead", result: "One report.", error: null, sources: [{ id: "fish:inat:1", label: "Bighead carp · 2026-08-29 · iNaturalist" }] },
      { taskId: "t2", status: "completed", objective: "feeds", result: "All live.", error: null },
    ]);
    expect(text).toContain("sources (for show_card, never read aloud): fish:inat:1 = Bighead carp · 2026-08-29 · iNaturalist");
    expect(text.match(/sources \(for show_card/g)).toHaveLength(1);
  });
});
