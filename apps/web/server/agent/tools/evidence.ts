/** Evidence ids (PLAN.md C14), grid cells and species keys shared by the tools. */

import { CELL_DEG, REGION_BBOX } from "@/server/agent/config";
import type { CitableKind, Evidence } from "@/server/agent/runtime/registry";
import { SPECIES_IDS } from "@/shared/voice/ui-tools";

export type SpeciesKey = (typeof SPECIES_IDS)[number];
export const SPECIES_KEYS = SPECIES_IDS;

const SPECIES_NAMES: Record<SpeciesKey, { common: string; scientific: string }> = {
  python: { common: "Burmese python", scientific: "Python bivittatus" },
  tegu: { common: "Argentine black and white tegu", scientific: "Salvator merianae" },
  iguana: { common: "Green iguana", scientific: "Iguana iguana" },
  lionfish: { common: "Red lionfish", scientific: "Pterois volitans" },
};

/** SPECIES_IDS order is the EVF species order, so `taxa.id` is position + 1 (PLAN.md C4). */
export const SPECIES = SPECIES_IDS.map((key, index) => ({ key, taxonId: String(index + 1), ...SPECIES_NAMES[key] }));

export function speciesByKey(key: SpeciesKey) {
  return SPECIES.find((species) => species.key === key)!;
}

const EVIDENCE_KINDS = new Set<CitableKind>(["sighting", "reading", "alert", "fetch", "hotspot", "backtest"]);

/** `<kind>:<key>` with a known kind and a non-empty key. */
export function parseEvidenceId(id: string): { kind: CitableKind; key: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon) as CitableKind;
  const key = id.slice(colon + 1);
  return EVIDENCE_KINDS.has(kind) && key.length > 0 ? { kind, key } : null;
}

export function evidence(kind: CitableKind, key: string, label: string): Evidence {
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
