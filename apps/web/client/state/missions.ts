import { key } from "@calvinjs/active-state";

import { boardIdFor, DEFAULT_APP_ID } from "shared/apps";

/**
 * One shared board per app (C-A6): `<app>:main`; the rtc room and `board(id)` query use the same id. This is the
 * default app's; switching apps moves MISSIONS.boardId (`client/state/app-switch.ts`).
 */
export const DEFAULT_BOARD_ID = boardIdFor(DEFAULT_APP_ID);

/**
 * Summary of the team board for the HUD. The board itself (missions, notes, messages, removals) lives in the
 * db worker's CRDT store; this key carries only what the top bar and panel header show.
 */
export type MissionsState = {
  boardId: string;
  /** Highest server op seq applied locally. */
  lastSeq: number;
  /** Missions not deleted. */
  missionCount: number;
  /** Merged removal total across every mission (G-counter sum). */
  removalTotal: number;
  /** Team chat messages the panel has not shown yet. */
  unread: number;
  /** Mission id focused in the panel and scope mask, or null. */
  focusedMissionId: string | null;
  panelOpen: boolean;
};

const defaults: MissionsState = {
  boardId: DEFAULT_BOARD_ID,
  lastSeq: 0,
  missionCount: 0,
  removalTotal: 0,
  unread: 0,
  focusedMissionId: null,
  panelOpen: false,
};

export const MISSIONS = key("MISSIONS", defaults);
