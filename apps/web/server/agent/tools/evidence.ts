/** Evidence ids (PLAN.md C14), grid cells and species keys shared by the tools. */

import { CELL_DEG, REGION_BBOX } from "@/server/agent/config";
import type { Evidence } from "@/server/agent/runtime/registry";
import type { EvidenceKind } from "@/shared/agent/events";

/** Species order and `taxa.id` 1–4 (PLAN.md C4). */
/* eslint-disable inversa/prefer-catalog-constants -- metadata table keyed by the SPECIES_IDS values, same order. */
export const SPECIES = [
  { key: "python", taxonId: "1", common: "Burmese python", scientific: "Python bivittatus" },
  { key: "tegu", taxonId: "2", common: "Argentine black and white tegu", scientific: "Salvator merianae" },
  { key: "iguana", taxonId: "3", common: "Green iguana", scientific: "Iguana iguana" },
  { key: "lionfish", taxonId: "4", common: "Red lionfish", scientific: "Pterois volitans" },
] as const;
/* eslint-enable inversa/prefer-catalog-constants */

export type SpeciesKey = (typeof SPECIES)[number]["key"];
export const SPECIES_KEYS = SPECIES.map((species) => species.key) as [SpeciesKey, ...SpeciesKey[]];

export function speciesByKey(key: SpeciesKey) {
  return SPECIES.find((species) => species.key === key)!;
}

const EVIDENCE_KINDS = new Set<EvidenceKind>(["sighting", "reading", "alert", "fetch", "hotspot"]);

/** `<kind>:<key>` with a known kind and a non-empty key. */
export function parseEvidenceId(id: string): { kind: EvidenceKind; key: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon) as EvidenceKind;
  const key = id.slice(colon + 1);
  return EVIDENCE_KINDS.has(kind) && key.length > 0 ? { kind, key } : null;
}

export function evidence(kind: EvidenceKind, key: string, label: string): Evidence {
  return { id: `${kind}:${key}`, kind, label };
}

export function readingKey(stationId: string, param: string, observedAt: string, origin: string): string {
  return `${stationId}:${param.toLowerCase()}:${Date.parse(observedAt)}:${origin.toLowerCase()}`;
}

export function hotspotKey(species: string, cell: string, at: string): string {
  return `${species}:${cell}:${Date.parse(at)}`;
}

/** Cell id `<col>:<row>` on the 0.01° grid anchored at the region's south-west corner. */
export function cellFor(lat: number, lon: number): string {
  const col = Math.floor((lon - REGION_BBOX.west) / CELL_DEG + 1e-9);
  const row = Math.floor((lat - REGION_BBOX.south) / CELL_DEG + 1e-9);
  return `${col}:${row}`;
}

export function cellCenter(cell: string): { lat: number; lon: number } | null {
  const match = /^(\d+):(\d+)$/.exec(cell);
  if (!match) return null;
  return {
    lon: REGION_BBOX.west + (Number(match[1]) + 0.5) * CELL_DEG,
    lat: REGION_BBOX.south + (Number(match[2]) + 0.5) * CELL_DEG,
  };
}
