/**
 * SELECTION as the HUD uses it. Selecting (voice `select`, a share link) brackets an entity; the drawer opens
 * when `drawerOpen` is set too (voice `open_evidence`, a bracket label, a citation). Closing the drawer keeps
 * the selection, so its bracket stays on the globe.
 */
import { set } from "@calvinjs/active-state";

import { canonicalEvidenceId, SELECTION, type SelectionState } from "client/state/selection";

export type HudSelection = SelectionState;

/** Open when something is selected and `drawerOpen` is not false. A writer that omits the flag opens it. */
export function isDrawerOpen(selection: { evidenceId: string | null; drawerOpen?: boolean } | undefined): boolean {
  return Boolean(selection?.evidenceId) && selection?.drawerOpen !== false;
}

/** Select an evidence id and open the drawer on it. */
export function openEvidence(rawId: string): void {
  const evidenceId = canonicalEvidenceId(rawId);
  set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId, drawerOpen: true }));
}

/** Hide the drawer, keep the selection. */
export function closeDrawer(): void {
  set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, drawerOpen: false }));
}

export function clearSelection(): void {
  set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId: null, drawerOpen: false }));
}
