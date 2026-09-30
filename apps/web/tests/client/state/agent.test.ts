import { describe, expect, test } from "bun:test";

import { AGENT_CARD, AGENT_CHAT } from "client/state/agent";

describe("AGENT_CARD / AGENT_CHAT", () => {
  test("the orb starts collapsed with no measured anchor", () => {
    expect(AGENT_CARD.defaults).toEqual({ open: false, anchor: null });
    expect(AGENT_CARD.open).toBe("AGENT_CARD.open");
    expect(AGENT_CARD.anchor).toBe("AGENT_CARD.anchor");
  });

  test("the chat starts with no session and no messages", () => {
    expect(AGENT_CHAT.defaults).toEqual({ sessionId: null, messages: [] });
    expect(AGENT_CHAT.messages).toBe("AGENT_CHAT.messages");
  });
});
