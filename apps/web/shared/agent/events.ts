/**
 * Agent NDJSON stream contract (PLAN.md C7). One JSON object per line from
 * POST /api/agent/stream. Mirrors deedee's DeedeeChatStreamEvent, plus `view`
 * (drive the globe and timeline) and `citation` (a verified evidence id).
 */

export type BBox = { west: number; south: number; east: number; north: number };

export type AgentStreamEvent =
  | { type: "status"; state: "thinking" | "reading" | "generating" }
  | { type: "reasoning_delta"; text: string }
  | { type: "content_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; capabilityName: string; args?: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      capabilityName: string;
      ok: boolean;
      /** Compact result for UI rows: evidence ids, counts, feed states. */
      data?: unknown;
      error?: string;
    }
  | { type: "context"; windowTokens: number; segments: { label: string; tokens: number }[] }
  | { type: "view"; bbox: BBox; time: string }
  | { type: "citation"; id: string; kind: EvidenceKind; label: string }
  | { type: "done"; content: string }
  | { type: "error"; message: string }
  /** Grounding notices, e.g. an unverified citation was stripped. */
  | { type: "debug"; text: string };

/** Evidence ids are `<kind>:<key>` (PLAN.md C14). */
export type EvidenceKind = "sighting" | "reading" | "alert" | "fetch" | "hotspot" | "backtest";

export type AgentStreamRequest = {
  sessionId: string;
  question: string;
  view?: { bbox: BBox; time: string; layers: string[]; selection: string | null };
};

export const AGENT_STREAM_CONTENT_TYPE = "application/x-ndjson";

const EVENT_TYPES = new Set<AgentStreamEvent["type"]>([
  "status",
  "reasoning_delta",
  "content_delta",
  "tool_start",
  "tool_end",
  "context",
  "view",
  "citation",
  "done",
  "error",
  "debug",
]);

export function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  if (!value || typeof value !== "object") return false;
  return EVENT_TYPES.has((value as { type?: unknown }).type as AgentStreamEvent["type"]);
}
