import { set } from "@calvinjs/active-state";

import { getGlobe, type CameraTarget } from "client/globe/api";
import { SELECTION, type SelectionState, parseEvidenceId } from "client/state/selection";
import { TIME, retime, type TimeState } from "client/state/time";
import { REGION_BBOX, altitudeToFit } from "client/state/view";
import type { AgentStreamEvent, BBox } from "shared/agent/events";

/** Side effects of agent output on the rest of the app: camera, timeline, selection. */

/** PLAN.md C14: hotspot cells are 0.01° squares counted from the region's south-west corner. */
export const HOTSPOT_CELL_DEG = 0.01;
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
  const lon = REGION_BBOX.west + (col + 0.5) * HOTSPOT_CELL_DEG;
  const lat = REGION_BBOX.south + (row + 0.5) * HOTSPOT_CELL_DEG;
  if (lon > REGION_BBOX.east || lat > REGION_BBOX.north) return null;
  return { lon: round6(lon), lat: round6(lat) };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

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
  getGlobe()?.flyTo(bboxCamera(event.bbox));
  const atMs = Date.parse(event.time);
  if (!Number.isFinite(atMs)) return;
  set<TimeState>(TIME, (prev) => {
    const base = { ...TIME.defaults, ...prev };
    return { ...base, ...retime(base, atMs, nowMs), playing: false };
  });
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
}
