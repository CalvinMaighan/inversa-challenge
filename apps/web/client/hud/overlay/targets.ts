"use client";

import { useEffect, useMemo, useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { get } from "@calvinjs/active-state";

import { AGENT_CHAT, AGENT_HIGHLIGHT, type AgentChatState, type AgentHighlightState, type AgentHighlightTarget } from "client/state/agent";
import { NOTES, type NotesState } from "client/state/notes";
import { parseEvidenceId, SELECTION } from "client/state/selection";

import { cellCenter, evidenceLocation, loadEvidence, parseHotspotId } from "../drawer/evidence";
import type { HudSelection } from "../selection";

/** Bracketed entities: the selection plus this many of the newest agent citations. */
export const MAX_CITATIONS = 8;
/** Plus up to this many ids the latest agent answer highlighted (PLAN.md C17). */
export const MAX_HIGHLIGHT = 50;

export type Target = {
  id: string;
  kind: string;
  label: string;
  lon: number;
  lat: number;
  selected: boolean;
  priority: number;
  /** One of the newest agent citations. */
  cited?: boolean;
  /** In the latest agent answer's highlight (PLAN.md C17), whatever else it is. */
  highlight?: boolean;
  /** Under the pointer in a data panel: the overlay pulses it. */
  hovered?: boolean;
};

export type WantedTarget = {
  id: string;
  label: string;
  selected: boolean;
  cited: boolean;
  highlight: boolean;
  hovered: boolean;
  /** Position the agent result carried, so no evidence request is needed. */
  at?: { lon: number; lat: number };
};

const knownAt = (t: AgentHighlightTarget) =>
  t.lon !== undefined && t.lat !== undefined && Number.isFinite(t.lon) && Number.isFinite(t.lat) ? { lon: t.lon, lat: t.lat } : undefined;

/**
 * Everything to bracket, in priority order: the selection, recent citations, then the agent answer's highlight
 * (capped at MAX_HIGHLIGHT) and the panel row under the pointer. Each id appears once with its strongest role
 * for drawing; `highlight` marks every id of the answer's highlight, cited or selected ones included.
 */
export function wantedTargets(
  selectedId: string | null,
  cites: readonly [id: string, label: string][],
  highlight: Pick<AgentHighlightState, "targets" | "hover"> | undefined,
): WantedTarget[] {
  const list: WantedTarget[] = [];
  const seen = new Set<string>();
  const hover = highlight?.hover ?? null;
  const shown = (highlight?.targets ?? []).slice(0, MAX_HIGHLIGHT);
  const byId = new Map(shown.map((t) => [t.id, t]));
  if (hover && !byId.has(hover.id)) byId.set(hover.id, hover);
  const push = (id: string, label: string, role: "selected" | "cited" | "highlight") => {
    if (seen.has(id) || !isPlaced(id)) return;
    seen.add(id);
    const agent = byId.get(id);
    const known = agent ? knownAt(agent) : undefined;
    list.push({
      id,
      label,
      selected: role === "selected",
      cited: role === "cited",
      highlight: agent !== undefined,
      hovered: id === hover?.id,
      ...(known ? { at: known } : {}),
    });
  };
  const agentLabel = (id: string) => byId.get(id)?.label || undefined;
  if (selectedId) push(selectedId, targetLabel(selectedId, cites.find(([id]) => id === selectedId)?.[1] || agentLabel(selectedId)), "selected");
  for (const [id, label] of cites) push(id, targetLabel(id, label), "cited");
  for (const t of shown) push(t.id, targetLabel(t.id, t.label || undefined), "highlight");
  if (hover) push(hover.id, targetLabel(hover.id, hover.label || undefined), "highlight");
  return list;
}

/** Newest-first unique citation ids across the chat, newest message first. */
export function recentCitations(chat: AgentChatState | undefined, limit = MAX_CITATIONS): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const messages = chat?.messages ?? [];
  for (let m = messages.length - 1; m >= 0 && out.length < limit; m--) {
    const cites = messages[m]!.citations ?? [];
    for (let c = cites.length - 1; c >= 0 && out.length < limit; c--) {
      const cite = cites[c]!;
      if (seen.has(cite.id) || !parseEvidenceId(cite.id)) continue;
      seen.add(cite.id);
      out.push({ id: cite.id, label: cite.label });
    }
  }
  return out;
}

