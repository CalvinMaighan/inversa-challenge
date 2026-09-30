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

import { fireworksApiKey, resolveAgentEndpoint } from "@/server/agent/runtime/model";

const EFFORTS = ["off", "low", "medium", "high"] as const;

/** DeepSeek on Fireworks samples at 0.25 (deedee `fireworksChatSampling`). */
const FIREWORKS_TEMPERATURE = 0.25;

/** Agent effort id to the Fireworks `reasoning_effort` extension. */
function fireworksEffort(effort: string): "none" | "low" | "medium" | "high" {
  if (effort === "off" || effort === "none") return "none";
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return "high";
}

function textOf(blocks: readonly { type: string }[]): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Fireworks OpenAI-compatible chat completions as a dsh-llm adapter. */
export class FireworksAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "Fireworks" };
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
    const apiKey = fireworksApiKey();
    if (!apiKey) throw new LlmError("Missing FIREWORKS_API_KEY", "AUTH");
    const client = new OpenAI({ apiKey, baseURL: endpoint.baseUrl });

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
            ? [
                {
                  id: String(block.id),
                  type: "function" as const,
                  function: { name: block.name, arguments: block.arguments },
                },
              ]
            : [],
        );
        messages.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        continue;
      }
      const toolResult = message.content.find((block) => block.type === "tool-result");
      if (toolResult && toolResult.type === "tool-result") {
        messages.push({
          role: "tool",
          tool_call_id: String(toolResult.toolCallId),
          content: textOf(toolResult.content),
        });
        continue;
      }
      messages.push({ role: "user", content: textOf(message.content) });
    }

    const effort = fireworksEffort(options.reasoningEffort ? String(options.reasoningEffort) : "off");
    const stream = await client.chat.completions.create(
      {
        model: endpoint.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens ?? endpoint.maxTokens,
        temperature: options.temperature ?? FIREWORKS_TEMPERATURE,
        ...(options.stop ? { stop: options.stop } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        reasoning_effort: effort,
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & { reasoning_effort?: string },
      { signal: options.signal },
    );

    let nextIndex = 0;
    let textIndex: number | undefined;
    let text = "";
    let reasoningIndex: number | undefined;
    let reasoning = "";
    const toolBlocks = new Map<number, { index: number; id: string; name: string; arguments: string }>();
    let usage: TokenUsage | undefined;
    let finishKind: "stop" | "tool-calls" | "max-tokens" = "stop";
    const aborted: StreamChunk = {
      type: "finish",
      reason: { kind: "aborted", failure: { message: "aborted", code: "ABORTED" } },
    };

    try {
      for await (const part of stream) {
        if (options.signal?.aborted) {
          yield aborted;
          return;
        }
        const choice = part.choices[0];
        const delta = choice?.delta as
          | (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string })
          | undefined;
        if (part.usage) {
          const cached = part.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage = {
            inputTokens: Math.max(0, (part.usage.prompt_tokens ?? 0) - cached),
            outputTokens: part.usage.completion_tokens ?? 0,
            cacheReadTokens: cached,
          };
        }
        const thinking = delta?.reasoning_content ?? delta?.reasoning;
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
            block = { index: nextIndex++, id: call.id ?? `call_${key}`, name: call.function?.name ?? "", arguments: "" };
            toolBlocks.set(key, block);
            yield { type: "block-start", index: block.index, blockType: "tool-call" };
          }
          if (call.id) block.id = call.id;
          const incoming = call.function?.name;
          // Some providers resend the full name per delta, others stream fragments.
          if (incoming) {
            if (!block.name || incoming.startsWith(block.name)) block.name = incoming;
            else if (!block.name.startsWith(incoming)) block.name += incoming;
          }
          const argDelta = call.function?.arguments ?? "";
          if (argDelta) {
            block.arguments += argDelta;
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
      if (options.signal?.aborted) {
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
}

export const name = "inversa-llm-fireworks";
export const inject = ["llm"];

export function apply(ctx: Context) {
  ctx.llm.registerAdapter(["fireworks"], new FireworksAdapter());
}
