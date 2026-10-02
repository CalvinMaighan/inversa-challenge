import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ofType, resetState, setupAgentEnv, turn, type AgentEnv } from "./helpers";

import { DEFAULT_DAILY_TOKENS, dailyTokenLimit, recordTokens, resetBudgetCache, tokenBudget } from "@/server/agent/budget";
import {
  ANSWER_CACHE_TTL_MS,
  answerCacheKey,
  clearAnswerCache,
  normalizeQuestion,
  readAnswerCache,
  writeAnswerCache,
} from "@/server/agent/cache";
import { AGENT_LIMITS, attachTurnLimits, type LimitHit } from "@/server/agent/cordis/limits";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";

/** Turn guards that never reach the model: budget, missing key, cache keys, limit arithmetic. */

let env: AgentEnv;
const savedKey = process.env.OPENROUTER_API_KEY;

beforeAll(() => {
  env = setupAgentEnv();
});

afterAll(() => {
  if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
  env.cleanup();
});

beforeEach(() => {
  resetState();
  env.stub.requests.length = 0;
});

describe("runTurn refuses without a model call", () => {
  test("missing OPENROUTER_API_KEY ends the turn with the unavailable error and done", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { events, result } = await turn("Any alerts over Florida Bay?");
    expect(ofType(events, "error").map((event) => event.message)).toEqual(["agent unavailable: OPENROUTER_API_KEY not set"]);
    expect(events.at(-1)).toEqual({ type: "done", content: "" });
    expect(events).toHaveLength(2);
    expect(result.model).toBe("none");
    expect(env.stub.requests).toHaveLength(0);
  });

  test("an exhausted daily budget answers before anything else", async () => {
    process.env.AGENT_DAILY_TOKENS = "1000";
    recordTokens(1_000);
    const { events, result } = await turn("hello again");
    expect(result.content).toBe("");
    expect(ofType(events, "error")[0]!.message).toContain("Daily agent token budget (1,000) is used up");
    expect(events.at(-1)).toEqual({ type: "done", content: "" });
    expect(env.stub.requests).toHaveLength(0);
  });
});

describe("daily token budget", () => {
  test("default limit and env override", () => {
    expect(dailyTokenLimit()).toBe(DEFAULT_DAILY_TOKENS);
    expect(DEFAULT_DAILY_TOKENS).toBe(100_000_000);
    process.env.AGENT_DAILY_TOKENS = "250000";
    expect(dailyTokenLimit()).toBe(250_000);
    process.env.AGENT_DAILY_TOKENS = "-5";
    expect(dailyTokenLimit()).toBe(DEFAULT_DAILY_TOKENS);
  });

  test("spend accumulates, persists across a restart, and rolls over at UTC midnight", async () => {
    const day = new Date("2026-01-15T23:59:00Z");
    recordTokens(1_200.4, day);
    recordTokens(0, day);
    recordTokens(-50, day);
    recordTokens(800, day);
    expect(tokenBudget(day)).toMatchObject({ day: "2026-01-15", used: 2_000, remaining: DEFAULT_DAILY_TOKENS - 2_000 });
    const file = JSON.parse(await Bun.file(`${env.dataDir}/agent-budget.json`).text()) as { day: string; used: number };
    expect(file).toMatchObject({ day: "2026-01-15", used: 2_000 });
    resetBudgetCache();
    expect(tokenBudget(day).used).toBe(2_000);
    expect(tokenBudget(new Date("2026-01-16T00:00:01Z")).used).toBe(0);
  });
});

