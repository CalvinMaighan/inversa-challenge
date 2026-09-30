/**
 * Evidence ids (PLAN.md C14) the globe stamps on its primitives, so `pick()` returns exactly what the agent
 * cites and the drawer opens. The formats match `server/agent/tools/evidence.ts`.
 */
import { REGION_BBOX } from "client/state/view";
import { SPECIES_IDS } from "shared/voice/ui-tools";

/** C14 hotspot cells are on the 0.01° grid even though frames carry a 0.02° display grid. */
export const EVIDENCE_CELL_DEG = 0.01;
export const EVIDENCE_CELL_COLS = Math.round((REGION_BBOX.east - REGION_BBOX.west) / EVIDENCE_CELL_DEG);
export const EVIDENCE_CELL_ROWS = Math.round((REGION_BBOX.north - REGION_BBOX.south) / EVIDENCE_CELL_DEG);

export function sightingEvidenceId(id: string | number): string {
  return `sighting:${id}`;
}

export function alertEvidenceId(id: string): string {
  return `alert:${id}`;
}

/** `reading:<station_id>:<param>:<observed_at ms>:<origin>`, param and origin lower-case as stored. */
export function readingEvidenceId(stationId: string, param: string, observedAt: string, origin: string): string {
  return `reading:${stationId}:${param.toLowerCase()}:${Date.parse(observedAt)}:${origin.toLowerCase()}`;
}

/** `<col>:<row>` on the 0.01° grid from the region's south-west corner, or null outside the region. */
export function evidenceCell(lon: number, lat: number): string | null {
  const col = Math.floor((lon - REGION_BBOX.west) / EVIDENCE_CELL_DEG + 1e-9);
  const row = Math.floor((lat - REGION_BBOX.south) / EVIDENCE_CELL_DEG + 1e-9);
  if (col < 0 || row < 0 || col >= EVIDENCE_CELL_COLS || row >= EVIDENCE_CELL_ROWS) return null;
  return `${col}:${row}`;
}

/** `hotspot:<species>:<cell>:<frame ms>`; null when the point is outside the region or the species unknown. */
export function hotspotEvidenceId(speciesIndex: number, lon: number, lat: number, frameMs: number): string | null {
  const species = SPECIES_IDS[speciesIndex];
  const cell = evidenceCell(lon, lat);
  if (!species || !cell || !Number.isFinite(frameMs)) return null;
  return `hotspot:${species}:${cell}:${frameMs}`;
}
