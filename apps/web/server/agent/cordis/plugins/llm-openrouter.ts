import OpenAI from "openai";
import { CallId, LlmAdapter, LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";

import {
  MISSING_KEY_MESSAGE,
  OPENROUTER_HEADERS,
  openRouterApiKey,
  resolveAgentEndpoint,
  type AgentLlmEndpoint,
  type ReasoningEffort,
} from "@/server/agent/runtime/model";

const EFFORTS = ["off", "minimal", "low", "medium", "high"] as const;

/** Agent effort id to OpenRouter's `reasoning.effort`. Unset means the endpoint default. */
export function openRouterEffort(effort: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  if (effort === undefined) return fallback;
  if (effort === "off" || effort === "none") return "none";
  if (effort === "minimal" || effort === "low" || effort === "medium" || effort === "high") return effort;
  return fallback;
}

function textOf(blocks: readonly { type: string }[]): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export type OpenRouterChatRequest = OpenAI.Chat.ChatCompletionCreateParamsStreaming & {
  reasoning: { effort: ReasoningEffort };
};

/** dsh-llm options to an OpenRouter chat completions body. */
export function buildChatRequest(options: GenerateOptions, endpoint: AgentLlmEndpoint): OpenRouterChatRequest {
  const tools = (options.tools ?? []).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  for (const message of options.messages) {
    if (message.role === "assistant") {
      const text = textOf(message.content);
      const toolCalls = message.content.flatMap((block) =>
        block.type === "tool-call"
          ? [{ id: String(block.id), type: "function" as const, function: { name: block.name, arguments: block.arguments } }]
          : [],
      );
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // Every tool result answers its own call id; OpenAI rejects a call left unanswered.
    const toolResults = message.content.flatMap((block) => (block.type === "tool-result" ? [block] : []));
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        messages.push({ role: "tool", tool_call_id: String(result.toolCallId), content: textOf(result.content) });
      }
      continue;
    }
    messages.push({ role: "user", content: textOf(message.content) });
  }

  return {
    model: endpoint.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options.maxTokens ?? endpoint.maxTokens,
    // OpenAI reasoning models take no sampling temperature; send one only when the caller asks.
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    reasoning: {
      effort: openRouterEffort(options.reasoningEffort ? String(options.reasoningEffort) : undefined, endpoint.reasoningEffort),
    },
  };
}

type ReasoningDetail = { type?: string; text?: string; summary?: string };
type OpenRouterDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
  reasoning?: string | null;
  reasoning_details?: ReasoningDetail[];
};

/** Readable reasoning in a delta: `reasoning` when set, else the text or summary details (encrypted ones carry none). */
function reasoningText(delta: OpenRouterDelta | undefined): string {
  if (!delta) return "";
  if (typeof delta.reasoning === "string" && delta.reasoning) return delta.reasoning;
  return (delta.reasoning_details ?? [])
    .map((detail) => (detail.type === "reasoning.text" ? detail.text : detail.type === "reasoning.summary" ? detail.summary : ""))
    .filter((text): text is string => typeof text === "string")
    .join("");
}

