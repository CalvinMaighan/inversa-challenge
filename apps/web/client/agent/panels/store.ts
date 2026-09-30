"use client";

import { useSyncExternalStore } from "react";

import type { AgentStreamEvent } from "shared/agent/events";

import { MAX_TURNS } from "../chat/thread";
import { panelsFromToolEnd, type Panel } from "./model";

/**
 * Result panels per assistant turn. Kept out of AGENT_CHAT on purpose: a table view can carry hundreds of rows,
 * and AGENT_CHAT is written every animation frame while an answer streams and mirrored to the workers. Only the
 * small highlight list goes through the state bus (AGENT_HIGHLIGHT).
 */

const EMPTY: readonly Panel[] = Object.freeze([]);
const turns = new Map<string, readonly Panel[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Add the panels of one `tool_end` to its turn. Returns true when it carried any. */
export function recordToolEnd(turnId: string, event: AgentStreamEvent): boolean {
  if (event.type !== "tool_end" || !event.ok) return false;
  const added = panelsFromToolEnd(event.toolCallId, event.capabilityName, event.data);
  if (added.length === 0) return false;
  const prev = turns.get(turnId) ?? EMPTY;
  turns.delete(turnId);
  turns.set(turnId, [...prev.filter((p) => p.toolCallId !== event.toolCallId), ...added]);
  while (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value!);
  emit();
  return true;
}

/** Panels of a turn in tool-call order; the same array until the turn changes. */
export function panelsOf(turnId: string): readonly Panel[] {
  return turns.get(turnId) ?? EMPTY;
}

export function clearPanels(): void {
  if (turns.size === 0) return;
  turns.clear();
  emit();
}

export function subscribePanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTurnPanels(turnId: string): readonly Panel[] {
  return useSyncExternalStore(
    subscribePanels,
    () => panelsOf(turnId),
    () => EMPTY,
  );
}
