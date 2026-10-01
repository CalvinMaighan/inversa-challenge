import type { AgentChatMessage, AgentChatState } from "client/state/agent";
import type { AgentStreamEvent } from "shared/agent/events";

/**
 * The card's transcript model and reducer (deedee `useDeedeeChat` message model, reduced to what this agent
 * streams). Pure: every action carries its own clock, so a scripted event sequence replays exactly.
 *
 * Turns extend the AGENT_CHAT message shape, so the key stays the single store for the transcript.
 */

/** Transcript cap: older turns drop off the top. */
export const MAX_TURNS = 50;

export type ToolRowState = "running" | "ok" | "error";

export type AgentToolRow = {
  toolCallId: string;
  capabilityName: string;
  state: ToolRowState;
  args?: unknown;
  /** Rows the tool returned (`tool_end.data.count`). */
  count?: number;
  /** Evidence ids the tool returned. */
  evidence?: number;
  error?: string;
};

export type AgentTurnPhase = "thinking" | "reading" | "generating";

export type AgentTurn = AgentChatMessage & {
  /** Set on turns that came from a voice-spawned task. */
  source?: "voice";
  /** Voice task id, for the task objective in the header. */
  taskId?: string;
  /** Last `status` while streaming. */
  phase?: AgentTurnPhase;
  reasoning?: string;
  reasoningStartedAtMs?: number;
  reasoningEndedAtMs?: number;
  tools?: AgentToolRow[];
  errors?: string[];
  /** Turn clock for "Working for" / "Worked for". */
  startedAtMs?: number;
  endedAtMs?: number;
  /** Set when the user pressed stop. */
  stopped?: boolean;
};

export type AgentThread = Omit<AgentChatState, "messages"> & { messages: AgentTurn[] };

/**
 * Reasoning as plain text: the model's thinking arrives with markdown headings and bold ("**Looking into CRW
 * locations**"), and the block renders it as text, so the markers are dropped rather than shown.
 */
export function plainReasoning(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1$2");
}

export type ThreadAction =
  | { type: "session"; sessionId: string }
  | { type: "user"; id: string; text: string; nowMs: number }
  | { type: "assistant"; id: string; nowMs: number }
  | { type: "events"; id: string; events: readonly AgentStreamEvent[]; nowMs: number; voiceTaskId?: string }
  | { type: "stop"; id: string; nowMs: number }
  | { type: "fail"; id: string; message: string; nowMs: number }
  | { type: "clear" };

export const EMPTY_THREAD: AgentThread = Object.freeze({ sessionId: null, messages: [] }) as AgentThread;

/** Message id for a voice task's turn. */
export function voiceTurnId(taskId: string): string {
  return `voice-${taskId}`;
}

const iso = (ms: number) => new Date(ms).toISOString();

function assistantTurn(id: string, nowMs: number): AgentTurn {
  return { id, role: "assistant", text: "", citations: [], status: "streaming", at: iso(nowMs), startedAtMs: nowMs };
}

function capped(messages: AgentTurn[]): AgentTurn[] {
  return messages.length > MAX_TURNS ? messages.slice(-MAX_TURNS) : messages;
}

function endReasoning(turn: AgentTurn, nowMs: number): AgentTurn {
  return turn.reasoning && turn.reasoningEndedAtMs === undefined ? { ...turn, reasoningEndedAtMs: nowMs } : turn;
}

function toolData(data: unknown): { count?: number; evidence?: number } {
  if (!data || typeof data !== "object") return {};
  const row = data as { count?: unknown; evidence?: unknown };
  return {
    count: typeof row.count === "number" ? row.count : undefined,
    evidence: Array.isArray(row.evidence) ? row.evidence.length : undefined,
  };
}