/** OpenRouter SSE chunks to dsh-llm stream chunks: text, reasoning, streamed tool calls, usage, finish. */
export async function* mapChatStream(
  parts: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  let nextIndex = 0;
  let textIndex: number | undefined;
  let text = "";
  let reasoningIndex: number | undefined;
  let reasoning = "";
  // `idKnown`: the upstream sent the call id (a placeholder stands in until then, and a delta carrying a
  // placeholder id would announce a call the client could never close).
  const toolBlocks = new Map<number, { index: number; id: string; idKnown: boolean; sent: boolean; name: string; arguments: string }>();
  let usage: TokenUsage | undefined;
  let finishKind: "stop" | "tool-calls" | "max-tokens" = "stop";
  const aborted: StreamChunk = {
    type: "finish",
    reason: { kind: "aborted", failure: { message: "aborted", code: "ABORTED" } },
  };

  try {
    for await (const part of parts) {
      if (signal?.aborted) {
        yield aborted;
        return;
      }
      const choice = part.choices[0];
      const delta = choice?.delta as OpenRouterDelta | undefined;
      if (part.usage) {
        const cached = part.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = {
          inputTokens: Math.max(0, (part.usage.prompt_tokens ?? 0) - cached),
          outputTokens: part.usage.completion_tokens ?? 0,
          cacheReadTokens: cached,
        };
      }
      const thinking = reasoningText(delta);
      if (thinking) {
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex++;
          yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
        }
        reasoning += thinking;
        yield { type: "reasoning-delta", index: reasoningIndex, text: thinking };
      }
      if (delta?.content) {
        if (textIndex === undefined) {
          textIndex = nextIndex++;
          yield { type: "block-start", index: textIndex, blockType: "text" };
        }
        text += delta.content;
        yield { type: "text-delta", index: textIndex, text: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        const key = call.index ?? 0;
        let block = toolBlocks.get(key);
        if (!block) {
          block = { index: nextIndex++, id: call.id ?? `call_${key}`, idKnown: !!call.id, sent: false, name: call.function?.name ?? "", arguments: "" };
          toolBlocks.set(key, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id) {
          block.id = call.id;
          block.idKnown = true;
        }
        const incoming = call.function?.name;
        // Some upstreams resend the full name per delta, others stream fragments.
        if (incoming) {
          if (!block.name || incoming.startsWith(block.name)) block.name = incoming;
          else if (!block.name.startsWith(incoming)) block.name += incoming;
        }
        const argDelta = call.function?.arguments ?? "";
        if (argDelta) block.arguments += argDelta;
        // A delta flows once the call has its id and name (the first one may carry no arguments yet: it announces
        // the call); the assembled call follows at `block-end` either way.
        if (block.idKnown && block.name && (argDelta || !block.sent)) {
          block.sent = true;
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: CallId(block.id),
            name: block.name || undefined,
            argumentsDelta: argDelta,
          };
        }
      }
      if (choice?.finish_reason === "tool_calls") finishKind = "tool-calls";
      if (choice?.finish_reason === "length") finishKind = "max-tokens";
    }
  } catch (error) {
    if (signal?.aborted) {
      yield aborted;
      return;
    }
    const message = error instanceof Error ? error.message : "LLM request failed";
    throw new LlmError(message, "TRANSPORT", { cause: error });
  }

  if (reasoningIndex !== undefined) {
    yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoning } };
  }
  if (!text && toolBlocks.size === 0 && finishKind === "stop") {
    yield {
      type: "finish",
      reason: { kind: "error", failure: { message: "The model returned an empty reply.", code: "EMPTY" } },
    };
    return;
  }
  if (textIndex !== undefined) {
    yield { type: "block-end", index: textIndex, block: { type: "text", text } };
  }
  for (const block of toolBlocks.values()) {
    yield {
      type: "block-end",
      index: block.index,
      block: { type: "tool-call", id: CallId(block.id), name: block.name, arguments: block.arguments },
    };
  }
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: finishKind } };
}

/** OpenRouter chat completions (OpenAI-compatible) as a dsh-llm adapter. */
export class OpenRouterAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "OpenRouter" };
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const endpoint = resolveAgentEndpoint(model);
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"],
      context: { contextWindow: endpoint.contextWindow },
      defaultMaxTokens: endpoint.maxTokens,
      reasoning: {
        efforts: EFFORTS.map((id) => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId(endpoint.reasoningEffort === "none" ? "off" : endpoint.reasoningEffort),
      },
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const endpoint = resolveAgentEndpoint(options.model);
    // Typed AUTH error keeps "missing key" distinct from an upstream 401.
    const apiKey = openRouterApiKey();
    if (!apiKey) throw new LlmError(MISSING_KEY_MESSAGE, "AUTH");
    const client = new OpenAI({ apiKey, baseURL: endpoint.baseUrl, defaultHeaders: { ...OPENROUTER_HEADERS } });
    let parts: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      parts = await client.chat.completions.create(buildChatRequest(options, endpoint), { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: "finish", reason: { kind: "aborted", failure: { message: "aborted", code: "ABORTED" } } };
        return;
      }
      const message = error instanceof Error ? error.message : "OpenRouter request failed";
      throw new LlmError(`OpenRouter: ${message}`, "TRANSPORT", { cause: error });
    }
    yield* mapChatStream(parts, options.signal);
  }
}

export const name = "inversa-llm-openrouter";
export const inject = ["llm"];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter(["openrouter"], new OpenRouterAdapter());
}
