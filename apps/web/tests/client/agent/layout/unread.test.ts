import { describe, expect, test } from "bun:test";

import type { AgentThread, AgentTurn } from "client/agent/chat/thread";
import { agentActivity, boardActivity, markActivity, openTab } from "client/agent/layout/unread";
import { AGENT_CARD, type AgentCardState } from "client/state/agent";

const board = (over: Partial<Parameters<typeof boardActivity>[0] & object> = {}) => ({
  missions: [{ id: "m1", status: "planned" }],
  notes: [],
  messages: [],
  totals: { overall: 0 },
  ...over,
});

const turn = (id: string, role: AgentTurn["role"], status: AgentTurn["status"]): AgentTurn => ({ id, role, status, text: "", citations: [], at: "2026-09-30T20:00:00Z" });
const thread = (...messages: AgentTurn[]): AgentThread => ({ sessionId: "s", messages });

const ui = (over: Partial<AgentCardState> = {}): AgentCardState => ({ ...AGENT_CARD.defaults, ...over });

describe("layout: unread dots", () => {
  test("board activity changes on mission ops, notes, team chat and removals, not before the board loads", () => {
    expect(boardActivity(null)).toBeNull();
    const base = boardActivity(board());
    expect(boardActivity(board())).toBe(base);
    expect(boardActivity(board({ missions: [{ id: "m1", status: "active" }] }))).not.toBe(base);
    expect(boardActivity(board({ notes: [{}] }))).not.toBe(base);
    expect(boardActivity(board({ fieldNotes: [{ id: "n1", text: "two pythons" }] }))).not.toBe(base);
    expect(boardActivity(board({ fieldNotes: [{ id: "n1", text: "two pythons" }] }))).not.toBe(boardActivity(board({ fieldNotes: [{ id: "n1", text: "three pythons!" }] })));
    expect(boardActivity(board({ messages: [{}] }))).not.toBe(base);
    expect(boardActivity(board({ totals: { overall: 3 } }))).not.toBe(base);
  });

  test("agent activity changes when an answer finishes, not while it streams", () => {
    const asked = agentActivity(thread(turn("u1", "user", "done"), turn("a1", "assistant", "streaming")));
    expect(agentActivity(thread(turn("u1", "user", "done"), turn("a1", "assistant", "streaming")))).toBe(asked);
    expect(agentActivity(thread(turn("u1", "user", "done"), turn("a1", "assistant", "done")))).not.toBe(asked);
    expect(agentActivity(thread(turn("a1", "assistant", "error")))).toBe("1|a1");
  });

  test("activity on the hidden tab lights its dot; the showing tab never gets one", () => {
    const onAgent = ui({ tab: "agent" });
    expect(markActivity(onAgent, "board", "a", "b")).toEqual({ agent: false, board: true });
    expect(markActivity(onAgent, "agent", "a", "b")).toBe(onAgent.unread);
    const onBoard = ui({ tab: "board" });
    expect(markActivity(onBoard, "agent", "a", "b")).toEqual({ agent: true, board: false });
  });

  test("the first signature is the baseline, and an unchanged one is no news", () => {
    const state = ui();
    expect(markActivity(state, "board", null, "first")).toBe(state.unread);
    expect(markActivity(state, "board", "same", "same")).toBe(state.unread);
    expect(markActivity(state, "board", "x", null)).toBe(state.unread);
  });

  test("opening a tab clears its dot and leaves the other", () => {
    const state = ui({ tab: "agent", unread: { agent: true, board: true } });
    expect(openTab(state, "board")).toEqual({ ...state, tab: "board", unread: { agent: true, board: false } });
    expect(openTab(state, "agent").unread).toEqual({ agent: false, board: true });
  });
});