/** Apply one C7 event to an assistant turn. */
export function applyAgentEvent(turn: AgentTurn, event: AgentStreamEvent, nowMs: number): AgentTurn {
  switch (event.type) {
    case "status":
      return { ...turn, phase: event.state };
    case "reasoning_delta":
      if (!event.text) return turn;
      return {
        ...turn,
        reasoning: (turn.reasoning ?? "") + event.text,
        reasoningStartedAtMs: turn.reasoningStartedAtMs ?? nowMs,
        reasoningEndedAtMs: undefined,
      };
    case "content_delta":
      if (!event.text) return turn;
      return { ...endReasoning(turn, nowMs), text: turn.text + event.text };
    case "tool_start": {
      // Narration before a tool call is scaffolding; the answer after the last tool is what stays (deedee).
      const row: AgentToolRow = { toolCallId: event.toolCallId, capabilityName: event.capabilityName, state: "running", args: event.args };
      const tools = (turn.tools ?? []).filter((t) => t.toolCallId !== event.toolCallId);
      return { ...endReasoning(turn, nowMs), text: "", tools: [...tools, row] };
    }
    case "tool_end": {
      const tools = turn.tools ?? [];
      const done: Partial<AgentToolRow> = {
        state: event.ok ? "ok" : "error",
        error: event.ok ? undefined : (event.error ?? "tool failed"),
        ...(event.ok ? toolData(event.data) : {}),
      };
      const known = tools.some((t) => t.toolCallId === event.toolCallId);
      return {
        ...turn,
        tools: known
          ? tools.map((t) => (t.toolCallId === event.toolCallId ? { ...t, ...done } : t))
          : [...tools, { toolCallId: event.toolCallId, capabilityName: event.capabilityName, state: "ok", ...done }],
      };
    }
    case "citation":
      if (turn.citations.some((c) => c.id === event.id)) return turn;
      return { ...turn, citations: [...turn.citations, { id: event.id, kind: event.kind, label: event.label }] };
    case "error":
      return { ...turn, errors: [...(turn.errors ?? []), event.message] };
    case "done": {
      const settled = endReasoning(turn, nowMs);
      return {
        ...settled,
        text: event.content || settled.text,
        status: settled.errors?.length ? "error" : "done",
        phase: undefined,
        endedAtMs: nowMs,
        // A tool still "running" at done never reported back.
        tools: settled.tools?.map((t) => (t.state === "running" ? { ...t, state: "error", error: t.error ?? "no result" } : t)),
      };
    }
    case "view":
    case "ui":
    case "context":
    case "debug":
      return turn;
  }
}

function updateTurn(state: AgentThread, id: string, fn: (turn: AgentTurn) => AgentTurn): AgentThread {
  const index = state.messages.findIndex((m) => m.id === id);
  if (index < 0) return state;
  const messages = state.messages.slice();
  messages[index] = fn(messages[index]!);
  return { ...state, messages };
}

export function reduceThread(state: AgentThread, action: ThreadAction): AgentThread {
  switch (action.type) {
    case "session":
      return { ...state, sessionId: action.sessionId };
    case "user":
      return {
        ...state,
        messages: capped([
          ...state.messages,
          { id: action.id, role: "user", text: action.text, citations: [], status: "done", at: iso(action.nowMs) },
        ]),
      };
    case "assistant":
      return { ...state, messages: capped([...state.messages, assistantTurn(action.id, action.nowMs)]) };
    case "events": {
      let next = state;
      if (!next.messages.some((m) => m.id === action.id)) {
        // First event of a voice task: its turn starts here.
        const turn: AgentTurn = { ...assistantTurn(action.id, action.nowMs), source: action.voiceTaskId ? "voice" : undefined, taskId: action.voiceTaskId };
        next = { ...next, messages: capped([...next.messages, turn]) };
      }
      return updateTurn(next, action.id, (turn) =>
        turn.status === "streaming" ? action.events.reduce((t, event) => applyAgentEvent(t, event, action.nowMs), turn) : turn,
      );
    }
    case "stop":
      return updateTurn(state, action.id, (turn) =>
        turn.status === "streaming"
          ? {
              ...endReasoning(turn, action.nowMs),
              status: "done",
              stopped: true,
              phase: undefined,
              endedAtMs: action.nowMs,
              tools: turn.tools?.map((t) => (t.state === "running" ? { ...t, state: "error", error: "stopped" } : t)),
            }
          : turn,
      );
    case "fail":
      return updateTurn(state, action.id, (turn) => ({
        ...endReasoning(turn, action.nowMs),
        status: "error",
        phase: undefined,
        errors: [...(turn.errors ?? []), action.message],
        endedAtMs: action.nowMs,
        tools: turn.tools?.map((t) => (t.state === "running" ? { ...t, state: "error", error: action.message } : t)),
      }));
    case "clear":
      // A new server session too, or the next question would still carry the old transcript.
      return { ...state, sessionId: null, messages: [] };
  }
}

/** Store value → thread, tolerating a key that was never set. */
export function asThread(value: AgentThread | undefined): AgentThread {
  return value && Array.isArray(value.messages) ? value : EMPTY_THREAD;
}

/** True while a typed (not voice) turn is still streaming. */
export function isAsking(thread: AgentThread): boolean {
  return thread.messages.some((m) => m.role === "assistant" && m.status === "streaming" && m.source !== "voice");
}

/** True while any assistant turn, typed or voice, is still streaming. */
export function isWorking(thread: AgentThread): boolean {
  return thread.messages.some((m) => m.role === "assistant" && m.status === "streaming");
}
