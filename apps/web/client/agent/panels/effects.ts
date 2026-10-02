import { get, set } from "@calvinjs/active-state";

import { getGlobe } from "client/globe/api";
import { AGENT_HIGHLIGHT, type AgentHighlightState, type AgentHighlightTarget } from "client/state/agent";
import { TIME, type TimeState } from "client/state/time";
import type { BBox } from "shared/agent/events";

import { bboxCamera, frameInView } from "../chat/effects";
import { altitudeForBox, frameBox, highlightTargets, locateIds, primaryPanelIndex, targetFor, timeForInstant, viewTime, type Panel } from "./model";
import { panelsOf } from "./store";

/**
 * What a finished answer does to the rest of the app (PLAN.md C17): bracket its highlight ids on the globe,
 * frame its most relevant result, and move TIME so the globe's layers show that result.
 */

export type TurnFocus = { targets: AgentHighlightTarget[]; primary: number };

/** Straight-down camera over `box`, high enough for the globe's shape on screen (see altitudeForBox). */
export function frameCamera(box: BBox, viewport: { width: number; height: number } = globeSize()) {
  return { ...bboxCamera(box), altitudeM: altitudeForBox(box, viewport) };
}

/** The globe canvas's box: the pane right of the chat column (full screen on phones). */
function globeSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 16, height: 10 };
  const globe = document.querySelector("[data-globe]")?.getBoundingClientRect();
  return globe && globe.width > 0 && globe.height > 0 ? { width: globe.width, height: globe.height } : { width: window.innerWidth, height: window.innerHeight };
}

/** The turn's highlight and its most relevant panel. Pure over the panels. */
export function turnFocus(panels: readonly Panel[]): TurnFocus {
  const primary = primaryPanelIndex(panels);
  return { targets: highlightTargets(panels, primary), primary };
}

function moveTime(panel: Panel, nowMs: number): void {
  const instant = viewTime(panel.view);
  if (instant === null) return;
  set<TimeState>(TIME, (prev) => {
    const base = { ...TIME.defaults, ...prev };
    const next = timeForInstant(base, instant, nowMs);
    return next ? { ...base, ...next, playing: false } : base;
  });
}

/** Fly to a panel's area, grown to take in its highlighted entities, and move TIME to what it shows. */
export function framePanel(panel: Panel, panels: readonly Panel[], nowMs: number = Date.now()): void {
  const located = locateIds(panels);
  const box = frameBox(panel.bbox, panel.highlight.map((id) => targetFor(id, located)));
  if (box) getGlobe()?.flyTo(frameInView(box, (b) => frameCamera(b)));
  moveTime(panel, nowMs);
}

/** A turn finished: bracket its highlight, frame the primary result (and every bracket), move TIME. */
export function showTurn(turnId: string, nowMs: number = Date.now()): void {
  const panels = panelsOf(turnId);
  if (panels.length === 0) return;
  const { targets, primary } = turnFocus(panels);
  set<AgentHighlightState>(AGENT_HIGHLIGHT, { turnId, targets, hover: null });
  const main = panels[primary];
  if (!main) return;
  const box = frameBox(main.bbox, targets);
  if (box) getGlobe()?.flyTo(frameInView(box, (b) => frameCamera(b)));
  moveTime(main, nowMs);
}

/** A panel opened: re-bracket its turn (another turn's may be showing) and frame the panel. */
export function focusPanel(turnId: string, panel: Panel, nowMs: number = Date.now()): void {
  const panels = panelsOf(turnId);
  const current = get<AgentHighlightState>(AGENT_HIGHLIGHT);
  if (current?.turnId !== turnId) set<AgentHighlightState>(AGENT_HIGHLIGHT, { turnId, targets: turnFocus(panels).targets, hover: null });
  framePanel(panel, panels, nowMs);
}

/** Pointer over a row or cell: pulse that entity on the globe (null clears). */
export function hoverEvidence(turnId: string, id: string | null): void {
  set<AgentHighlightState>(AGENT_HIGHLIGHT, (prev = AGENT_HIGHLIGHT.defaults) => {
    if (!id) return prev.hover ? { ...prev, hover: null } : prev;
    if (prev.hover?.id === id) return prev;
    return { ...prev, hover: targetFor(id, locateIds(panelsOf(turnId))) };
  });
}

export function clearHighlight(): void {
  set<AgentHighlightState>(AGENT_HIGHLIGHT, AGENT_HIGHLIGHT.defaults);
}
