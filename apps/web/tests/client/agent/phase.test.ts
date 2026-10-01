import { describe, expect, test } from "bun:test";

import { agentPhase, PHASE_LABELS, voiceIsLive } from "client/agent/phase";

describe("agent phase", () => {
  test("ready with nothing going on", () => {
    expect(agentPhase(undefined, false)).toBe("idle");
    expect(agentPhase({ status: "off", state: "idle" }, false)).toBe("idle");
    expect(agentPhase({ status: "error", state: "idle", error: "denied" }, false)).toBe("idle");
  });

  test("live voice drives the mic pulse and the working line", () => {
    expect(agentPhase({ status: "live", state: "listening" }, false)).toBe("listening");
    expect(agentPhase({ status: "live", state: "speaking" }, true)).toBe("speaking");
    expect(agentPhase({ status: "live", state: "thinking" }, false)).toBe("thinking");
    expect(agentPhase({ status: "connecting", state: "idle" }, true)).toBe("connecting");
  });

  test("a streaming agent turn is working", () => {
    expect(agentPhase({ status: "off", state: "idle" }, true)).toBe("thinking");
    expect(agentPhase({ status: "live", state: "idle" }, true)).toBe("thinking");
  });

  test("stale voice state after the session ended does not pulse", () => {
    expect(agentPhase({ status: "off", state: "speaking" }, false)).toBe("idle");
  });

  test("voiceIsLive covers connecting so the mic can cancel", () => {
    expect(voiceIsLive({ status: "live" })).toBe(true);
    expect(voiceIsLive({ status: "connecting" })).toBe(true);
    expect(voiceIsLive({ status: "error" })).toBe(false);
    expect(voiceIsLive(undefined)).toBe(false);
  });

  test("every phase has a status label", () => {
    expect(Object.keys(PHASE_LABELS).sort()).toEqual(["connecting", "idle", "listening", "speaking", "thinking"]);
  });
});
