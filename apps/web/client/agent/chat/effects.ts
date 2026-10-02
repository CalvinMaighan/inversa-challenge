import { set } from "@calvinjs/active-state";

import { getGlobe, type CameraTarget } from "client/globe/api";
import { fitInPane } from "client/globe/fit";
import { SELECTION, type SelectionState, parseEvidenceId } from "client/state/selection";
import { TIME, retime, type TimeState } from "client/state/time";
import { activeApp } from "client/state/app";
import { applyCarpView } from "client/state/carp";
import { altitudeToFit } from "client/state/view";
import { applyUiEvent } from "client/voice/ui-command-handler";
import type { AgentStreamEvent, BBox } from "shared/agent/events";
import { cellCentre, primaryRegion } from "shared/apps";

/** Side effects of agent output on the rest of the app: camera, timeline, selection. */
/** Camera height when flying to one cited entity. */
export const EVIDENCE_ALTITUDE_M = 12_000;

/**
 * Coordinates an evidence id carries by itself. Only hotspot ids do (`hotspot:<species>:<col>:<row>:<ms>`,
 * the cell centre); sightings, readings, alerts and fetch runs need a lookup, so they return null.
 */
export function evidenceCoordinates(id: string): { lon: number; lat: number } | null {
  const parsed = parseEvidenceId(id);
  if (!parsed || parsed.kind !== "hotspot") return null;
  const parts = parsed.key.split(":");
  if (parts.length !== 4) return null;
  const col = Number(parts[1]);
  const row = Number(parts[2]);
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) return null;
  // PLAN.md C14: cells counted from the app's (first) region's south-west corner, at its cell size.
  const centre = cellCentre(primaryRegion(activeApp()), `${col}:${row}`);
  return centre ? { lon: round6(centre.lon), lat: round6(centre.lat) } : null;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Room around a framed box for the markers and labels at its edge. */
export const FRAME_INSET_PX = 24;

/**
 * The agent's framing of a box: inside the part of the globe the user sees (clear of the cards, inside the stage
 * circle, client/globe/fit.ts); `fallback` before the pane is laid out (and in tests without a DOM).
 */
export function frameInView(bbox: BBox, fallback: (bbox: BBox) => CameraTarget = bboxCamera): CameraTarget {
  return fitInPane(bbox, FRAME_INSET_PX) ?? fallback(bbox);
}

/** Camera that frames `bbox` from straight above. */
export function bboxCamera(bbox: BBox): CameraTarget {
  return {
    lon: round6((bbox.west + bbox.east) / 2),
    lat: round6((bbox.south + bbox.north) / 2),
    altitudeM: altitudeToFit(bbox),
    heading: 0,
    pitch: -90,
  };
}

/**
 * `view` event: fly the globe to the box and move the timeline to the answer's time. A time outside the replay
 * window moves the window (`retime`), so an answer about last February shows last February's frames.
 */
export function applyViewEvent(event: Extract<AgentStreamEvent, { type: "view" }>, nowMs = Date.now()): void {
  getGlobe()?.flyTo(frameInView(event.bbox));
  applyCarpViewEvent(event, nowMs);
  const atMs = Date.parse(event.time);
  if (!Number.isFinite(atMs)) return;
  set<TimeState>(TIME, (prev) => {
    const base = { ...TIME.defaults, ...prev };
    return { ...base, ...retime(base, atMs, nowMs), playing: false };
  });
}

/**
 * The carp fields of a `view` event (leaf UC / AG1 contract): `site?: string` (NWPS lid), `asOf?: number` (unix ms;
 * absent = live), `replay?: boolean`. Applied in a conditions app when the event carries any of them; then a
 * missing `asOf` means live. Read structurally, so the event type can gain the fields without this file changing.
 */
export function applyCarpViewEvent(event: object, nowMs = Date.now()): boolean {
  if (activeApp().kind !== "conditions") return false;
  const { site, asOf, replay } = event as { site?: unknown; asOf?: unknown; replay?: unknown };
  if (site === undefined && asOf === undefined && replay === undefined) return false;
  applyCarpView(
    {
      site: typeof site === "string" ? site : site === null ? null : undefined,
      asOf: typeof asOf === "number" && Number.isFinite(asOf) ? asOf : null,
      replay: replay === true,
    },
    nowMs,
  );
  return true;
}

/** Citation chip: select the evidence, open the drawer, and fly there when the id carries coordinates. */
export function openEvidence(id: string): void {
  set<SelectionState>(SELECTION, (prev) => ({ ...SELECTION.defaults, ...prev, evidenceId: id, drawerOpen: true }));
  const at = evidenceCoordinates(id);
  if (at) getGlobe()?.flyTo({ ...at, altitudeM: EVIDENCE_ALTITUDE_M });
}

/** Side effects of one streamed event. */
export function applyAgentSideEffects(event: AgentStreamEvent, nowMs = Date.now()): void {
  if (event.type === "view") applyViewEvent(event, nowMs);
  // A map control (toggle_layer, set_look): validated again here, since the event crossed the network.
  if (event.type === "ui") applyUiEvent(event, nowMs);
}
