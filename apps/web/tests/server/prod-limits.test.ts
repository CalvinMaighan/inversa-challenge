import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";

import { ofType, resetState, setupAgentEnv, turn, type AgentEnv } from "./agent/helpers";

import { POST } from "@/app/api/agent/stream/route";
import {
  DEFAULT_APP_DAILY_USD,
  DEFAULT_DAILY_TOKENS,
  DEFAULT_DAILY_USD,
  dailyTokenLimit,
  dailyUsdLimits,
  recordUsage,
  resetBudgetCache,
  spendRefusal,
  spendToday,
  turnCostUsd,
} from "@/server/agent/budget";
import { answerCacheKey } from "@/server/agent/cache";
import { AGENT_LIMITS } from "@/server/agent/cordis/limits";
import { AGENT_MODEL_ID, resolveAgentEndpoint } from "@/server/agent/runtime/model";
import { routeLimiter } from "@/server/rate-limit";
import { voiceLimitsFromEnv } from "@/server/voice/budget";
import { APP_IDS } from "@/shared/apps";
import { VOICE_DAILY_MINUTES, VOICE_MAX_SESSION_MS } from "@/shared/voice/protocol";

/**
 * R19 limits as production runs them (gates/leaf-H1.md G1): per-IP rate limit, the per-app and global daily
 * dollar caps (plus the token cap), the per-turn token and tool-call budget, the answer cache's key, and the
 * typed `{error, code}` refusals the chat shows. Nothing here reaches a model.
 */

const CAP_ENV = ["AGENT_DAILY_USD", "AGENT_APP_DAILY_USD", "AGENT_DAILY_TOKENS", "AGENT_PRICE_IN_PER_M", "AGENT_PRICE_OUT_PER_M", "AGENT_MAX_CONCURRENT"];
const savedKey = process.env.OPENROUTER_API_KEY;
const inFlight = globalThis as unknown as { __inversaAgentInFlight?: { n: number } };
let env: AgentEnv;
let client = 0;

beforeAll(() => {
  env = setupAgentEnv();
});

afterAll(() => {
  if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
  else delete process.env.OPENROUTER_API_KEY;
  env.cleanup();
});

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  for (const key of CAP_ENV) delete process.env[key];
  resetState();
  // A fresh day file for every test.
  rmSync(`${env.dataDir}/agent-budget.json`, { force: true });
  resetBudgetCache();
});

afterEach(() => {
  inFlight.__inversaAgentInFlight = { n: 0 };
});

/** A valid request for `app`, each from its own address unless `ip` pins one. */
function ask(app: string, ip?: string, body?: string): Promise<Response> {
  client += 1;
  return POST(
    new Request("http://localhost/api/agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip ?? `2001:db8:4801::${client.toString(16)}` },
      body: body ?? JSON.stringify({ app, sessionId: `s${client}`, question: "Any alerts?" }),
    }),
  );
}

type Refusal = { error: string; code: string; cap?: string };

/** A refusal is JSON `{error, code}` with no stack trace, file path or module name in it. */
async function refusal(res: Response): Promise<Refusal> {
  expect(res.headers.get("content-type")).toContain("application/json");
  const text = await res.text();
  expect(text).not.toMatch(/\n\s+at |node_modules|\.ts:\d+|Error:/);
  const body = JSON.parse(text) as Refusal;
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(0);
  return body;
}

/** Spend `usd` for `app` at the default prices (input only: $0.10 per million tokens). */
function spend(app: string, usd: number): void {
  recordUsage(app, { promptTokens: Math.round(usd * 10_000_000), completionTokens: 0, cacheRead: 0 });
}

