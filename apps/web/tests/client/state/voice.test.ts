import { describe, expect, test } from "bun:test";

import { VOICE } from "client/state/voice";

describe("VOICE", () => {
  test("starts idle with an empty transcript", () => {
    expect(VOICE.defaults).toEqual({ state: "idle", transcript: "" });
    expect(VOICE.state).toBe("VOICE.state");
    expect(VOICE.transcript).toBe("VOICE.transcript");
  });
});
