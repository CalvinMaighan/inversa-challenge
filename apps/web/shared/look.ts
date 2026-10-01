/**
 * The seven looks of the globe (docs/GODS_EYE.md GC2), shared by the client (LOOK key, presets) and the agent's and
 * voice's `set_look` UI tool (shared/voice/ui-tools.ts), with the words a person uses for each.
 */
export const LOOK_IDS = ["normal", "crt", "nvg", "flir", "noir", "anime", "snow"] as const;
export type LookId = (typeof LOOK_IDS)[number];

/** What each look is called in plain words, for the tool descriptions and the prompt. */
export const LOOK_WORDS: Record<LookId, string> = {
  normal: "the plain map",
  crt: "an old monitor",
  nvg: "night vision, phosphor green",
  flir: "a thermal camera",
  noir: "black and white film",
  anime: "flat cartoon colours",
  snow: "a cold, snowy cast",
};
