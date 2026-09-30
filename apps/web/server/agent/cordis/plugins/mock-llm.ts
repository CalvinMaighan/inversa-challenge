import { CallId, LlmAdapter, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";

/**
 * Scripted LLM for tests and replay evals. No network.
 *
 * A script is registered per question. The adapter finds it from the latest
 * user text, then asks it for the next step given the tool results so far:
 * either tool calls, or a final text streamed in small chunks (so citation
 * markers straddle chunk boundaries the way real streams do).
 */

export type MockToolCall = { name: string; args?: Record<string, unknown> };
export type MockToolResult = { name: string; text: string; json: unknown };
export type MockStepInput = {
  question: string;
  /** Every user-role text in order: injected transcript and view context, then the question. */
  userTexts: string[];
  /** Model calls so far in this turn (0 on the first call). */
  step: number;
  toolResults: MockToolResult[];
  toolNames: string[];
  system: string;
  /** Catalog id the harness asked for (escalation re-runs on the pro model). */
  model: string;
};
export type MockStep =
  | { toolCalls: MockToolCall[]; delayMs?: number }
  | { text: string; delayMs?: number }
  | { empty: true };
export type MockScript = (input: MockStepInput) => MockStep;

const scripts = new Map<string, MockScript>();
let lastSystemPrompt = "";
let calls = 0;

export function normalizeMockQuestion(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function setMockScript(question: string, script: MockScript): void {
  scripts.set(normalizeMockQuestion(question), script);
}

export function clearMockScripts(): void {
  scripts.clear();
  calls = 0;
}

export function lastMockSystemPrompt(): string {
  return lastSystemPrompt;
}

/** Number of model calls since the last `clearMockScripts()`. */
export function mockLlmCalls(): number {
  return calls;
}

const CHUNK_CHARS = 5;

function textOf(blocks: readonly { type: string }[]): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Deedee's unscripted behavior: "tool" in the question calls the first tool once. */
function defaultScript(input: MockStepInput): MockStep {
  if (/\bEMPTY_REPLY\b/.test(input.question)) return { empty: true };
  if (input.toolResults.length === 0 && /\btool\b/i.test(input.question) && input.toolNames.length > 0) {
    return { toolCalls: [{ name: input.toolNames[0]!, args: {} }] };
  }
  return { text: input.toolResults.length > 0 ? "pong from tool" : "ok" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class MockLlmAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "Mock" };
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"],
      context: { contextWindow: 32_000 },
      defaultMaxTokens: 1_024,
      reasoning: {
        efforts: [{ id: ReasoningEffortId("off"), name: "off" }],
        defaultEffort: ReasoningEffortId("off"),
      },
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls += 1;
    lastSystemPrompt = options.system ?? "";
    const callNames = new Map<string, string>();
    const toolResults: MockToolResult[] = [];
    const userTexts: string[] = [];
    let step = 0;
    for (const message of options.messages) {
      if (message.role === "assistant") {
        step += 1;
        for (const block of message.content) {
          if (block.type === "tool-call") callNames.set(String(block.id), block.name);
        }
        continue;
      }
      for (const block of message.content) {
        if (block.type === "tool-result") {
          const text = textOf(block.content);
          toolResults.push({ name: callNames.get(String(block.toolCallId)) ?? "unknown", text, json: parseJson(text) });
        }
      }
      const text = textOf(message.content);
      if (text) userTexts.push(text);
    }
    const script =
      [...userTexts].reverse().map((text) => scripts.get(normalizeMockQuestion(text))).find(Boolean) ?? defaultScript;
    const next = script({
      question: userTexts.at(-1) ?? "",
      userTexts,
      step,
      toolResults,
      toolNames: (options.tools ?? []).map((tool) => tool.name),
      system: lastSystemPrompt,
      model: options.model,
    });
    const inputTokens = Math.ceil(
      (lastSystemPrompt.length + JSON.stringify(options.messages).length) / 4,
    );

    if ("delayMs" in next && next.delayMs && !(await sleep(next.delayMs, options.signal))) {
      yield { type: "finish", reason: { kind: "aborted", failure: { message: "aborted", code: "ABORTED" } } };
      return;
    }
    if ("empty" in next) {
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if ("toolCalls" in next) {
      let index = 0;
      for (const call of next.toolCalls) {
        const id = CallId(`mock-${step}-${index}`);
        const args = JSON.stringify(call.args ?? {});
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: args };
        yield { type: "block-end", index, block: { type: "tool-call", id, name: call.name, arguments: args } };
        index += 1;
      }
      yield { type: "usage", usage: { inputTokens, outputTokens: 12 * next.toolCalls.length } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    for (let at = 0; at < next.text.length; at += CHUNK_CHARS) {
      yield { type: "text-delta", index: 0, text: next.text.slice(at, at + CHUNK_CHARS) };
    }
    yield { type: "block-end", index: 0, block: { type: "text", text: next.text } };
    yield { type: "usage", usage: { inputTokens, outputTokens: Math.ceil(next.text.length / 4) } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export const name = "inversa-llm-mock";
export const inject = ["llm"];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter(["fireworks"], new MockLlmAdapter());
}
