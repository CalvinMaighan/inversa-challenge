import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state, STATE_KEY_IDS } from "client/state";
import { dmThread, MESSAGES, peerOfThread, setDmDraft, setDmPeer, setDmTyping, type MessagesState } from "client/state/messages";

init(state);

describe("MESSAGES", () => {
  test("starts with no open thread, no drafts and nobody typing; registered in the catalog", () => {
    expect(MESSAGES.defaults).toEqual({ peer: null, drafts: {}, typing: {} });
    expect(STATE_KEY_IDS).toContain("MESSAGES");
  });

  test("dmThread is the same from either side; peerOfThread finds the other node", () => {
    expect(dmThread("b", "a")).toBe("dm:a~b");
    expect(dmThread("a", "b")).toBe(dmThread("b", "a"));
    expect(peerOfThread("dm:a~b", "a")).toBe("b");
    expect(peerOfThread("dm:a~b", "b")).toBe("a");
    expect(peerOfThread("dm:a~b", "c")).toBeNull();
    expect(peerOfThread("team", "a")).toBeNull();
  });

  test("setDmPeer opens and closes a thread without creating a new value when unchanged", () => {
    set(MESSAGES, MESSAGES.defaults);
    const before = get<MessagesState>(MESSAGES);
    setDmPeer(null);
    expect(get<MessagesState>(MESSAGES)).toBe(before);
    setDmPeer("b");
    expect(get<MessagesState>(MESSAGES)!.peer).toBe("b");
    setDmPeer(null);
    expect(get<MessagesState>(MESSAGES)!.peer).toBeNull();
  });

  test("drafts and typing are keyed by thread; clearing an absent entry is a no-op", () => {
    set(MESSAGES, MESSAGES.defaults);
    const before = get<MessagesState>(MESSAGES);
    setDmDraft("dm:a~b", null);
    setDmTyping("dm:a~b", null);
    expect(get<MessagesState>(MESSAGES)).toBe(before);
    setDmDraft("dm:a~b", { msgId: "m1", from: "b", text: "hel", caret: 3, at: 10 });
    setDmTyping("dm:a~b", 10);
    expect(get<MessagesState>(MESSAGES)!.drafts["dm:a~b"]!.text).toBe("hel");
    expect(get<MessagesState>(MESSAGES)!.typing).toEqual({ "dm:a~b": 10 });
    setDmDraft("dm:a~b", null);
    setDmTyping("dm:a~b", null);
    expect(get<MessagesState>(MESSAGES)).toEqual({ peer: null, drafts: {}, typing: {} });
  });
});
