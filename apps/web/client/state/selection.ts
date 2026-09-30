import { key } from "@calvinjs/active-state";

import type { EvidenceKind } from "shared/agent/events";

export type SelectionState = {
  /** Evidence id `<kind>:<key>` (PLAN.md C14), or null when nothing is selected. */
  evidenceId: string | null;
};

const EVIDENCE_KINDS: readonly EvidenceKind[] = ["sighting", "reading", "alert", "fetch", "hotspot"];

/** Split an evidence id into kind and key. Keys may contain colons (readings, hotspots); only the first splits. */
export function parseEvidenceId(id: string): { kind: EvidenceKind; key: string } | null {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  const kind = id.slice(0, at) as EvidenceKind;
  return EVIDENCE_KINDS.includes(kind) ? { kind, key: id.slice(at + 1) } : null;
}

const defaults: SelectionState = { evidenceId: null };

export const SELECTION = key("SELECTION", defaults);
