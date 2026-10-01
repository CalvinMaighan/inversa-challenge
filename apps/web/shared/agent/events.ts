/**
 * Agent NDJSON stream contract (PLAN.md C7). One JSON object per line from
 * POST /api/agent/stream. Mirrors deedee's DeedeeChatStreamEvent, plus `view`
 * (drive the globe and timeline) and `citation` (a verified evidence id).
 */

import type { AppId } from "../apps/schema";

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
  | ({ type: "view"; bbox: BBox; time: string } & CarpViewState)
  | { type: "citation"; id: string; kind: EvidenceKind; label: string }
  | { type: "done"; content: string }
  | { type: "error"; message: string }
  /** Grounding notices, e.g. an unverified citation was stripped. */
  | { type: "debug"; text: string };

/**
 * Carp view state (shared contract with the carp UI, leaf UC): `site` selects an NWPS lid, `asOf` is the
 * knowledge time in unix ms (absent = live), `replay` switches the timeline to knowledge time.
 */
export type CarpViewState = { site?: string; asOf?: number; replay?: boolean };

/**
 * Evidence ids are `<kind>:<key>` (PLAN.md C14). `note:<id>` is a team field note on the CRDT board (T43);
 * `forecast:<lid>:<issued ms>` an NWPS/IEM forecast issuance; `source:<feed>` a feed's static facts;
 * `mission:<id>` and `message:<id>` the team board's records.
 */
export type EvidenceKind = "sighting" | "reading" | "alert" | "fetch" | "hotspot" | "backtest" | "note" | "forecast" | "source" | "mission" | "message";
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["sighting", "reading", "alert", "fetch", "hotspot", "backtest", "note", "forecast", "source", "mission", "message"];

export type AgentStreamRequest = {
  /** The app the question is asked in (C-A5): persona, tools, scope guard and API prefix. */
  app: AppId;
  sessionId: string;
  question: string;
  /**
   * `species`: the globe's species filter keys still shown, sent only when the filter hides an animal.
   * `windowHours`: the trailing sightings window the globe draws (48, 168 or 720; T44).
   */
  view?: { bbox: BBox; time: string; layers: string[]; species?: string[]; windowHours?: number; selection: string | null } & CarpViewState;
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
