/** Evidence ids (PLAN.md C14), grid cells and species keys shared by the tools. Regions and species come from the app config (C-A3). */

import type { CitableKind, Evidence } from "@/server/agent/runtime/registry";
import { EVIDENCE_KINDS } from "@/shared/agent/events";
import { cellAt, cellCentre, primaryRegion, taxonKey, type AppConfig } from "@/shared/apps";

export type SpeciesKey = string;

export type FocusSpecies = { key: SpeciesKey; taxonId: string; common: string; scientific: string };

/** The app's focus species. `taxonId` is the config's `dbId`: the `taxa.id` the API filters and cites by (C-A4). */
export function focusSpecies(app: AppConfig): FocusSpecies[] {
  return app.taxa.map((t) => ({ key: taxonKey(t), taxonId: String(t.dbId), common: t.name, scientific: t.scientificName }));
}

export function speciesKeys(app: AppConfig): SpeciesKey[] {
  return app.taxa.map(taxonKey);
}

const KINDS = new Set<CitableKind>(EVIDENCE_KINDS);

/** `<kind>:<key>` with a known kind and a non-empty key. */
export function parseEvidenceId(id: string): { kind: CitableKind; key: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon) as CitableKind;
  const key = id.slice(colon + 1);
  return KINDS.has(kind) && key.length > 0 ? { kind, key } : null;
}

export function evidence(kind: CitableKind, key: string, label: string, feed?: string): Evidence {
  return feed ? { id: `${kind}:${key}`, kind, label, feed } : { id: `${kind}:${key}`, kind, label };
}

export function readingKey(stationId: string, param: string, observedAt: string, origin: string): string {
  return `${stationId}:${param.toLowerCase()}:${Date.parse(observedAt)}:${origin.toLowerCase()}`;
}

export function hotspotKey(species: string, cell: string, at: string): string {
  return `${species}:${cell}:${Date.parse(at)}`;
}

/** Cell id `<col>:<row>` on the app's grid (its first region, at that region's `cellDeg`; 0.01° for python). */
export function cellFor(app: AppConfig, lat: number, lon: number): string {
  return cellAt(primaryRegion(app), lat, lon);
}

export function cellCenter(app: AppConfig, cell: string): { lat: number; lon: number } | null {
  return cellCentre(primaryRegion(app), cell);
}
