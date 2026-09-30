/**
 * SELECTION as the HUD uses it. Selecting (voice `select`, a share link) brackets an entity; the drawer opens
 * when `drawerOpen` is set too (voice `open_evidence`, a bracket label, a citation). Closing the drawer keeps
 * the selection, so its bracket stays on the globe.
 */
import { set } from "@calvinjs/active-state";

import { parseEvidenceId, SELECTION, type SelectionState } from "client/state/selection";

export type HudSelection = SelectionState;

/**
 * `backtest:<species>:<days>` (PLAN.md C14). Parsed here because `client/state/selection`'s
 * `parseEvidenceId` predates the backtest kind.
 */
export function parseBacktestId(id: string): { species: string; days: number } | null {
  const m = /^backtest:([a-z_]+):(\d{1,3})$/.exec(id);
  return m && Number(m[2]) > 0 ? { species: m[1]!, days: Number(m[2]) } : null;
}

/** Any C14 evidence id the HUD can open. */
export function isEvidenceId(id: string): boolean {
  return parseEvidenceId(id) !== null || parseBacktestId(id) !== null;
}

/** Open when something is selected and `drawerOpen` is not false. A writer that omits the flag opens it. */
export function isDrawerOpen(selection: { evidenceId: string | null; drawerOpen?: boolean } | undefined): boolean {
  return Boolean(selection?.evidenceId) && selection?.drawerOpen !== false;
}

/** Select an evidence id and open the drawer on it. */
export function openEvidence(evidenceId: string): void {
  set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId, drawerOpen: true }));
}

/** Hide the drawer, keep the selection. */
export function closeDrawer(): void {
  set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, drawerOpen: false }));
}

export function clearSelection(): void {
  set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId: null, drawerOpen: false }));
}
