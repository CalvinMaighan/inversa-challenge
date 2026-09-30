import { describe, expect, test } from "bun:test";

import { DEFAULT_BOARD_ID, MISSIONS } from "client/state/missions";

describe("MISSIONS", () => {
  test("summarises an empty shared board with the panel closed", () => {
    expect(MISSIONS.defaults).toEqual({
      boardId: DEFAULT_BOARD_ID,
      lastSeq: 0,
      missionCount: 0,
      removalTotal: 0,
      unread: 0,
      focusedMissionId: null,
      panelOpen: false,
    });
  });

  test("board id is safe in a signaling room path", () => {
    expect(DEFAULT_BOARD_ID).toMatch(/^[a-z0-9-]+$/);
    expect(MISSIONS.panelOpen).toBe("MISSIONS.panelOpen");
  });
});
