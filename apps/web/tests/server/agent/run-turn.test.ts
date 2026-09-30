import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { NOW, ofType, resetState, setupAgentEnv, streamedText, turn, type AgentEnv } from "./helpers";

import { recordTokens } from "@/server/agent/budget";
import { resetHarness } from "@/server/agent/cordis/boot";
import { mockLlmCalls, setMockScript, type MockStepInput } from "@/server/agent/cordis/plugins/mock-llm";
import { runTurn } from "@/server/agent/run-turn";
import { isAgentStreamEvent, type AgentStreamEvent } from "@/shared/agent/events";

const SHARK_VALLEY = { west: -80.85, south: 25.67, east: -80.68, north: 25.84 };

type Row = { evidenceId: string; duplicateOf: string | null };

function sightingRows(input: MockStepInput): Row[] {
  const result = input.toolResults.find((row) => row.name === "sightings");
  return ((result?.json as { rows?: Row[] } | null)?.rows ?? []) as Row[];
}

let env: AgentEnv;

beforeAll(() => {
  env = setupAgentEnv();
});

afterAll(async () => {
  await resetHarness();
  env.cleanup();
});

beforeEach(() => {
  resetState();
  env.stub.requests.length = 0;
});

describe("runTurn tool loop", () => {
  test("calls a tool, feeds the result back, and cites what it returned", async () => {
    const question = "How many pythons near Shark Valley?";
    const seen: MockStepInput[] = [];
    setMockScript(question, (input) => {
      seen.push(input);
      if (input.step === 0) {
        return { toolCalls: [{ name: "sightings", args: { bbox: SHARK_VALLEY, species: ["python"] } }] };
      }
      const originals = sightingRows(input).filter((row) => !row.duplicateOf);
      return { text: `Two distinct pythons ${originals.map((row) => `[e:${row.evidenceId}]`).join(" ")}.` };
    });
    const { events, result } = await turn(question);

    expect(seen).toHaveLength(2);
    expect(seen[0]!.system).toContain("Everglades Ops analyst");
    const start = ofType(events, "tool_start");
    const end = ofType(events, "tool_end");
    expect(start.map((event) => event.capabilityName)).toEqual(["sightings"]);
    expect(start[0]!.args).toEqual({ bbox: SHARK_VALLEY, species: ["python"] });
    expect(end[0]!.ok).toBe(true);
    expect(end[0]!.toolCallId).toBe(start[0]!.toolCallId);
    const data = end[0]!.data as { count: number; evidence: { id: string }[]; feeds: { source: string; state: string }[] };
    expect(data.count).toBe(4);
    expect(data.evidence.map((row) => row.id).sort()).toEqual([
      "sighting:1001",
      "sighting:1002",
      "sighting:1003",
      "sighting:1004",
    ]);
    // C3 envelopes for the sources in the rows, lower-cased.
    expect(data.feeds.map((feed) => `${feed.source}:${feed.state}`).sort()).toEqual([
      "gbif:nominal",
      "inat:nominal",
      "nas:lagging",
    ]);
    expect(result.content).toBe("Two distinct pythons [e:sighting:1001] [e:sighting:1003].");
    expect(result.citations).toEqual(["sighting:1001", "sighting:1003"]);
    expect(ofType(events, "citation").map((event) => [event.id, event.kind])).toEqual([
      ["sighting:1001", "sighting"],
      ["sighting:1003", "sighting"],
    ]);
    expect(streamedText(events)).toBe(result.content);
    // Exactly one GraphQL POST for the one tool call.
    expect(env.stub.requests.map((request) => request.operationName)).toEqual(["AgentSightings"]);
    expect(events.every(isAgentStreamEvent)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", content: result.content });
  });

  test("a failing tool reports tool_end ok=false and the loop continues", async () => {
    const question = "Explain a cell with no score";
    setMockScript(question, (input) =>
      input.step === 0
        ? { toolCalls: [{ name: "explain_cell", args: { species: "python", cell: "1:1" } }] }
        : { text: `No score: ${input.toolResults[0]!.text}` },
    );
    const { events, result } = await turn(question);
    const end = ofType(events, "tool_end")[0]!;
    expect(end.ok).toBe(false);
    expect(end.error).toContain("no hotspot score");
    expect(result.content).toContain("no hotspot score for python in cell 1:1");
    expect(ofType(events, "error")).toHaveLength(0);
  });

  test("invalid tool arguments are rejected by the zod schema before any GraphQL call", async () => {
    const question = "Hotspots for a made up species";
    setMockScript(question, (input) =>
      input.step === 0 ? { toolCalls: [{ name: "hotspots", args: { species: "cane toad" } }] } : { text: "Unknown species." },
    );
    const { events } = await turn(question);
    const end = ofType(events, "tool_end")[0]!;
    expect(end.ok).toBe(false);
    expect(end.error).toContain("Invalid input for hotspots");
    expect(env.stub.requests).toHaveLength(0);
  });

  test("plain reply streams content_delta and done", async () => {
    const { events, result } = await turn("hello");
    expect(result.content).toBe("ok");
    expect(ofType(events, "content_delta").length).toBeGreaterThan(0);
    expect(ofType(events, "context")[0]!.segments.map((segment) => segment.label)).toEqual([
      "system",
      "tools",
      "history",
      "input",
    ]);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("empty model reply on both models ends with an error and done", async () => {
    const { events, result } = await turn("please EMPTY_REPLY now");
    expect(result.content).toBe("");
    expect(ofType(events, "error").some((event) => event.message.includes("empty reply"))).toBe(true);
    expect(ofType(events, "debug").some((event) => event.text.startsWith("escalating to deepseek-v4-pro-0813"))).toBe(true);
    expect(ofType(events, "done")).toHaveLength(1);
  });

  test("flash failing before any text escalates to pro", async () => {
    const question = "escalate me";
    setMockScript(question, (input) =>
      input.model === "deepseek-v4-flash" ? { empty: true } : { text: `answered by ${input.model}` },
    );
    const { events, result } = await turn(question);
    expect(result.model).toBe("deepseek-v4-pro-0813");
    expect(result.content).toBe("answered by deepseek-v4-pro-0813");
    expect(ofType(events, "error")).toHaveLength(0);
  });

  test("the next turn in a session sees the transcript", async () => {
    const sessionId = `history-${Date.now()}`;
    let userTexts: string[] = [];
    setMockScript("and tegus?", (input) => {
      userTexts = input.userTexts;
      return { text: "noted" };
    });
    await turn("first question about pythons", { sessionId });
    await turn("and tegus?", { sessionId, view: { bbox: SHARK_VALLEY, time: NOW.toISOString(), layers: ["sightings"], selection: "sighting:1001" } });
    expect(userTexts).toHaveLength(3);
    expect(userTexts[0]).toBe("Conversation so far:\nuser: first question about pythons\nassistant: ok");
    expect(userTexts[1]).toContain(`Reference time: ${NOW.toISOString()}`);
    expect(userTexts[1]).toContain("Selected evidence: sighting:1001");
    expect(userTexts[2]).toBe("and tegus?");
  });
});

describe("citations", () => {
  test("strips unverified citation", async () => {
    const question = "Cite something real and something invented";
    setMockScript(question, (input) =>
      input.step === 0
        ? { toolCalls: [{ name: "alerts", args: { bbox: { west: -81.1, south: 24.85, east: -80.35, north: 25.25 } } }] }
        : { text: "Small Craft Advisory [e:alert:5002], and a python den [e:sighting:424242] nearby." },
    );
    const { events, result } = await turn(question);
    expect(result.content).toBe("Small Craft Advisory [e:alert:5002], and a python den nearby.");
    expect(streamedText(events)).not.toContain("424242");
    expect(streamedText(events)).toContain("[e:alert:5002]");
    expect(ofType(events, "debug").map((event) => event.text)).toContain("unverified citation removed: sighting:424242");
    expect(ofType(events, "citation").map((event) => event.id)).toEqual(["alert:5002"]);
    expect(result.citations).toEqual(["alert:5002"]);
  });

  test("ids from an earlier turn are not valid in this one", async () => {
    const sessionId = `stale-cite-${Date.now()}`;
    setMockScript("first", (input) =>
      input.step === 0 ? { toolCalls: [{ name: "alerts", args: {} }] } : { text: "Advisory [e:alert:5001]." },
    );
    setMockScript("second", () => ({ text: "Still the advisory [e:alert:5001]." }));
    const first = await turn("first", { sessionId });
    expect(first.result.citations).toEqual(["alert:5001"]);
    const second = await turn("second", { sessionId });
    expect(second.result.content).toBe("Still the advisory.");
    expect(ofType(second.events, "debug").map((event) => event.text)).toContain("unverified citation removed: alert:5001");
  });
});

describe("limits", () => {
  test("turn limit stops a model that never stops calling tools", async () => {
    const question = "loop forever";
    setMockScript(question, () => ({ toolCalls: [{ name: "feed_state" }] }));
    const { events, result } = await turn(question, { limits: { maxTurns: 3 } });
    expect(result.limitHit).toEqual({ kind: "turns", limit: 3 });
    expect(ofType(events, "tool_start")).toHaveLength(3);
    expect(ofType(events, "debug").map((event) => event.text)).toContain("limit reached: 3 turns");
    expect(ofType(events, "error").map((event) => event.message)).toContain(
      "Stopped at the turns limit before an answer.",
    );
    expect(events.at(-1)?.type).toBe("done");
  });

  test("tool call limit denies calls past the cap", async () => {
    const question = "call many tools";
    setMockScript(question, (input) =>
      input.step === 0
        ? { toolCalls: [{ name: "feed_state" }, { name: "feed_state" }, { name: "feed_state" }] }
        : { text: `denied: ${input.toolResults.filter((row) => row.text.includes("Tool call limit")).length}` },
    );
    const { events, result } = await turn(question, { limits: { maxToolCalls: 2 } });
    expect(result.limitHit).toEqual({ kind: "tool_calls", limit: 2 });
    expect(result.content).toBe("denied: 1");
    expect(env.stub.requests).toHaveLength(2);
    expect(ofType(events, "debug").map((event) => event.text)).toContain("limit reached: 2 tool calls");
    const denied = ofType(events, "tool_end").filter((event) => !event.ok);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.error).toContain("Tool call limit reached (2)");
  });

  test("runtime limit cancels a slow turn", async () => {
    const question = "think very slowly";
    setMockScript(question, () => ({ text: "too late", delayMs: 5_000 }));
    const started = Date.now();
    const { events, result } = await turn(question, { limits: { maxRuntimeMs: 200 } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.limitHit).toEqual({ kind: "runtime", limit: 200 });
    expect(ofType(events, "debug").map((event) => event.text)).toContain("limit reached: 0.2 s runtime");
    expect(result.content).toBe("");
    expect(ofType(events, "debug").map((event) => event.text)).not.toContain(
      "escalating to deepseek-v4-pro-0813: empty reply",
    );
    expect(events.at(-1)?.type).toBe("done");
  });

  test("daily token budget: an exhausted budget answers without calling the model", async () => {
    process.env.AGENT_DAILY_TOKENS = "1000";
    recordTokens(1_000);
    const before = mockLlmCalls();
    const { events, result } = await turn("hello again");
    expect(mockLlmCalls()).toBe(before);
    expect(result.content).toBe("");
    expect(ofType(events, "error")[0]!.message).toContain("Daily agent token budget (1,000) is used up");
    expect(events.at(-1)).toEqual({ type: "done", content: "" });
  });

  test("daily token budget: usage is recorded to the data dir", async () => {
    await turn("hello");
    const file = JSON.parse(await Bun.file(`${env.dataDir}/agent-budget.json`).text()) as { day: string; used: number };
    expect(file.day).toBe(new Date().toISOString().slice(0, 10));
    expect(file.used).toBeGreaterThan(0);
  });
});

describe("view", () => {
  test("set_view emits a view event without a GraphQL call", async () => {
    const question = "Take me to Flamingo";
    setMockScript(question, (input) => {
      if (input.step === 0) return { toolCalls: [{ name: "geocode", args: { place: "Flamingo" } }] };
      if (input.step === 1) {
        const place = input.toolResults[0]!.json as { bbox: unknown };
        return { toolCalls: [{ name: "set_view", args: { bbox: place.bbox } }] };
      }
      return { text: "Flying to Flamingo." };
    });
    const { events } = await turn(question);
    const views = ofType(events, "view");
    expect(views).toHaveLength(1);
    expect(views[0]!.time).toBe(NOW.toISOString());
    expect(views[0]!.bbox.west).toBeCloseTo(-81.0045, 4);
    expect(views[0]!.bbox.north).toBeCloseTo(25.2217, 4);
    // The view event lands between set_view's tool_start and tool_end.
    const order = events.map((event) => event.type);
    const viewAt = order.indexOf("view");
    expect(order.lastIndexOf("tool_start")).toBeLessThan(viewAt);
    expect(order.lastIndexOf("tool_end")).toBeGreaterThan(viewAt);
    expect(env.stub.requests).toHaveLength(0);
  });
});

describe("answer cache", () => {
  const question = "Any alerts right now?";

  function script() {
    setMockScript(question, (input) =>
      input.step === 0 ? { toolCalls: [{ name: "alerts", args: {} }] } : { text: "Cold Weather Advisory [e:alert:5001]." },
    );
  }

  test("a repeat question on the same data version is a cache hit", async () => {
    script();
    const first = await turn(question, { cache: true });
    expect(first.result.cached).toBe(false);
    const callsAfterFirst = mockLlmCalls();

    const second = await turn(`  any ALERTS right now  `, { cache: true });
    expect(second.result.cached).toBe(true);
    expect(mockLlmCalls()).toBe(callsAfterFirst);
    expect(second.result.content).toBe(first.result.content);
    expect(ofType(second.events, "debug")[0]!.text).toBe("answer cache hit");
    expect(ofType(second.events, "citation").map((event) => event.id)).toEqual(["alert:5001"]);
    expect(streamedText(second.events)).toBe(first.result.content);
    expect(second.events.at(-1)).toEqual({ type: "done", content: first.result.content });
    // The hit cost one feeds query (data version) and no tool calls.
    expect(env.stub.requests.at(-1)?.operationName).toBe("AgentFeeds");
  });

  test("a follow-up in an existing session bypasses the cache", async () => {
    script();
    const sessionId = `cache-followup-${Date.now()}`;
    await turn(question, { cache: true, sessionId });
    const again = await turn(question, { cache: true, sessionId });
    expect(again.result.cached).toBe(false);
  });

  test("a new data version misses the cache", async () => {
    script();
    await turn(question, { cache: true });
    const original = env.stub.requests.length;
    expect(original).toBeGreaterThan(0);
    const { default: fixture } = await import("@/eval/fixtures/graphql.json");
    const inat = fixture.feeds.find((feed) => feed.source === "inat")!;
    const previous = inat.lastFetchAt;
    inat.lastFetchAt = "2026-01-15T03:05:00Z";
    try {
      const again = await turn(question, { cache: true });
      expect(again.result.cached).toBe(false);
    } finally {
      inat.lastFetchAt = previous;
    }
  });
});

describe("stream contract", () => {
  test("every event satisfies the C7 union and done is last", async () => {
    const events: AgentStreamEvent[] = [];
    await runTurn({ sessionId: "contract-1", question: "hello", harnessMode: "mock", now: NOW, cache: false }, (event) =>
      events.push(event),
    );
    expect(events.length).toBeGreaterThan(2);
    expect(events.every(isAgentStreamEvent)).toBe(true);
    expect(ofType(events, "done")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
});
