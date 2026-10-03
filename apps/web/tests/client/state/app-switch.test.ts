import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { AGENT_CHAT, type AgentChatState } from "client/state/agent";
import { APP, type AppState } from "client/state/app";
import { applyApp } from "client/state/app-switch";
import { FEEDS } from "client/state/feeds";
import { LAYERS, layersFor, type LayersState } from "client/state/layers";
import { MISSIONS, type MissionsState } from "client/state/missions";
import { SELECTION, type SelectionState } from "client/state/selection";
import { TIME, type TimeState } from "client/state/time";
import { VIEW, viewFor, type ViewState } from "client/state/view";
import { getApp } from "shared/apps";
import type { FeedState } from "shared/feed-state";

init(state);

describe("active app switch", () => {
  test("active app: applyApp resets the view, layers, board, feeds, and selection, and keeps TIME and the agent thread", () => {
    set<MissionsState>(MISSIONS, (p = MISSIONS.defaults) => ({ ...p, panelOpen: true, missionCount: 4 }));
    set(SELECTION, { evidenceId: "sighting:1", drawerOpen: true });
    set(FEEDS, [{ source: "usgs", mode: "poll", state: "nominal", newestObservedAt: null, lastFetchAt: null, lastFetchRunId: null, lagSeconds: null, note: null }]);
    set<AgentChatState>(AGENT_CHAT, { sessionId: "s1", messages: [] });
    const time = get<TimeState>(TIME);
    const seq = get<ViewState>(VIEW)!.seq;

    expect(applyApp("lionfish")).toBe(true);
    expect(get<AppState>(APP)).toEqual({ id: "lionfish" });
    expect(get<ViewState>(VIEW)).toEqual(viewFor(getApp("lionfish"), seq + 1));
    expect(get<LayersState>(LAYERS)).toEqual(layersFor(getApp("lionfish")));
    expect(get<MissionsState>(MISSIONS)).toMatchObject({ boardId: "lionfish:main", missionCount: 0, panelOpen: true });
    expect(get<SelectionState>(SELECTION)).toEqual(SELECTION.defaults);
    expect(get<FeedState[]>(FEEDS)).toEqual([]);
    expect(get<AgentChatState>(AGENT_CHAT)).toEqual({ sessionId: "s1", messages: [] });
    expect(get<TimeState>(TIME)).toBe(time);
  });

  test("active app: applying the active app again is a no-op", () => {
    set<LayersState>(LAYERS, (p = LAYERS.defaults) => ({ ...p, sightingHours: 48 }));
    expect(applyApp("lionfish")).toBe(false);
    expect(get<LayersState>(LAYERS)!.sightingHours).toBe(48);
    expect(applyApp("carp")).toBe(true);
    expect(get<MissionsState>(MISSIONS)!.boardId).toBe("carp:main");
  });
});
