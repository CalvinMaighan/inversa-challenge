import { describe, expect, test } from "bun:test";

import { VOICE } from "client/state/voice";

describe("VOICE", () => {
  test("starts off and idle with empty transcripts and no tasks", () => {
    expect(VOICE.defaults).toEqual({
      status: "off",
      sessionId: null,
      state: "idle",
      transcript: "",
      userText: "",
      assistantText: "",
      error: null,
      activeTool: null,
      inputMode: "talk",
      tasks: [],
      lastCommand: null,
    });
    expect(VOICE.state).toBe("VOICE.state");
    expect(VOICE.transcript).toBe("VOICE.transcript");
  });
});
