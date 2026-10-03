import { key } from "@calvinjs/active-state";

import type { EvidenceKind } from "shared/agent/events";

export type SelectionState = {
  /** Evidence id `<kind>:<key>` (PLAN.md C14), or null when nothing is selected. */
  evidenceId: string | null;
  /** Evidence drawer open (voice `open_evidence`). */
  drawerOpen: boolean;
};

const EVIDENCE_KINDS: readonly EvidenceKind[] = ["sighting", "reading", "alert", "fetch", "hotspot", "backtest", "note", "vessel"];

/** Split an evidence id into kind and key. Keys may contain colons (readings, hotspots); only the first splits. */
export function parseEvidenceId(id: string): { kind: EvidenceKind; key: string } | null {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  const kind = id.slice(0, at) as EvidenceKind;
  return EVIDENCE_KINDS.includes(kind) ? { kind, key: id.slice(at + 1) } : null;
}

/**
 * A carp sighting is cited as `fish:<source>:<id>` (`fish:inat:405306600`); a model or a link sometimes writes it as a
 * `sighting:` id, which only ever has an integer key, and the evidence drawer cannot load that ("expected sighting:<integer id>").
 * Such an id is the same carp sighting under its own prefix.
 */
export function canonicalEvidenceId(id: string): string {
  const m = /^sighting:([a-z]+:.+)$/i.exec(id.trim());
  return m ? `fish:${m[1]}` : id;
}

const defaults: SelectionState = { evidenceId: null, drawerOpen: false };

export const SELECTION = key("SELECTION", defaults);
