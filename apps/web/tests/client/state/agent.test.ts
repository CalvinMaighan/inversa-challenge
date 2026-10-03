import { describe, expect, test } from "bun:test";

import { AGENT_CARD, AGENT_CHAT, AGENT_TABS, SHEET_SNAPS } from "client/state/agent";

describe("AGENT_CARD / AGENT_CHAT", () => {
  test("the chat column starts on the Agent tab, sheet collapsed, nothing unread", () => {
    expect(AGENT_CARD.defaults).toEqual({ tab: "agent", sheet: "collapsed", unread: { agent: false, questions: false } });
    expect(AGENT_CARD.tab).toBe("AGENT_CARD.tab");
    expect(AGENT_CARD.sheet).toBe("AGENT_CARD.sheet");
  });

  test("tabs and sheet snaps are ordered as the column shows them", () => {
    expect(AGENT_TABS).toEqual(["agent", "questions"]);
    expect(SHEET_SNAPS).toEqual(["collapsed", "half", "full"]);
  });

  test("the chat starts with no session and no messages", () => {
    expect(AGENT_CHAT.defaults).toEqual({ sessionId: null, messages: [] });
    expect(AGENT_CHAT.messages).toBe("AGENT_CHAT.messages");
  });
});
