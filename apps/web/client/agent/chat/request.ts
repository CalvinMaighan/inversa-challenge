import { activeApp } from "client/state/app";
import { isSpeciesFiltered, shownSpecies, sightingHoursOf, type LayersState } from "client/state/layers";
import type { AgentStreamRequest, BBox } from "shared/agent/events";
import { appBBox } from "shared/apps";

/**
 * What the card sends with each question: the current view from VIEW, TIME, LAYERS (visible layers and the
 * species filter) and SELECTION, shaped as
 * `AgentStreamRequest.view`. Pure over loose snapshots, because other writers (voice commands, the globe)
 * may leave fields missing; anything unusable falls back to the region and the wall clock.
 */

export type ViewSnapshot = {
  view?: { bbox?: Partial<BBox> } | null;
  time?: { at?: string | null } | null;
  layers?: { visible?: Record<string, boolean>; species?: Record<string, unknown>; sightingHours?: number } | null;
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
  // The species bar's filter, only when it hides an animal: "how many?" then counts what the globe shows.
  const filter = snapshot.layers?.species;
  const species = shownSpecies(filter);
  return {
    bbox: validBBox(bbox) ? { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north } : appBBox(activeApp()),
    time: new Date(Number.isFinite(atMs) ? atMs : nowMs).toISOString(),
    layers: Object.entries(snapshot.layers?.visible ?? {})
      .filter(([, on]) => on === true)
      .map(([id]) => id),
    ...(isSpeciesFiltered(filter) ? { species } : {}),
    windowHours: sightingHoursOf(snapshot.layers as Partial<LayersState> | undefined),
    selection: snapshot.selection?.evidenceId ?? null,
  };
}

/** The body of `POST /api/agent/stream`, in the active app (C-A5: the server picks persona, tools and scope from it). */
export function buildAgentRequest(sessionId: string, question: string, snapshot: ViewSnapshot, nowMs: number): AgentStreamRequest {
  return { app: activeApp().id, sessionId, question: question.trim(), view: agentView(snapshot, nowMs) };
}
