import { key } from "@calvinjs/active-state";

/** One shared board for the region; the rtc room and `board(id)` query use the same id. */
export const DEFAULT_BOARD_ID = "everglades";

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