/** Short bracket label: `SIGHTING 48213`, `HOTSPOT PYTHON 120:88`. */
export function targetLabel(id: string, citationLabel?: string): string {
  const parsed = parseEvidenceId(id);
  if (!parsed) return id;
  const kind = parsed.kind.toUpperCase();
  if (citationLabel) return `${kind} ${citationLabel}`.slice(0, 34);
  const hotspot = parseHotspotId(id);
  if (hotspot) return `${kind} ${hotspot.species.toUpperCase()} ${hotspot.cell}`;
  const tail = parsed.key.length > 14 ? `…${parsed.key.slice(-13)}` : parsed.key;
  return `${kind} ${tail}`;
}

type Located = { lon: number; lat: number } | null;

/** Fetch runs and backtests have no place on the globe; skip them instead of loading their evidence for nothing. */
function isPlaced(id: string): boolean {
  const kind = parseEvidenceId(id)?.kind;
  return kind !== undefined && kind !== "fetch" && kind !== "backtest";
}

/** Location for an id without a request: hotspot cells carry it, field notes are on the board (NOTES.pins). */
function localLocation(id: string): Located | undefined {
  const hotspot = parseHotspotId(id);
  if (hotspot) return cellCenter(hotspot.col, hotspot.row);
  const parsed = parseEvidenceId(id);
  if (parsed?.kind !== "note") return undefined;
  const pin = get<NotesState>(NOTES)?.pins.find((p) => p.id === parsed.key);
  return pin ? { lon: pin.lon, lat: pin.lat } : null;
}

/**
 * Entities to bracket, with positions. Hotspot ids locate themselves; other kinds load their evidence record
 * once (shared with the drawer's cache) and use its lat/lon, station, or alert area.
 */
/** Selection over the hovered row over citations over the answer's highlight, which keeps its relevance order. */
export function targetPriority(w: Pick<WantedTarget, "selected" | "hovered" | "cited">, index: number): number {
  if (w.selected) return 100;
  if (w.hovered) return 90;
  if (w.cited) return 50 - index;
  return 30 - index / 100;
}

/** Wanted targets with a position (carried, or looked up into `located`), ready to draw. */
export function placeTargets(wanted: readonly WantedTarget[], located: ReadonlyMap<string, Located>): Target[] {
  const out: Target[] = [];
  wanted.forEach((w, i) => {
    const loc = w.at ?? located.get(w.id);
    if (!loc) return;
    const parsed = parseEvidenceId(w.id);
    out.push({
      id: w.id,
      label: w.label,
      selected: w.selected,
      cited: w.cited,
      highlight: w.highlight,
      hovered: w.hovered,
      kind: parsed?.kind ?? "",
      lon: loc.lon,
      lat: loc.lat,
      priority: targetPriority(w, i),
    });
  });
  return out;
}

export function useTargets(): Target[] {
  const selectedId = useActiveState<HudSelection, string | null>(SELECTION, (s) => s.evidenceId)[0] ?? null;
  const citationKey = useActiveState<AgentChatState, string>(AGENT_CHAT, (c) =>
    recentCitations(c)
      .map((x) => `${x.id}\u0001${x.label}`)
      .join("\u0002"),
  )[0] ?? "";
  const highlight = useActiveState<AgentHighlightState>(AGENT_HIGHLIGHT)[0];
  const [located, setLocated] = useState<ReadonlyMap<string, Located>>(() => new Map());

  const wanted = useMemo(() => {
    const cites = citationKey ? citationKey.split("\u0002").map((row) => row.split("\u0001") as [string, string]) : [];
    return wantedTargets(selectedId, cites, highlight);
  }, [selectedId, citationKey, highlight]);

  useEffect(() => {
    let cancelled = false;
    for (const { id, at } of wanted) {
      if (at || located.has(id)) continue;
      const local = localLocation(id);
      const done = (loc: Located) => {
        if (!cancelled) setLocated((prev) => (prev.has(id) ? prev : new Map(prev).set(id, loc)));
      };
      if (local !== undefined) {
        queueMicrotask(() => done(local));
        continue;
      }
      loadEvidence(id)
        .then((e) => done(evidenceLocation(e.record)))
        .catch(() => done(null));
    }
    return () => {
      cancelled = true;
    };
  }, [wanted, located]);

  return useMemo(() => placeTargets(wanted, located), [wanted, located]);
}
