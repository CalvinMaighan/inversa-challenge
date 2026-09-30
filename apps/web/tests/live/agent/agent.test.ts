import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { NOW, ofType, resetState, setupAgentEnv, streamedText, turn, type AgentEnv } from "../../server/agent/helpers";

import { POST } from "@/app/api/agent/stream/route";
import { resetHarness } from "@/server/agent/cordis/boot";
import { AGENT_MODEL_ID, openRouterApiKey } from "@/server/agent/runtime/model";
import type { Evidence } from "@/server/agent/runtime/registry";
import { AGENT_STREAM_CONTENT_TYPE, isAgentStreamEvent, type AgentStreamEvent } from "@/shared/agent/events";

/**
 * Live: GPT-6 Luna on OpenRouter, tools answering from the fixture GraphQL stub.
 * Run with `bun run test:live` (doppler supplies OPENROUTER_API_KEY).
 */

const FLORIDA_BAY = { west: -81.1, south: 24.85, east: -80.35, north: 25.25 };
const ALERTS_QUESTION = "Any NWS alerts in effect for Florida Bay right now? Cite them.";

let env: AgentEnv;

beforeAll(() => {
  if (!openRouterApiKey()) throw new Error("live tests need OPENROUTER_API_KEY: run `bun run test:live` (doppler inversa/dev)");
  env = setupAgentEnv();
});

afterAll(async () => {
  await resetHarness();
  env?.cleanup();
});

beforeEach(() => {
  resetState();
  env.stub.requests.length = 0;
});

/** Evidence ids that tools returned in this turn. */
function returnedIds(events: AgentStreamEvent[]): Set<string> {
  return new Set(
    ofType(events, "tool_end").flatMap((event) =>
      event.ok ? ((event.data as { evidence?: Evidence[] } | undefined)?.evidence ?? []).map((row) => row.id) : [],
    ),
  );
}

function expectContract(events: AgentStreamEvent[]): void {
  expect(events.every(isAgentStreamEvent)).toBe(true);
  expect(ofType(events, "done")).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("done");
}

describe("live turn", () => {
  test("a real tool call returns evidence and the answer cites it", async () => {
    const view = { bbox: FLORIDA_BAY, time: NOW.toISOString(), layers: [], selection: null };
    const { events, result } = await turn(ALERTS_QUESTION, { view });

    expectContract(events);
    expect(ofType(events, "error")).toHaveLength(0);
    expect(result.model).toBe(AGENT_MODEL_ID);
    const alerts = ofType(events, "tool_end").filter((event) => event.capabilityName === "alerts" && event.ok);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(env.stub.requests.map((request) => request.operationName)).toContain("AgentAlerts");

    // Every citation the client saw is evidence a tool returned this turn, and at least one alert is cited.
    const returned = returnedIds(events);
    const cited = ofType(events, "citation").map((event) => event.id);
    expect(cited.length).toBeGreaterThanOrEqual(1);
    for (const id of cited) expect(returned.has(id)).toBe(true);
    expect(result.citations).toEqual(cited);
    expect(cited.some((id) => id.startsWith("alert:"))).toBe(true);
    expect(result.content).toMatch(/\[e:alert:\d+\]/);
    expect(result.content).toMatch(/small craft/i);
    expect(streamedText(events)).toBe(result.content);

    // Usage came back from OpenRouter and landed in the daily budget file.
    expect(result.usage.promptTokens + result.usage.cacheRead).toBeGreaterThan(500);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
    const budget = JSON.parse(await Bun.file(`${env.dataDir}/agent-budget.json`).text()) as { used: number };
    expect(budget.used).toBe(result.usage.promptTokens + result.usage.cacheRead + result.usage.completionTokens);
  });

  test("a follow-up turn carries the transcript", async () => {
    const sessionId = `live-followup-${Date.now()}`;
    const first = await turn("Which data feeds are stale or down right now?", { sessionId });
    expect(first.result.content.length).toBeGreaterThan(0);
    const second = await turn("Of those, which one matters most for lionfish dive planning? One sentence.", { sessionId });
    expectContract(second.events);
    const history = ofType(second.events, "context")[0]!.segments.find((segment) => segment.label === "history")!;
    expect(history.tokens).toBeGreaterThan(10);
    expect(second.result.content).toMatch(/ndbc|buoy|sea|wave|water/i);
  });

  test("a repeat question on the same data version is served from the cache without the model", async () => {
    const question = "Any NWS alerts in effect for Florida Bay right now?";
    const first = await turn(question, { cache: true });
    expect(first.result.cached).toBe(false);
    expect(first.result.content.length).toBeGreaterThan(0);
    const second = await turn("  any nws ALERTS in effect for florida bay right now ", { cache: true });
    expect(second.result.cached).toBe(true);
    expect(second.result.content).toBe(first.result.content);
    expect(second.result.usage).toEqual({ promptTokens: 0, completionTokens: 0, cacheRead: 0 });
    expect(env.stub.requests.at(-1)?.operationName).toBe("AgentFeeds");
    expectContract(second.events);
  });
});

