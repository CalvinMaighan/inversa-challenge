import { describe, expect, test } from "bun:test";

import { plainReasoning } from "client/agent/chat/thread";

describe("reasoning text", () => {
  test("markdown headings and emphasis in the model's thinking are dropped, not shown as markers", () => {
    expect(plainReasoning("**Looking into CRW locations**\n\nI'll call reef_heat.")).toBe("Looking into CRW locations\n\nI'll call reef_heat.");
    expect(plainReasoning("## Plan\n__two__ steps, *one* at a time; 3*4 stays")).toBe("Plan\ntwo steps, one at a time; 3*4 stays");
    expect(plainReasoning("plain text")).toBe("plain text");
  });
});

import {
  EMPTY_THREAD,
  MAX_TURNS,
  applyAgentEvent,
  asThread,
  isAsking,
  isWorking,
  reduceThread,
  voiceTurnId,
  type AgentThread,
  type ThreadAction,
} from "client/agent/chat/thread";
import type { AgentStreamEvent } from "shared/agent/events";

const T0 = Date.parse("2026-01-15T03:00:00Z");

/** The python turn as T13's route streams it (mock harness, golden plan), deltas cut mid-marker. */
const PYTHON_TURN: AgentStreamEvent[] = [
  { type: "context", windowTokens: 160000, segments: [{ label: "system", tokens: 686 }] },
  { type: "status", state: "thinking" },
  { type: "reasoning_delta", text: "Need the place, " },
  { type: "reasoning_delta", text: "then sightings." },
  { type: "content_delta", text: "Let me look that up." },
  { type: "status", state: "reading" },
  { type: "tool_start", toolCallId: "c1", capabilityName: "geocode", args: { place: "Homestead" } },
  { type: "tool_end", toolCallId: "c1", capabilityName: "geocode", ok: true, data: { count: 1, evidence: [], feeds: [] } },
  { type: "tool_start", toolCallId: "c2", capabilityName: "sightings", args: { species: ["python"] } },
  {
    type: "tool_end",
    toolCallId: "c2",
    capabilityName: "sightings",
    ok: true,
    data: {
      count: 3,
      evidence: [
        { id: "sighting:2001", kind: "sighting", label: "python · research" },
        { id: "sighting:2002", kind: "sighting", label: "python · needs_id" },
        { id: "sighting:2003", kind: "sighting", label: "python · casual" },
      ],
      feeds: [],
    },
  },
  { type: "tool_start", toolCallId: "c3", capabilityName: "set_view" },
  { type: "view", bbox: { west: -80.56, south: 25.38, east: -80.33, north: 25.56 }, time: "2026-01-15T03:00:00.000Z" },
  { type: "tool_end", toolCallId: "c3", capabilityName: "set_view", ok: true, data: { count: 1, evidence: [], feeds: [] } },
  { type: "status", state: "generating" },
  { type: "content_delta", text: "3 python reports: research " },
  { type: "citation", id: "sighting:2001", kind: "sighting", label: "python · research" },
  { type: "content_delta", text: "[e:sighting:2001]; needs_id " },
  { type: "citation", id: "sighting:2002", kind: "sighting", label: "python · needs_id" },
  { type: "citation", id: "sighting:2001", kind: "sighting", label: "python · research" },
  { type: "content_delta", text: "[e:sighting:2002]." },
  { type: "debug", text: "unverified citation removed: sighting:9999" },
];
const FINAL = "3 python reports: research [e:sighting:2001]; needs_id [e:sighting:2002].";

function run(state: AgentThread, actions: ThreadAction[]): AgentThread {
  return actions.reduce(reduceThread, state);
}

function ask(state: AgentThread = EMPTY_THREAD): AgentThread {
  return run(state, [
    { type: "session", sessionId: "s1" },
    { type: "user", id: "u1", text: "Show me recent python sightings around Homestead.", nowMs: T0 },
    { type: "assistant", id: "a1", nowMs: T0 },
  ]);
}