describe("prod limits", () => {
  test("per-IP rate limit: the 11th request in a minute is a typed 429 with Retry-After; another IP is unaffected", async () => {
    const ip = "203.0.113.77";
    routeLimiter("agent").sweep(Date.now() + 120_000);
    for (let i = 0; i < 10; i++) expect((await ask("carp", ip)).status).toBe(503); // under the limit: no key
    const eleventh = await ask("carp", ip);
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refusal(eleventh)).toMatchObject({ code: "rate_limited", error: expect.stringContaining("Too many requests") });
    expect((await ask("carp", "203.0.113.78")).status).toBe(503);
  });

  test("daily dollar caps: $5 for all apps and $2 per app by default, each set from the env", () => {
    expect(DEFAULT_DAILY_USD).toBe(5);
    expect(DEFAULT_APP_DAILY_USD).toBe(2);
    expect(dailyUsdLimits()).toEqual({ global: 5, perApp: 2 });
    process.env.AGENT_DAILY_USD = "12.5";
    process.env.AGENT_APP_DAILY_USD = "4";
    expect(dailyUsdLimits()).toEqual({ global: 12.5, perApp: 4 });
    process.env.AGENT_DAILY_USD = "-1";
    process.env.AGENT_APP_DAILY_USD = "lots";
    expect(dailyUsdLimits()).toEqual({ global: 5, perApp: 2 });
    expect(dailyTokenLimit()).toBe(DEFAULT_DAILY_TOKENS);
  });

  test("turn cost: GPT-6 Luna list price, cache reads charged as input, prices from the env", () => {
    expect(turnCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000, cacheRead: 0 })).toBeCloseTo(0.6, 10);
    expect(turnCostUsd({ promptTokens: 0, completionTokens: 0, cacheRead: 2_000_000 })).toBeCloseTo(0.2, 10);
    process.env.AGENT_PRICE_IN_PER_M = "1";
    process.env.AGENT_PRICE_OUT_PER_M = "2";
    expect(turnCostUsd({ promptTokens: 500_000, completionTokens: 250_000, cacheRead: 0 })).toBeCloseTo(1, 10);
  });

  test("per-app cap: an app over its cap gets a typed 429 cost_cap; the other apps still pass", async () => {
    process.env.AGENT_APP_DAILY_USD = "0.5";
    spend("lionfish", 0.6);
    expect(spendRefusal("lionfish")?.cap).toBe("app_usd");
    const res = await ask("lionfish");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await refusal(res);
    expect(body).toMatchObject({ code: "cost_cap", cap: "app_usd" });
    expect(body.error).toBe("This app's daily agent spending cap ($0.50) is used up. It resets at 00:00 UTC.");
    for (const app of ["carp", "python"]) {
      expect(spendRefusal(app)).toBeNull();
      expect((await refusal(await ask(app))).code).toBe("agent_unavailable");
    }
  });

  test("global cap: the apps' spend together over the global cap refuses every app", async () => {
    process.env.AGENT_DAILY_USD = "1";
    spend("carp", 0.4);
    spend("python", 0.4);
    expect(spendRefusal("lionfish")).toBeNull();
    spend("lionfish", 0.25);
    expect(spendToday().usd).toBeCloseTo(1.05, 6);
    for (const app of APP_IDS) {
      const body = await refusal(await ask(app));
      expect(body).toMatchObject({ code: "cost_cap", cap: "global_usd" });
      expect(body.error).toContain("$1.00 across all apps");
    }
  });

  test("the token cap still applies, and a used-up cap ends a turn with a typed error and done, no model call", async () => {
    process.env.AGENT_DAILY_TOKENS = "1000";
    recordUsage("python", { promptTokens: 1_000, completionTokens: 0, cacheRead: 0 });
    expect(spendRefusal("carp")?.cap).toBe("tokens");
    process.env.OPENROUTER_API_KEY = "sk-test-never-sent";
    const { events, result } = await turn("Any alerts over Florida Bay?");
    expect(ofType(events, "error").map((e) => e.message)).toEqual(["Daily agent token budget (1,000) is used up. It resets at 00:00 UTC."]);
    expect(events.at(-1)).toEqual({ type: "done", content: "" });
    expect(result.model).toBe("none");
    expect(env.stub.requests).toHaveLength(0);
  });

  test("spend survives a restart, rolls over at UTC midnight, and an unwritable data dir never fails a turn", () => {
    const day = new Date("2026-03-01T23:59:00Z");
    recordUsage("carp", { promptTokens: 1_000_000, completionTokens: 0, cacheRead: 0 }, day);
    const file = JSON.parse(readFileSync(`${env.dataDir}/agent-budget.json`, "utf8")) as { day: string; usd: number; apps: Record<string, number> };
    expect(file.day).toBe("2026-03-01");
    expect(file.apps.carp).toBeCloseTo(0.1, 10);
    resetBudgetCache();
    expect(spendToday(day).apps.carp).toBeCloseTo(0.1, 10);
    expect(spendToday(new Date("2026-03-02T00:00:01Z")).usd).toBe(0);

    const saved = process.env.INVERSA_DATA_DIR;
    process.env.INVERSA_DATA_DIR = "/dev/null/not-a-dir";
    resetBudgetCache();
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => recordUsage("python", { promptTokens: 10, completionTokens: 10, cacheRead: 0 })).not.toThrow();
      expect(spendToday().tokens).toBe(20);
    } finally {
      console.error = quiet;
      process.env.INVERSA_DATA_DIR = saved;
      resetBudgetCache();
    }
  });

  test("per-turn budget: max output tokens per call, turn and tool-call caps, runtime cap", () => {
    expect(AGENT_LIMITS).toEqual({ maxTurns: 12, maxToolCalls: 30, maxRuntimeMs: 90_000 });
    for (const app of APP_IDS) {
      const endpoint = resolveAgentEndpoint(AGENT_MODEL_ID, app);
      expect(endpoint.maxTokens).toBe(16_384);
    }
  });

  test("concurrency: past AGENT_MAX_CONCURRENT live turns the route answers a typed 503 busy", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-never-sent";
    process.env.AGENT_MAX_CONCURRENT = "2";
    inFlight.__inversaAgentInFlight = { n: 2 };
    const res = await ask("python");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await refusal(res)).code).toBe("busy");
    expect(inFlight.__inversaAgentInFlight.n).toBe(2);
  });

  test("bad input is a typed 400 (415 for a non-JSON body), never a stack trace", async () => {
    expect(await refusal(await ask("python", undefined, "{not json"))).toMatchObject({ code: "invalid_request", error: "Invalid JSON body" });
    expect((await refusal(await ask("otter"))).code).toBe("invalid_request");
    // A cross-site page can send text/plain without a preflight; only JSON is accepted.
    const plain = await POST(
      new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "content-type": "text/plain", "x-forwarded-for": "2001:db8:4801::f00d" },
        body: JSON.stringify({ app: "carp", sessionId: "x", question: "Any alerts?" }),
      }),
    );
    expect(plain.status).toBe(415);
    expect((await refusal(plain)).code).toBe("invalid_request");
  });

  test("answer cache key: app + normalized question + data version", () => {
    const base = answerCacheKey("carp", "Any alerts right now?", "v1");
    expect(answerCacheKey("carp", "any alerts   right now", "v1")).toBe(base);
    expect(answerCacheKey("lionfish", "Any alerts right now?", "v1")).not.toBe(base);
    expect(answerCacheKey("python", "Any alerts right now?", "v1")).not.toBe(base);
    expect(answerCacheKey("carp", "Any alerts right now?", "v2")).not.toBe(base);
    expect(answerCacheKey("carp", "Any floods right now?", "v1")).not.toBe(base);
  });

  test("voice caps unchanged: 5 min per session, 60 min a day, 20 opens per IP an hour, 4 live", () => {
    expect(VOICE_MAX_SESSION_MS).toBe(5 * 60_000);
    expect(VOICE_DAILY_MINUTES).toBe(60);
    const limits = voiceLimitsFromEnv({});
    expect(limits).toMatchObject({ maxSessionMs: 300_000, dailyMinutes: 60, ipSessionsPerHour: 20, maxLiveSessions: 4 });
  });
});
