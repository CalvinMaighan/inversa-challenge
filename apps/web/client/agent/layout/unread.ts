/**
 * Unread dots on the chat column's tabs (T40). Each tab has an activity signature. The dot lights up when the
 * signature changes while the other tab is showing. The first signature a tab reports only sets the baseline:
 * loading the board, or hydrating an old thread, is not news.
 */
import type { AgentCardState, AgentTab } from "client/state/agent";

import type { AgentThread } from "../chat/thread";

/** The board fields that count as mission activity. Structural, so tests need no CRDT. */
export type BoardActivityInput = {
  missions: readonly { id: string; status: string }[];
  notes: readonly unknown[];
  /** Field notes (T43), newest first; an edit changes the text. */
  fieldNotes?: readonly { id: string; text: string }[];
  messages: readonly unknown[];
  totals: { overall: number };
};

/**
 * Board ops the team would want to see: field notes posted, edited or deleted, missions added, removed or
 * re-statused, mission notes, team chat, removals. Null before the board has loaded.
 */
export function boardActivity(board: BoardActivityInput | null | undefined): string | null {
  if (!board) return null;
  const statuses = board.missions.map((m) => `${m.id}=${m.status}`).join(",");
  const fieldNotes = (board.fieldNotes ?? []).map((n) => `${n.id}=${n.text.length}`).join(",");
  return `${board.missions.length}|${statuses}|${board.notes.length}|${board.messages.length}|${board.totals.overall}|${fieldNotes}`;
}

/** Agent activity: assistant turns that finished (typed or voice), so a voice answer landing behind Missions shows. */
export function agentActivity(thread: AgentThread): string {
  let finished = 0;
  let last = "";
  for (const m of thread.messages) {
    if (m.role === "assistant" && m.status !== "streaming") {
      finished += 1;
      last = m.id;
    }
  }
  return `${finished}|${last}`;
}

/**
 * The unread flags after `tab` reports `signature` (previous one: `previous`). The showing tab never gets a
 * dot; a changed signature on the hidden tab does.
 */
export function markActivity(state: AgentCardState, tab: AgentTab, previous: string | null, signature: string | null): AgentCardState["unread"] {
  const changed = previous !== null && signature !== null && signature !== previous;
  if (!changed || state.tab === tab || state.unread[tab]) return state.unread;
  return { ...state.unread, [tab]: true };
}

/** Switch tabs: the opened tab's dot clears. */
export function openTab(state: AgentCardState, tab: AgentTab): AgentCardState {
  return { ...state, tab, unread: { ...state.unread, [tab]: false } };
}
