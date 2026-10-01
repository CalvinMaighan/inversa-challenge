import { catalog } from "@calvinjs/active-state";

import { AGENT_CARD, AGENT_CHAT, AGENT_HIGHLIGHT } from "./agent";
import { FEEDS } from "./feeds";
import { LAYERS } from "./layers";
import { ME } from "./me";
import { MISSIONS } from "./missions";
import { NOTES } from "./notes";
import { PEERS } from "./peers";
import { SELECTION } from "./selection";
import { ACCENT_COLOR, THEME } from "./theme";
import { TIME } from "./time";
import { VIEW } from "./view";
import { VOICE } from "./voice";

export { AGENT_CARD, AGENT_CHAT, AGENT_HIGHLIGHT } from "./agent";
export { FEEDS } from "./feeds";
export { LAYERS } from "./layers";
export { ME } from "./me";
export { MISSIONS } from "./missions";
export { NOTES } from "./notes";
export { PEERS } from "./peers";
export { SELECTION } from "./selection";
export { ACCENT_COLOR, THEME } from "./theme";
export { TIME } from "./time";
export { VIEW } from "./view";
export { VOICE } from "./voice";

/** Snapshot for `<ActiveState init={state} />`. Importing this module runs every `key()`. */
export const state = catalog(TIME, VIEW, LAYERS, SELECTION, FEEDS, MISSIONS, PEERS, ME, NOTES, AGENT_CARD, AGENT_CHAT, AGENT_HIGHLIGHT, VOICE, THEME, ACCENT_COLOR);

export type StateKeyId = "TIME" | "VIEW" | "LAYERS" | "SELECTION" | "FEEDS" | "MISSIONS" | "PEERS" | "ME" | "NOTES" | "AGENT_CARD" | "AGENT_CHAT" | "AGENT_HIGHLIGHT" | "VOICE" | "THEME" | "ACCENT_COLOR";

/**
 * Every key id in code-unit order. PLAN.md C6: a key's position here is its `keyIndex` on the SAB transport,
 * so both ends of a ring agree without a handshake. Adding a key shifts later indices; main and workers are
 * built from the same bundle, so they always agree.
 */
export const STATE_KEY_IDS = Object.freeze(Object.keys(state).sort() as StateKeyId[]);

/** id → keyIndex, the inverse of STATE_KEY_IDS. */
export const STATE_KEY_INDEX: Readonly<Record<StateKeyId, number>> = Object.freeze(
  Object.fromEntries(STATE_KEY_IDS.map((id, index) => [id, index])) as Record<StateKeyId, number>,
);