describe("thread reducer", () => {
  test("folds a scripted python stream into one assistant turn", () => {
    let state = ask();
    // Events land in rAF batches; split the script across three of them.
    state = reduceThread(state, { type: "events", id: "a1", events: PYTHON_TURN.slice(0, 4), nowMs: T0 + 400 });
    const thinking = state.messages[1]!;
    expect(thinking.phase).toBe("thinking");
    expect(thinking.reasoning).toBe("Need the place, then sightings.");
    expect(thinking.reasoningStartedAtMs).toBe(T0 + 400);
    expect(thinking.reasoningEndedAtMs).toBeUndefined();

    state = reduceThread(state, { type: "events", id: "a1", events: PYTHON_TURN.slice(4, 9), nowMs: T0 + 1200 });
    const reading = state.messages[1]!;
    expect(reading.reasoningEndedAtMs).toBe(T0 + 1200);
    // Narration before a tool call is dropped (deedee).
    expect(reading.text).toBe("");
    expect(reading.tools?.map((t) => [t.capabilityName, t.state])).toEqual([
      ["geocode", "ok"],
      ["sightings", "running"],
    ]);
    expect(isAsking(state)).toBe(true);

    state = reduceThread(state, { type: "events", id: "a1", events: PYTHON_TURN.slice(9), nowMs: T0 + 2600 });
    const streaming = state.messages[1]!;
    expect(streaming.status).toBe("streaming");
    expect(streaming.phase).toBe("generating");
    expect(streaming.text).toBe(FINAL);
    expect(streaming.tools?.find((t) => t.capabilityName === "sightings")).toMatchObject({ state: "ok", count: 3, evidence: 3 });
    // Citations deduplicate and keep first-cited order.
    expect(streaming.citations.map((c) => c.id)).toEqual(["sighting:2001", "sighting:2002"]);

    state = reduceThread(state, { type: "events", id: "a1", events: [{ type: "done", content: FINAL }], nowMs: T0 + 3000 });
    const done = state.messages[1]!;
    expect(done).toMatchObject({ status: "done", text: FINAL, startedAtMs: T0, endedAtMs: T0 + 3000 });
    expect(done.phase).toBeUndefined();
    expect(done.errors).toBeUndefined();
    expect(state.messages[0]).toMatchObject({ role: "user", status: "done", at: "2026-01-15T03:00:00.000Z" });
    expect(isAsking(state)).toBe(false);
    expect(isWorking(state)).toBe(false);
    expect(state.sessionId).toBe("s1");
  });

  test("done content is authoritative; empty done keeps the streamed text", () => {
    const streamed = run(ask(), [{ type: "events", id: "a1", events: [{ type: "content_delta", text: "partial" }], nowMs: T0 + 1 }]);
    expect(reduceThread(streamed, { type: "events", id: "a1", events: [{ type: "done", content: "whole answer" }], nowMs: T0 + 2 }).messages[1]!.text).toBe(
      "whole answer",
    );
    expect(reduceThread(streamed, { type: "events", id: "a1", events: [{ type: "done", content: "" }], nowMs: T0 + 2 }).messages[1]!.text).toBe("partial");
  });

  test("error then done ends the turn as an error with its message", () => {
    const state = run(ask(), [
      {
        type: "events",
        id: "a1",
        events: [
          { type: "tool_start", toolCallId: "c1", capabilityName: "alerts" },
          { type: "tool_end", toolCallId: "c1", capabilityName: "alerts", ok: false, error: "GraphQL 502" },
          { type: "error", message: "Daily agent token budget is used up." },
          { type: "done", content: "" },
        ],
        nowMs: T0 + 5,
      },
    ]);
    const turn = state.messages[1]!;
    expect(turn.status).toBe("error");
    expect(turn.errors).toEqual(["Daily agent token budget is used up."]);
    expect(turn.tools?.[0]).toMatchObject({ state: "error", error: "GraphQL 502" });
  });

  test("a tool still running at done is marked failed", () => {
    const turn = applyAgentEvent(
      applyAgentEvent({ id: "a", role: "assistant", text: "", citations: [], status: "streaming", at: "" }, { type: "tool_start", toolCallId: "x", capabilityName: "hotspots" }, 1),
      { type: "done", content: "ok" },
      2,
    );
    expect(turn.tools?.[0]).toMatchObject({ state: "error", error: "no result" });
  });

  test("stop and fail settle a streaming turn and leave finished ones alone", () => {
    const withTool = run(ask(), [{ type: "events", id: "a1", events: [{ type: "tool_start", toolCallId: "c1", capabilityName: "hotspots" }], nowMs: T0 + 1 }]);
    const stopped = reduceThread(withTool, { type: "stop", id: "a1", nowMs: T0 + 9 }).messages[1]!;
    expect(stopped).toMatchObject({ status: "done", stopped: true, endedAtMs: T0 + 9 });
    expect(stopped.tools?.[0]).toMatchObject({ state: "error", error: "stopped" });

    const failed = reduceThread(withTool, { type: "fail", id: "a1", message: "Invalid agent request", nowMs: T0 + 9 }).messages[1]!;
    expect(failed).toMatchObject({ status: "error", errors: ["Invalid agent request"] });

    const finished = reduceThread(withTool, { type: "events", id: "a1", events: [{ type: "done", content: "x" }], nowMs: T0 + 3 });
    expect(reduceThread(finished, { type: "stop", id: "a1", nowMs: T0 + 9 })).toEqual(finished);
    // Late events after done change nothing.
    expect(reduceThread(finished, { type: "events", id: "a1", events: [{ type: "content_delta", text: "late" }], nowMs: T0 + 9 })).toEqual(finished);
  });

  test("voice task events open a voice turn in the same thread", () => {
    const id = voiceTurnId("task-7");
    let state = ask();
    state = reduceThread(state, {
      type: "events",
      id,
      voiceTaskId: "task-7",
      events: [
        { type: "tool_start", toolCallId: "v1", capabilityName: "hotspots" },
        { type: "content_delta", text: "Top cell" },
      ],
      nowMs: T0 + 50,
    });
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]).toMatchObject({ id, role: "assistant", source: "voice", taskId: "task-7", status: "streaming", text: "Top cell" });
    expect(isWorking(state)).toBe(true);
    // A voice turn alone does not block typing.
    const typedDone = reduceThread(state, { type: "events", id: "a1", events: [{ type: "done", content: "x" }], nowMs: T0 + 60 });
    expect(isAsking(typedDone)).toBe(false);
    expect(isWorking(typedDone)).toBe(true);
    state = reduceThread(state, { type: "events", id, voiceTaskId: "task-7", events: [{ type: "done", content: "Top cell 243:145." }], nowMs: T0 + 90 });
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]).toMatchObject({ status: "done", text: "Top cell 243:145.", source: "voice" });
  });

  test(`the transcript keeps the last ${MAX_TURNS} turns`, () => {
    let state = EMPTY_THREAD;
    for (let i = 0; i < 30; i += 1) {
      state = run(state, [
        { type: "user", id: `u${i}`, text: `q${i}`, nowMs: T0 + i },
        { type: "assistant", id: `a${i}`, nowMs: T0 + i },
      ]);
    }
    expect(state.messages).toHaveLength(MAX_TURNS);
    expect(state.messages[0]!.id).toBe("u5");
    expect(state.messages.at(-1)!.id).toBe("a29");
    state = reduceThread(state, { type: "events", id: voiceTurnId("t"), voiceTaskId: "t", events: [{ type: "status", state: "thinking" }], nowMs: T0 });
    expect(state.messages).toHaveLength(MAX_TURNS);
    expect(state.messages[0]!.id).toBe("a5");
  });

  test("clear drops the turns and the session", () => {
    const cleared = reduceThread(ask(), { type: "clear" });
    expect(cleared).toEqual({ sessionId: null, messages: [] });
  });

  test("asThread tolerates an unset key", () => {
    expect(asThread(undefined)).toBe(EMPTY_THREAD);
    const thread = ask();
    expect(asThread(thread)).toBe(thread);
  });
});
