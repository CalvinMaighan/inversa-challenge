import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ofType, resetState, setupAgentEnv, streamedText, turn, type AgentEnv } from "./helpers";

import { resetHarness } from "@/server/agent/cordis/boot";

/**
 * The live harness against a local OpenAI-compatible fake: exercises the
 * Fireworks adapter (message mapping, streamed tool-call deltas, reasoning,
 * usage) without a network call or a real key.
 */

type ChatRequest = {
  model: string;
  messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
  reasoning_effort?: string;
  temperature?: number;
  stream?: boolean;
};

const FAKE_KEY = "fake-key-for-local-test-server";
const requests: { body: ChatRequest; auth: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
let env: AgentEnv;

function sse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-1",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const usage = (prompt: number, completion: number) => ({
  id: "cmpl-1",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake",
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

beforeAll(() => {
  env = setupAgentEnv();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as ChatRequest;
      requests.push({ body, auth: request.headers.get("authorization") });
      const toolDone = body.messages.some((message) => message.role === "tool");
      if (!toolDone) {
        return sse([
          chunk({ role: "assistant", reasoning_content: "need alerts" }),
          chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "alerts", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"bbox":{"west":-81.1,"south":24.85,' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"east":-80.35,"north":25.25}}' } }] }),
          chunk({}, "tool_calls"),
          usage(900, 40),
        ]);
      }
      return sse([
        chunk({ role: "assistant", content: "Small Craft Advisory [e:ale" }),
        chunk({ content: "rt:5002] in effect; ignore [e:alert:77]." }),
        chunk({}, "stop"),
        usage(1500, 30),
      ]);
    },
  });
  process.env.FIREWORKS_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(async () => {
  delete process.env.FIREWORKS_BASE_URL;
  delete process.env.FIREWORKS_API_KEY;
  await resetHarness();
  void server.stop(true);
  env.cleanup();
});

beforeEach(() => {
  resetState();
  requests.length = 0;
});

describe("Fireworks adapter (live harness, local fake endpoint)", () => {
  test("streams a tool call, runs it, and answers with verified citations", async () => {
    process.env.FIREWORKS_API_KEY = FAKE_KEY;
    const { events, result } = await turn("Alerts over Florida Bay?", { harnessMode: "live" });

    expect(ofType(events, "error")).toHaveLength(0);
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.content).toBe("Small Craft Advisory [e:alert:5002] in effect; ignore.");
    expect(streamedText(events)).toBe(result.content);
    expect(result.citations).toEqual(["alert:5002"]);
    expect(ofType(events, "reasoning_delta").map((event) => event.text).join("")).toBe("need alerts");
    expect(ofType(events, "tool_start")[0]).toMatchObject({ toolCallId: "call_a", capabilityName: "alerts" });
    expect(result.usage.promptTokens).toBe(2_400);
    expect(result.usage.completionTokens).toBe(70);

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first!.auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(first!.body.model).toBe("accounts/fireworks/models/deepseek-v4p1-flash");
    expect(first!.body.stream).toBe(true);
    expect(first!.body.temperature).toBe(0.25);
    expect(first!.body.reasoning_effort).toBe("low");
    expect(first!.body.messages[0]!.role).toBe("system");
    expect(first!.body.messages[0]!.content).toContain("Everglades Ops analyst");
    expect(first!.body.tools?.map((tool) => tool.function.name).sort()).toEqual([
      "alerts",
      "backtest",
      "conditions",
      "explain_cell",
      "feed_state",
      "geocode",
      "hotspots",
      "set_view",
      "sightings",
    ]);
    const toolMessage = second!.body.messages.find((message) => message.role === "tool")!;
    expect(toolMessage.tool_call_id).toBe("call_a");
    const toolJson = JSON.parse(toolMessage.content!) as { rows: { evidenceId: string }[]; feedSummary: unknown };
    expect(toolJson.rows.map((row) => row.evidenceId)).toEqual(["alert:5001", "alert:5002"]);
    expect(toolJson.feedSummary).toEqual({ worst: "down", lagging: [], stale: [], down: ["nwws"] });
    const assistant = second!.body.messages.find((message) => message.role === "assistant")!;
    expect(assistant.tool_calls).toHaveLength(1);
  });

  test("a missing FIREWORKS_API_KEY ends the turn with an error, not a hang", async () => {
    delete process.env.FIREWORKS_API_KEY;
    const { events, result } = await turn("Alerts over Florida Bay?", { harnessMode: "live" });
    expect(requests).toHaveLength(0);
    expect(result.content).toBe("");
    expect(ofType(events, "error").some((event) => event.message.includes("FIREWORKS_API_KEY"))).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });
});