describe("live route", () => {
  test("POST streams valid C7 NDJSON ending in done", async () => {
    const response = await POST(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: `live-route-${Date.now()}`,
          question: ALERTS_QUESTION,
          view: { bbox: FLORIDA_BAY, time: NOW.toISOString(), layers: [], selection: null },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(`${AGENT_STREAM_CONTENT_TYPE}; charset=utf-8`);
    const text = await response.text();
    expect(text.endsWith("\n")).toBe(true);
    const events = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as AgentStreamEvent);
    expectContract(events);
    const types = new Set(events.map((event) => event.type));
    for (const type of ["context", "status", "tool_start", "tool_end", "citation", "content_delta"] as const) {
      expect(types.has(type)).toBe(true);
    }
    const done = events.at(-1) as Extract<AgentStreamEvent, { type: "done" }>;
    expect(done.content).toMatch(/\[e:alert:\d+\]/);
  });
});

describe("live limits", () => {
  const STEPWISE =
    "Call feed_state first. After you have its result, call alerts. After that, call hotspots for python. Only then answer.";

  test("tool call cap: calls past the cap are denied and the turn still ends", async () => {
    const { events, result } = await turn(STEPWISE, { limits: { maxToolCalls: 1 } });
    expectContract(events);
    expect(result.limitHit).toEqual({ kind: "tool_calls", limit: 1 });
    const executed = ofType(events, "tool_end").filter((event) => event.ok);
    expect(executed).toHaveLength(1);
    expect(env.stub.requests.filter((request) => request.operationName !== "AgentFeeds").length).toBeLessThanOrEqual(1);
    const denied = ofType(events, "tool_end").filter((event) => !event.ok);
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]!.error).toContain("Tool call limit reached (1)");
    expect(ofType(events, "debug").map((event) => event.text)).toContain("limit reached: 1 tool calls");
  });

  test("turn cap: the loop stops after the capped number of model steps", async () => {
    const { events, result } = await turn(STEPWISE, { limits: { maxTurns: 1 } });
    expectContract(events);
    expect(result.limitHit).toEqual({ kind: "turns", limit: 1 });
    expect(ofType(events, "debug").map((event) => event.text)).toContain("limit reached: 1 turns");
    expect(result.content).toBe("");
    expect(ofType(events, "error").map((event) => event.message)).toContain("Stopped at the turns limit before an answer.");
  });

  test("runtime cap: a turn over its time budget is cancelled promptly", async () => {
    const started = Date.now();
    const { events, result } = await turn(STEPWISE, { limits: { maxRuntimeMs: 1_000 } });
    expect(Date.now() - started).toBeLessThan(15_000);
    expectContract(events);
    expect(result.limitHit).toEqual({ kind: "runtime", limit: 1_000 });
    expect(ofType(events, "debug").map((event) => event.text)).toContain("limit reached: 1 s runtime");
  });
});
