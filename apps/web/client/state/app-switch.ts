import { get, set } from "@calvinjs/active-state";

import { boardIdFor, getApp, type AppId } from "shared/apps";
import type { FeedState } from "shared/feed-state";

import { AGENT_CHAT, AGENT_HIGHLIGHT } from "./agent";
import { APP, type AppState } from "./app";
import { FEEDS } from "./feeds";
import { layersFor, LAYERS } from "./layers";
import { MISSIONS, type MissionsState } from "./missions";
import { NOTES } from "./notes";
import { PEERS } from "./peers";
import { MESSAGES } from "./messages";
import { SELECTION } from "./selection";
import { TAXA } from "./taxa";
import { VIEW, viewFor, type ViewState } from "./view";

/**
 * Make `id` the active app (PLAN.md C-A5) and reset everything that belongs to the previous one: the map preset
 * (VIEW, with `seq` bumped so the globe flies there), the app's layers and species filter, the team board
 * (`<app>:main`, C-A6), feed envelopes, taxa, selection, the agent thread and highlights. TIME is kept: the
 * moment the viewer is looking at does not depend on the app. A no-op when `id` is already active.
 *
 * URL and localStorage are the caller's (`client/hud/appselect/switch.ts`); this touches the store only, so tests
 * and the workers' mirror see one consistent switch.
 */
export function applyApp(id: AppId): boolean {
  if (get<AppState>(APP)?.id === id) return false;
  const app = getApp(id);
  set<AppState>(APP, { id });
  set<ViewState>(VIEW, (prev = VIEW.defaults) => viewFor(app, prev.seq + 1));
  set(LAYERS, layersFor(app));
  set<MissionsState>(MISSIONS, (prev = MISSIONS.defaults) => ({ ...MISSIONS.defaults, boardId: boardIdFor(id), panelOpen: prev.panelOpen }));
  set(NOTES, NOTES.defaults);
  set(MESSAGES, MESSAGES.defaults);
  set(PEERS, PEERS.defaults);
  set<FeedState[]>(FEEDS, []);
  set(TAXA, TAXA.defaults);
  set(SELECTION, SELECTION.defaults);
  set(AGENT_CHAT, AGENT_CHAT.defaults);
  set(AGENT_HIGHLIGHT, AGENT_HIGHLIGHT.defaults);
  return true;
}
