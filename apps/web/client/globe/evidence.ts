/**
 * Evidence ids (PLAN.md C14) the globe stamps on its primitives, so `pick()` returns exactly what the agent
 * cites and the drawer opens. The formats match `server/agent/tools/evidence.ts`; cells and species come from the
 * active app (its first region's grid, its taxa in config order).
 */
import { activeApp } from "client/state/app";
import { cellAt, gridSize, primaryRegion, speciesIds } from "shared/apps";

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

/** `<col>:<row>` on the app's evidence grid (0.01° for python) from its region's south-west corner, or null outside it. */
export function evidenceCell(lon: number, lat: number): string | null {
  const region = primaryRegion(activeApp());
  const cell = cellAt(region, lat, lon);
  const [col, row] = cell.split(":").map(Number) as [number, number];
  const { cols, rows } = gridSize(region);
  return col < 0 || row < 0 || col >= cols || row >= rows ? null : cell;
}

/** `hotspot:<species>:<cell>:<frame ms>`; null when the point is outside the region or the species unknown. */
export function hotspotEvidenceId(speciesIndex: number, lon: number, lat: number, frameMs: number): string | null {
  const species = speciesIds(activeApp())[speciesIndex];
  const cell = evidenceCell(lon, lat);
  if (!species || !cell || !Number.isFinite(frameMs)) return null;
  return `hotspot:${species}:${cell}:${frameMs}`;
}
