import { describe, expect, test } from "bun:test";

import { DEFAULT_BOARD_ID, MISSIONS } from "client/state/missions";
import { APP_IDS, boardIdFor } from "shared/apps";

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
    expect(MISSIONS.panelOpen).toBe("MISSIONS.panelOpen");
  });

  test("active app: the board (and RTC room) is <app>:main, the default app's to start (C-A6)", () => {
    expect(DEFAULT_BOARD_ID).toBe("carp:main");
    for (const id of APP_IDS) expect(boardIdFor(id)).toBe(`${id}:main`);
    // Safe in a signaling room path: one `:` (C-A6 widens the worker's charset to accept it), nothing to escape.
    for (const id of APP_IDS) expect(boardIdFor(id)).toMatch(/^[a-z0-9-]+:main$/);
  });
});
