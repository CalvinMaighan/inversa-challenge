import { key } from "@calvinjs/active-state";

import type { EvidenceKind } from "shared/agent/events";

/** Viewport rect, CSS pixels, as `getBoundingClientRect` reports it. */
export type AnchorRect = { x: number; y: number; width: number; height: number };

export type AgentCardState = {
  /** Orb morphed into the chat card. */
  open: boolean;
  /** Orb rect the card morphs from and collapses back to; null until the orb has measured itself. */
  anchor: AnchorRect | null;
};

export type AgentCitation = { id: string; kind: EvidenceKind; label: string };

export type AgentChatMessage = {
  id: string;
  role: "user" | "assistant";
  /** Markdown; grows while `status` is "streaming". */
  text: string;
  citations: AgentCitation[];
  status: "streaming" | "done" | "error";
  /** RFC 3339. */
  at: string;
};

export type AgentChatState = {
  /** Agent session id, created on the first question. */
  sessionId: string | null;
  messages: AgentChatMessage[];
};

/** One entity an agent answer points at (PLAN.md C17 `highlight`), with its position when the result carried it. */
export type AgentHighlightTarget = { id: string; label: string; lon?: number; lat?: number };

export type AgentHighlightState = {
  /** Assistant turn the highlight came from, or null when nothing is highlighted. */
  turnId: string | null;
  /** Evidence ids to bracket on the globe, capped at 50, most relevant first. */
  targets: AgentHighlightTarget[];
  /** Id under the pointer in a data panel; the globe pulses it. */
  hover: AgentHighlightTarget | null;
};

const cardDefaults: AgentCardState = { open: false, anchor: null };
const chatDefaults: AgentChatState = { sessionId: null, messages: [] };
const highlightDefaults: AgentHighlightState = { turnId: null, targets: [], hover: null };

export const AGENT_CARD = key("AGENT_CARD", cardDefaults);
export const AGENT_CHAT = key("AGENT_CHAT", chatDefaults);
export const AGENT_HIGHLIGHT = key("AGENT_HIGHLIGHT", highlightDefaults);
