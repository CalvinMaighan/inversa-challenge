import type { Agent } from "@deepseek-ai/dsh-agent";
import type { StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

import type { AgentToolDetails, EvidenceLedger } from "@/server/agent/cordis/capability-tools";
import { CitationFilter, filterCitations } from "@/server/agent/cordis/citations";
import { createThinkingPartition, partitionThinking } from "@/server/agent/cordis/thinking";
import type { AgentStreamEvent, EvidenceKind } from "@/shared/agent/events";

export type TurnUsage = { promptTokens: number; completionTokens: number; cacheRead: number };
export type ToolCallRecord = { capabilityName: string; ok: boolean; durationMs: number };

export type StreamBridge = {
  usage: TurnUsage;
  toolCalls: ToolCallRecord[];
  readonly finishError: string | undefined;
  /** True once any answer text reached the client. */
  readonly streamedContent: boolean;
  /** Verified citation ids, in first-cited order. */
  citations(): string[];
  /** Final answer: last assistant message with unverified markers removed. */
  finalText(): string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The model sends arguments as a JSON string; the UI gets an object when it parses. */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Harness session events to C7 NDJSON events. Content runs through the
 * think-tag splitter, then the citation filter, so the client never sees a
 * marker for evidence that no tool returned in this turn.
 */
export function attachStreamBridge(
  agent: Agent,
  ledger: EvidenceLedger,
  onEvent: (event: AgentStreamEvent) => void,
): StreamBridge {
  const usage: TurnUsage = { promptTokens: 0, completionTokens: 0, cacheRead: 0 };
  const toolCalls: ToolCallRecord[] = [];
  const toolStarted = new Map<string, number>();
  const toolNames = new Map<string, string>();
  const cited: string[] = [];
  const removed = new Set<string>();
  let text = "";
  let finishError: string | undefined;
  let generating = false;
  let thinking = createThinkingPartition();

  const citations = new CitationFilter({
    isVerified: (id) => ledger.get(id) !== undefined,
    onVerified(id) {
      if (cited.includes(id)) return;
      cited.push(id);
      const row = ledger.get(id)!;
      // C7's EvidenceKind predates the accepted `backtest` kind; the value is a valid C14 kind either way.
      onEvent({ type: "citation", id, kind: row.kind as EvidenceKind, label: row.label });
    },
    onUnverified(id) {
      if (removed.has(id)) return;
      removed.add(id);
      onEvent({ type: "debug", text: `unverified citation removed: ${id}` });
    },
  });

  const emitContent = (delta: string) => {
    const safe = citations.push(delta);
    if (!safe) return;
    if (!generating) {
      generating = true;
      onEvent({ type: "status", state: "generating" });
    }
    text += safe;
    onEvent({ type: "content_delta", text: safe });
  };

  const flushMessage = () => {
    const tail = thinking.pending;
    const phase = thinking.phase;
    thinking = createThinkingPartition();
    if (tail) {
      if (phase === "inside") onEvent({ type: "reasoning_delta", text: tail });
      else emitContent(tail);
    }
    const held = citations.flush();
    if (held) {
      text += held;
      onEvent({ type: "content_delta", text: held });
    }
  };

  const addUsage = (reported?: TokenUsage) => {
    if (!reported) return;
    usage.promptTokens += reported.inputTokens ?? 0;
    usage.completionTokens += reported.outputTokens ?? 0;
    usage.cacheRead += reported.cacheReadTokens ?? 0;
  };

  const fail = (message: string) => {
    finishError = message;
    onEvent({ type: "error", message });
  };

  const onChunk = (chunk: StreamChunk) => {
    if (chunk.type === "text-delta") {
      const split = partitionThinking(thinking, chunk.text);
      if (split.reasoningDelta) onEvent({ type: "reasoning_delta", text: split.reasoningDelta });
      if (split.contentDelta) emitContent(split.contentDelta);
      return;
    }
    if (chunk.type === "reasoning-delta") {
      onEvent({ type: "reasoning_delta", text: chunk.text });
      return;
    }
    if (chunk.type === "finish" && chunk.reason.kind === "error") {
      fail(chunk.reason.failure.message?.trim() || "Agent turn failed");
    }
    if (chunk.type === "finish" && chunk.reason.kind === "max-tokens") {
      fail("Reply hit the length limit before it finished. Ask to continue.");
    }
  };

  const onSessionEvent = (_session: Session, event: SessionEvent) => {
    if (event.type === "turn/start") {
      onEvent({ type: "status", state: "thinking" });
      return;
    }
    if (event.type === "assistant/chunk") {
      onChunk(event.data.chunk);
      return;
    }
    if (event.type === "assistant/message") {
      flushMessage();
      addUsage(event.data.usage);
      return;
    }
    if (event.type === "tool/call") {
      const capabilityName = event.data.name;
      const callId = String(event.data.callId);
      toolStarted.set(callId, Date.now());
      toolNames.set(callId, capabilityName);
      generating = false;
      onEvent({ type: "status", state: "reading" });
      onEvent({ type: "tool_start", toolCallId: callId, capabilityName, args: parseArgs(event.data.arguments) });
      return;
    }
    if (event.type === "tool/result") {
      const callId = String(event.data.message.source.callId);
      const details = isRecord(event.data.meta) ? (event.data.meta as AgentToolDetails) : undefined;
      const name = details?.capabilityName ?? toolNames.get(callId) ?? "unknown";
      const first = event.data.message.content[0];
      const ok = !first?.isError && details?.ok !== false;
      // Denied calls (tool limit) carry no details, only the denial text.
      const deniedText =
        first?.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("")
          .trim() || undefined;
      toolCalls.push({ capabilityName: name, ok, durationMs: Date.now() - (toolStarted.get(callId) ?? Date.now()) });
      onEvent({
        type: "tool_end",
        toolCallId: callId,
        capabilityName: name,
        ok,
        data: ok ? details?.data : undefined,
        error: ok ? undefined : (details?.error ?? deniedText ?? "tool failed"),
      });
    }
  };

  agent.ctx.on("session/event", onSessionEvent);
  agent.ctx.on("agent/error", (payload: { error?: unknown }) => {
    const thrown = payload.error;
    fail(thrown instanceof Error ? thrown.message : typeof thrown === "string" ? thrown : "Agent turn failed");
  });

  return {
    usage,
    toolCalls,
    get finishError() {
      return finishError;
    },
    get streamedContent() {
      return text.trim().length > 0;
    },
    citations: () => [...cited],
    finalText() {
      const last = [...agent.session.events].reverse().find((event) => event.type === "assistant/message");
      const assembled =
        last?.type === "assistant/message"
          ? last.data.message.content
              .filter((block): block is { type: "text"; text: string } => block.type === "text")
              .map((block) => block.text)
              .join("\n")
          : "";
      const visible = assembled.replace(/<(think|redacted_thinking)>[\s\S]*?<\/\1>/gi, "").trim();
      if (visible) return filterCitations(visible, (id) => ledger.get(id) !== undefined).text.trim();
      return text.trim();
    },
  };
}
