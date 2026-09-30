import { describe, expect, test } from "bun:test";

import { orbPhase, voiceIsLive } from "client/agent/orb-phase";

describe("orb phase", () => {
  test("idle presence dot with nothing going on", () => {
    expect(orbPhase(undefined, false)).toBe("idle");
    expect(orbPhase({ status: "off", state: "idle" }, false)).toBe("idle");
    expect(orbPhase({ status: "error", state: "idle", error: "denied" }, false)).toBe("idle");
  });

  test("live voice drives the pulse ring and spinner", () => {
    expect(orbPhase({ status: "live", state: "listening" }, false)).toBe("listening");
    expect(orbPhase({ status: "live", state: "speaking" }, true)).toBe("speaking");
    expect(orbPhase({ status: "live", state: "thinking" }, false)).toBe("thinking");
    expect(orbPhase({ status: "connecting", state: "idle" }, true)).toBe("connecting");
  });

  test("a streaming agent turn spins", () => {
    expect(orbPhase({ status: "off", state: "idle" }, true)).toBe("thinking");
    expect(orbPhase({ status: "live", state: "idle" }, true)).toBe("thinking");
  });

  test("catalog VOICE shape (state only) still pulses", () => {
    expect(orbPhase({ state: "listening" }, false)).toBe("listening");
    expect(orbPhase({ state: "idle" }, false)).toBe("idle");
  });

  test("stale voice state after the session ended does not pulse", () => {
    expect(orbPhase({ status: "off", state: "speaking" }, false)).toBe("idle");
  });

  test("voiceIsLive covers connecting so the mic can cancel", () => {
    expect(voiceIsLive({ status: "live" })).toBe(true);
    expect(voiceIsLive({ status: "connecting" })).toBe(true);
    expect(voiceIsLive({ status: "error" })).toBe(false);
    expect(voiceIsLive(undefined)).toBe(false);
  });
});
