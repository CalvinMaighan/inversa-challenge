import { REGION_BBOX } from "client/state/view";
import type { AgentStreamRequest, BBox } from "shared/agent/events";

/**
 * What the card sends with each question: the current view from VIEW, TIME, LAYERS and SELECTION, shaped as
 * `AgentStreamRequest.view`. Pure over loose snapshots, because other writers (voice commands, the globe)
 * may leave fields missing; anything unusable falls back to the region and the wall clock.
 */

export type ViewSnapshot = {
  view?: { bbox?: Partial<BBox> } | null;
  time?: { at?: string | null } | null;
  layers?: { visible?: Record<string, boolean> } | null;
  selection?: { evidenceId?: string | null } | null;
};

export function validBBox(bbox: Partial<BBox> | undefined | null): bbox is BBox {
  if (!bbox) return false;
  const { west, south, east, north } = bbox;
  return [west, south, east, north].every((v) => typeof v === "number" && Number.isFinite(v)) && west! < east! && south! < north!;
}

export function agentView(snapshot: ViewSnapshot, nowMs: number): NonNullable<AgentStreamRequest["view"]> {
  const bbox = snapshot.view?.bbox;
  const at = snapshot.time?.at;
  const atMs = typeof at === "string" ? Date.parse(at) : NaN;
  return {
    bbox: validBBox(bbox) ? { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north } : { ...REGION_BBOX },
    time: new Date(Number.isFinite(atMs) ? atMs : nowMs).toISOString(),
    layers: Object.entries(snapshot.layers?.visible ?? {})
      .filter(([, on]) => on === true)
      .map(([id]) => id),
    selection: snapshot.selection?.evidenceId ?? null,
  };
}

export function buildAgentRequest(sessionId: string, question: string, snapshot: ViewSnapshot, nowMs: number): AgentStreamRequest {
  return { sessionId, question: question.trim(), view: agentView(snapshot, nowMs) };
}
