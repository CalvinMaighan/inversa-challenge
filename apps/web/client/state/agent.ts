import { key } from "@calvinjs/active-state";

import type { EvidenceKind } from "shared/agent/events";

/** Chat column tabs (PRD §12 "Layout"): the agent thread, or the team board (shown as "Missions"). */
export const AGENT_TABS = ["agent", "board"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** Phone bottom-sheet snap points, lowest first. Desktop ignores it: the column is always fully open. */
export const SHEET_SNAPS = ["collapsed", "half", "full"] as const;
export type SheetSnap = (typeof SHEET_SNAPS)[number];

/** The chat column's UI state. The key keeps its PLAN.md name from the orb era (T14); T40 made it the column. */
export type AgentCardState = {
  /** Tab the column shows. */
  tab: AgentTab;
  /** Phone sheet height. */
  sheet: SheetSnap;
  /** Activity arrived on a tab while the other one was showing; cleared when that tab opens. */
  unread: Record<AgentTab, boolean>;
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

const cardDefaults: AgentCardState = { tab: "agent", sheet: "collapsed", unread: { agent: false, board: false } };
const chatDefaults: AgentChatState = { sessionId: null, messages: [] };
const highlightDefaults: AgentHighlightState = { turnId: null, targets: [], hover: null };

export const AGENT_CARD = key("AGENT_CARD", cardDefaults);
export const AGENT_CHAT = key("AGENT_CHAT", chatDefaults);
export const AGENT_HIGHLIGHT = key("AGENT_HIGHLIGHT", highlightDefaults);
