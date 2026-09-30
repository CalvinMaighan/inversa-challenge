import { describe, expect, test } from "bun:test";

import type OpenAI from "openai";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";

import { buildChatRequest, mapChatStream, openRouterEffort } from "@/server/agent/cordis/plugins/llm-openrouter";
import { OPENROUTER_BASE_URL, OPENROUTER_HEADERS, resolveAgentEndpoint } from "@/server/agent/runtime/model";

/**
 * Pure halves of the OpenRouter adapter: the request body it builds and how it
 * maps OpenRouter's SSE chunks. The chunk shapes below are copied from a real
 * `openai/gpt-6-luna` stream (tool call, then the usage chunk).
 */

const endpoint = resolveAgentEndpoint("openai/gpt-6-luna");

function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: "openrouter",
    model: "openai/gpt-6-luna",
    system: "You are the Everglades Ops analyst.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Alerts over Florida Bay?" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_a", name: "geocode", arguments: '{"place":"Florida Bay"}' },
          { type: "tool-call", id: "call_b", name: "alerts", arguments: "{}" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool-result", toolCallId: "call_a", content: [{ type: "text", text: '{"bbox":{}}' }] },
          { type: "tool-result", toolCallId: "call_b", content: [{ type: "text", text: '{"rows":[]}' }] },
        ],
      },
    ],
    tools: [{ name: "alerts", description: "NWS alerts", parameters: { type: "object", properties: {} } }],
    ...extra,
  } as unknown as GenerateOptions;
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) =>
  ({
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "openai/gpt-6-luna",
    provider: "OpenAI",
    choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish ? "completed" : null }],
    ...(usage ? { usage } : {}),
  }) as unknown as OpenAI.Chat.ChatCompletionChunk;

async function collect(parts: OpenAI.Chat.ChatCompletionChunk[]): Promise<StreamChunk[]> {
  async function* source() {
    yield* parts;
  }
  const out: StreamChunk[] = [];
  for await (const part of mapChatStream(source())) out.push(part);
  return out;
}

describe("OpenRouter route", () => {
  test("one model, OpenRouter base URL, attribution headers", () => {
    expect(endpoint).toMatchObject({ provider: "openrouter", model: "openai/gpt-6-luna", baseUrl: OPENROUTER_BASE_URL });
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(OPENROUTER_HEADERS).toEqual({ "HTTP-Referer": "https://inversa.calvinmaighan.dev", "X-Title": "Everglades Ops" });
    expect(() => resolveAgentEndpoint("openai/gpt-4o")).toThrow("Unknown agent model");
  });
});

describe("request body", () => {
  test("reasoning goes as the reasoning.effort object; no temperature unless asked", () => {
    const body = buildChatRequest(options(), endpoint);
    expect(body.model).toBe("openai/gpt-6-luna");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning).toEqual({ effort: endpoint.reasoningEffort });
    expect("reasoning_effort" in body).toBe(false);
    expect("temperature" in body).toBe(false);
    expect(body.max_tokens).toBe(endpoint.maxTokens);
    expect(buildChatRequest(options({ temperature: 0.2 }), endpoint).temperature).toBe(0.2);
  });

  test("effort ids map to OpenRouter efforts", () => {
    expect(openRouterEffort("off", "low")).toBe("none");
    expect(openRouterEffort("high", "low")).toBe("high");
    expect(openRouterEffort("minimal", "low")).toBe("minimal");
    expect(openRouterEffort(undefined, "medium")).toBe("medium");
    expect(openRouterEffort("turbo", "low")).toBe("low");
    expect(buildChatRequest(options({ reasoningEffort: "high" as never }), endpoint).reasoning).toEqual({ effort: "high" });
  });

  test("messages: system first, parallel tool calls, one tool message per result", () => {
    const body = buildChatRequest(options(), endpoint);
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    const assistant = body.messages[2] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls?.map((call) => call.id)).toEqual(["call_a", "call_b"]);
    expect(body.messages.slice(3)).toEqual([
      { role: "tool", tool_call_id: "call_a", content: '{"bbox":{}}' },
      { role: "tool", tool_call_id: "call_b", content: '{"rows":[]}' },
    ]);
    expect(body.tools?.map((tool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name)).toEqual(["alerts"]);
  });
});

describe("stream mapping", () => {
  test("a streamed tool call and the trailing usage chunk", async () => {
    const out = await collect([
      chunk({ content: null, role: "assistant", tool_calls: [{ index: 0, id: "call_n", type: "function", function: { name: "get_weather", arguments: "" } }] }),
      chunk({ content: null, role: "assistant", tool_calls: [{ index: 0, function: { arguments: '{"' } }] }),
      chunk({ content: null, role: "assistant", tool_calls: [{ index: 0, function: { arguments: 'city":"Miami"}' } }] }),
      chunk({ content: "", role: "assistant" }, "tool_calls"),
      chunk({ content: "", role: "assistant" }, "tool_calls", {
        prompt_tokens: 52,
        completion_tokens: 18,
        total_tokens: 70,
        cost: 0.0000142,
        prompt_tokens_details: { cached_tokens: 12 },
      }),
    ]);
    expect(out.filter((part) => part.type === "tool-call-delta").map((part) => (part as { argumentsDelta: string }).argumentsDelta).join("")).toBe(
      '{"city":"Miami"}',
    );
    expect(out.find((part) => part.type === "block-end")).toMatchObject({
      block: { type: "tool-call", id: "call_n", name: "get_weather", arguments: '{"city":"Miami"}' },
    });
    expect(out.find((part) => part.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 40, outputTokens: 18, cacheReadTokens: 12 },
    });
    expect(out.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
  });

  test("reasoning from `reasoning` or readable reasoning_details, text, and a length stop", async () => {
    const out = await collect([
      chunk({ role: "assistant", reasoning: "plan ", reasoning_details: [{ type: "reasoning.text", text: "plan " }] }),
      chunk({ role: "assistant", reasoning_details: [{ type: "reasoning.summary", summary: "then answer" }] }),
      chunk({ role: "assistant", reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }] }),
      chunk({ content: "Small Craft " }),
      chunk({ content: "Advisory." }, "length"),
    ]);
    const reasoning = out.filter((part) => part.type === "reasoning-delta").map((part) => (part as { text: string }).text);
    expect(reasoning).toEqual(["plan ", "then answer"]);
    expect(out.find((part) => part.type === "block-end" && part.block.type === "text")).toMatchObject({
      block: { type: "text", text: "Small Craft Advisory." },
    });
    expect(out.at(-1)).toEqual({ type: "finish", reason: { kind: "max-tokens" } });
  });

  test("an empty stop is an error finish, not a silent blank answer", async () => {
    const out = await collect([chunk({ content: "" }, "stop")]);
    expect(out.at(-1)).toMatchObject({ type: "finish", reason: { kind: "error", failure: { code: "EMPTY" } } });
  });
});
