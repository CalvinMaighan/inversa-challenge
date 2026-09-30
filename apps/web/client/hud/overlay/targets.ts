"use client";

import { useEffect, useMemo, useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { AGENT_CHAT, type AgentChatState } from "client/state/agent";
import { parseEvidenceId, SELECTION } from "client/state/selection";

import { cellCenter, evidenceLocation, loadEvidence, parseHotspotId } from "../drawer/evidence";
import type { HudSelection } from "../selection";

/** Bracketed entities: the selection plus this many of the newest agent citations. */
export const MAX_CITATIONS = 8;

export type Target = {
  id: string;
  kind: string;
  label: string;
  lon: number;
  lat: number;
  selected: boolean;
  priority: number;
};

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

/** Location for an id without a request, when the id itself carries it (hotspot cells). */
function localLocation(id: string): Located | undefined {
  const hotspot = parseHotspotId(id);
  return hotspot ? cellCenter(hotspot.col, hotspot.row) : undefined;
}

/**
 * Entities to bracket, with positions. Hotspot ids locate themselves; other kinds load their evidence record
 * once (shared with the drawer's cache) and use its lat/lon, station, or alert area.
 */
export function useTargets(): Target[] {
  const selectedId = useActiveState<HudSelection, string | null>(SELECTION, (s) => s.evidenceId)[0] ?? null;
  const citationKey = useActiveState<AgentChatState, string>(AGENT_CHAT, (c) =>
    recentCitations(c)
      .map((x) => `${x.id}\u0001${x.label}`)
      .join("\u0002"),
  )[0] ?? "";
  const [located, setLocated] = useState<ReadonlyMap<string, Located>>(() => new Map());

  const wanted = useMemo(() => {
    const cites = citationKey ? citationKey.split("\u0002").map((row) => row.split("\u0001") as [string, string]) : [];
    const list: { id: string; label: string; selected: boolean }[] = [];
    if (selectedId && isPlaced(selectedId)) list.push({ id: selectedId, label: targetLabel(selectedId, cites.find(([id]) => id === selectedId)?.[1]), selected: true });
    for (const [id, label] of cites) if (id !== selectedId && isPlaced(id)) list.push({ id, label: targetLabel(id, label), selected: false });
    return list;
  }, [selectedId, citationKey]);

  useEffect(() => {
    let cancelled = false;
    for (const { id } of wanted) {
      if (located.has(id)) continue;
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

  return useMemo(() => {
    const out: Target[] = [];
    wanted.forEach((w, i) => {
      const loc = located.get(w.id);
      if (!loc) return;
      const parsed = parseEvidenceId(w.id);
      out.push({ ...w, kind: parsed?.kind ?? "", lon: loc.lon, lat: loc.lat, priority: w.selected ? 100 : 50 - i });
    });
    return out;
  }, [wanted, located]);
}
