import { catalog } from "@calvinjs/active-state";

import { AGENT_CARD, AGENT_CHAT, AGENT_HIGHLIGHT } from "./agent";
import { APP } from "./app";
import { CARP } from "./carp";
import { FEEDS } from "./feeds";
import { LAYERS } from "./layers";
import { LOOK, SCOPE_FEATHER, SCOPE_ON } from "./look";
import { ME } from "./me";
import { MESSAGES } from "./messages";
import { MISSIONS } from "./missions";
import { NOTES } from "./notes";
import { PEERS } from "./peers";
import { SELECTION } from "./selection";
import { ACCENT_COLOR, THEME } from "./theme";
import { TIME } from "./time";
import { VIEW } from "./view";
import { VOICE } from "./voice";

export { AGENT_CARD, AGENT_CHAT, AGENT_HIGHLIGHT } from "./agent";
export { APP } from "./app";
export { CARP } from "./carp";
export { FEEDS } from "./feeds";
export { LAYERS } from "./layers";
export { LOOK, SCOPE_FEATHER, SCOPE_ON } from "./look";
export { ME } from "./me";
export { MESSAGES } from "./messages";
export { MISSIONS } from "./missions";
export { NOTES } from "./notes";
export { PEERS } from "./peers";
export { SELECTION } from "./selection";
export { ACCENT_COLOR, THEME } from "./theme";
export { TIME } from "./time";
export { VIEW } from "./view";
export { VOICE } from "./voice";

/** Snapshot for `<ActiveState init={state} />`. Importing this module runs every `key()`. */
export const state = catalog(APP, CARP, TIME, VIEW, LAYERS, SELECTION, FEEDS, MISSIONS, PEERS, ME, NOTES, MESSAGES, AGENT_CARD, AGENT_CHAT, AGENT_HIGHLIGHT, VOICE, THEME, ACCENT_COLOR, LOOK, SCOPE_ON, SCOPE_FEATHER);

export type StateKeyId =
  | "APP"
  | "CARP"
  | "TIME"
  | "VIEW"
  | "LAYERS"
  | "SELECTION"
  | "FEEDS"
  | "MISSIONS"
  | "PEERS"
  | "ME"
  | "NOTES"
  | "MESSAGES"
  | "AGENT_CARD"
  | "AGENT_CHAT"
  | "AGENT_HIGHLIGHT"
  | "VOICE"
  | "THEME"
  | "ACCENT_COLOR"
  | "LOOK"
  | "SCOPE_ON"
  | "SCOPE_FEATHER";

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