describe("answer cache keying", () => {
  const bbox = { west: -80.851, south: 25.674, east: -80.68, north: 25.84 };
  const now = new Date("2026-01-15T03:07:00Z");

  test("case, whitespace, curly quotes and trailing punctuation do not change the key", () => {
    expect(normalizeQuestion("  Any ALERTS\n right   now?! ")).toBe("any alerts right now");
    expect(normalizeQuestion("What’s up?")).toBe("what's up");
    expect(answerCacheKey("python", "Any alerts right now?", "v1", { bbox, now })).toBe(
      answerCacheKey("python", "any alerts   right now", "v1", { bbox, now }),
    );
  });

  test("data version, bbox at 0.01° and the 15-minute frame scope the key", () => {
    const base = answerCacheKey("python", "q", "v1", { bbox, now });
    expect(answerCacheKey("python", "q", "v2", { bbox, now })).not.toBe(base);
    expect(answerCacheKey("python", "q", "v1", { bbox: { ...bbox, west: -80.8512 }, now })).toBe(base);
    expect(answerCacheKey("python", "q", "v1", { bbox: { ...bbox, west: -80.86 }, now })).not.toBe(base);
    expect(answerCacheKey("python", "q", "v1", { bbox, now: new Date("2026-01-15T03:14:59Z") })).toBe(base);
    expect(answerCacheKey("python", "q", "v1", { bbox, now: new Date("2026-01-15T03:15:00Z") })).not.toBe(base);
    expect(answerCacheKey("python", "q", "v1")).not.toBe(base);
  });

  test("entries expire after the TTL", () => {
    clearAnswerCache();
    const key = answerCacheKey("python", "q", "v1");
    writeAnswerCache(key, { events: [], content: "a", citations: [] }, 1_000);
    expect(readAnswerCache(key, 1_000 + ANSWER_CACHE_TTL_MS)?.content).toBe("a");
    expect(readAnswerCache(key, 1_001 + ANSWER_CACHE_TTL_MS)).toBeUndefined();
  });
});

describe("turn limits arithmetic", () => {
  type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;

  /** The two hooks attachTurnLimits registers, called the way the harness calls them. */
  function scriptedLoop(limits: { maxTurns: number; maxToolCalls: number }) {
    const handlers = new Map<string, Handler>();
    const ctx = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as Context;
    const cancels: unknown[] = [];
    const agent = { cancel: (reason: unknown) => cancels.push(reason) } as unknown as Agent;
    const hits: LimitHit[] = [];
    attachTurnLimits(agent, ctx, limits, (hit) => hits.push(hit));
    const allowed = async () => ({ kind: "allow" });
    return {
      hits,
      cancels,
      toolCall: () => handlers.get("tools/pre-execute")!({}, allowed),
      step: () => handlers.get("agent/pre-step")!({}, allowed),
    };
  }

  test("defaults match the PRD: 12 turns, 30 tool calls, 90 s", () => {
    expect(AGENT_LIMITS).toEqual({ maxTurns: 12, maxToolCalls: 30, maxRuntimeMs: 90_000 });
  });

  test("tool calls past the cap are denied with a wrap-up reason, reported once", async () => {
    const loop = scriptedLoop({ maxTurns: 12, maxToolCalls: 2 });
    const results = [await loop.toolCall(), await loop.toolCall(), await loop.toolCall(), await loop.toolCall()];
    expect(results.slice(0, 2)).toEqual([{ kind: "allow" }, { kind: "allow" }]);
    for (const denied of results.slice(2)) {
      expect(denied).toMatchObject({ kind: "deny" });
      expect((denied as { reason: string }).reason).toContain("Tool call limit reached (2)");
    }
    expect(loop.hits).toEqual([{ kind: "tool_calls", limit: 2 }]);
    expect(loop.cancels).toHaveLength(0);
  });

  test("the step past the turn cap is rejected and cancels the agent", async () => {
    const loop = scriptedLoop({ maxTurns: 3, maxToolCalls: 30 });
    for (let i = 0; i < 3; i += 1) expect(await loop.step()).toEqual({ kind: "allow" });
    expect(await loop.step()).toEqual({ kind: "reject" });
    expect(loop.hits).toEqual([{ kind: "turns", limit: 3 }]);
    expect(loop.cancels).toEqual([{ kind: "user" }]);
  });
});
