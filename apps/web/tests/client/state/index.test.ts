import { describe, expect, test } from "bun:test";
import { isPersisted, isShared, registeredState } from "@calvinjs/active-state";

import { STATE_KEY_IDS, STATE_KEY_INDEX, state } from "client/state";
import { registeredStateKeys } from "@/eslint-plugins/inversa/state-key-registration.mjs";

/**
 * PRD §12 "Theme and state" plus active-theme's two keys, the active app (PLAN.md C-A5), live messages (C-A7) and
 * the carp view (site, as-of, replay; leaf UC).
 */
const PLAN_KEYS = ["APP", "CARP", "TIME", "VIEW", "LAYERS", "SELECTION", "FEEDS", "MISSIONS", "PEERS", "ME", "NOTES", "MESSAGES", "AGENT_CARD", "AGENT_CHAT", "AGENT_HIGHLIGHT", "VOICE"];
const THEME_KEYS = ["THEME", "ACCENT_COLOR"];
/** The look of the globe (docs/GODS_EYE.md GC2): preset, scope mask and its feather. */
const LOOK_KEYS = ["LOOK", "SCOPE_ON", "SCOPE_FEATHER"];

describe("state catalog", () => {
  test("holds exactly the PLAN keys plus the theme and look keys", () => {
    expect(Object.keys(state).sort()).toEqual([...PLAN_KEYS, ...THEME_KEYS, ...LOOK_KEYS].sort());
  });

  test("every catalog entry is the key's registered default", () => {
    const registry = registeredState();
    for (const id of Object.keys(state)) expect(state[id]).toBe(registry[id]);
  });

  test("ids are UPPERCASE_IDS, as the active-state lint rules require", () => {
    for (const id of Object.keys(state)) expect(id).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  test("the lint rule reads the same registration list", () => {
    const registered = registeredStateKeys(process.cwd());
    expect([...(registered ?? [])].sort()).toEqual([...PLAN_KEYS, ...THEME_KEYS, ...LOOK_KEYS].sort());
  });

  test("only ME and the theme keys persist; only the theme keys sync across tabs", () => {
    const persisted = Object.keys(state).filter((id) => isPersisted(id)).sort();
    expect(persisted).toEqual(["ACCENT_COLOR", "ME", "THEME"]);
    expect(Object.keys(state).filter((id) => isShared(id)).sort()).toEqual(["ACCENT_COLOR", "THEME"]);
  });
});

describe("transport key index (PLAN.md C6)", () => {
  test("STATE_KEY_IDS is the catalog in code-unit order", () => {
    expect(STATE_KEY_IDS).toEqual([
      "ACCENT_COLOR",
      "AGENT_CARD",
      "AGENT_CHAT",
      "AGENT_HIGHLIGHT",
      "APP",
      "CARP",
      "FEEDS",
      "LAYERS",
      "LOOK",
      "ME",
      "MESSAGES",
      "MISSIONS",
      "NOTES",
      "PEERS",
      "SCOPE_FEATHER",
      "SCOPE_ON",
      "SELECTION",
      "THEME",
      "TIME",
      "VIEW",
      "VOICE",
    ]);
  });

  test("is frozen, so no caller can reorder the indices", () => {
    expect(Object.isFrozen(STATE_KEY_IDS)).toBe(true);
    expect(Object.isFrozen(STATE_KEY_INDEX)).toBe(true);
  });

  test("STATE_KEY_INDEX inverts it", () => {
    STATE_KEY_IDS.forEach((id, index) => expect(STATE_KEY_INDEX[id]).toBe(index));
    expect(Object.keys(STATE_KEY_INDEX)).toHaveLength(STATE_KEY_IDS.length);
  });

  test("every key has one of the control block's 256 keyVersion slots", () => {
    expect(STATE_KEY_IDS.length).toBeLessThanOrEqual(256);
  });
});
