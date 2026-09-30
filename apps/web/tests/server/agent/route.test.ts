import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { NOW, resetState, setupAgentEnv, type AgentEnv } from "./helpers";

import { POST, dynamic, runtime } from "@/app/api/agent/stream/route";
import { resetHarness } from "@/server/agent/cordis/boot";
import { setMockScript } from "@/server/agent/cordis/plugins/mock-llm";
import { AGENT_STREAM_CONTENT_TYPE, isAgentStreamEvent, type AgentStreamEvent } from "@/shared/agent/events";

let env: AgentEnv;

beforeAll(() => {
  env = setupAgentEnv();
  process.env.AGENT_HARNESS = "mock";
});

afterAll(async () => {
  delete process.env.AGENT_HARNESS;
  await resetHarness();
  env.cleanup();
});

beforeEach(() => {
  resetState();
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/agent/stream", () => {
  test("route streams ndjson", async () => {
    const question = "Any alerts over Florida Bay?";
    setMockScript(question, (input) =>
      input.step === 0
        ? { toolCalls: [{ name: "alerts", args: { bbox: { west: -81.1, south: 24.85, east: -80.35, north: 25.25 } } }] }
        : { text: "Small Craft Advisory [e:alert:5002] and a made-up one [e:alert:9]." },
    );
    const response = await post({
      sessionId: "route-test-1",
      question,
      view: { bbox: { west: -81.1, south: 24.85, east: -80.35, north: 25.25 }, time: NOW.toISOString(), layers: [], selection: null },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(`${AGENT_STREAM_CONTENT_TYPE}; charset=utf-8`);

    const text = await response.text();
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    const events = lines.map((line) => JSON.parse(line) as AgentStreamEvent);
    expect(events.every(isAgentStreamEvent)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", content: "Small Craft Advisory [e:alert:5002] and a made-up one." });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    const types = new Set(events.map((event) => event.type));
    for (const type of ["context", "status", "tool_start", "tool_end", "citation", "content_delta", "debug"] as const) {
      expect(types.has(type)).toBe(true);
    }
  });

  test("route config is nodejs and dynamic", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });

  test("rejects a malformed request with 400 before streaming", async () => {
    expect((await post("{not json")).status).toBe(400);
    const missing = await post({ sessionId: "x", question: "   " });
    expect(missing.status).toBe(400);
    const badSession = await post({ sessionId: "../etc/passwd", question: "hi" });
    expect(badSession.status).toBe(400);
    const badView = await post({
      sessionId: "ok",
      question: "hi",
      view: { bbox: { west: 1, south: 1, east: 0, north: 2 }, time: "yesterday-ish", layers: [], selection: null },
    });
    expect(badView.status).toBe(400);
    const body = (await badView.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("Invalid agent request");
    expect(body.issues.length).toBeGreaterThanOrEqual(2);
  });
});
