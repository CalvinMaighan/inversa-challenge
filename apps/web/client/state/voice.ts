import { key } from "@calvinjs/active-state";

import type { VoiceState as VoicePhase } from "shared/voice/protocol";

export type VoiceState = {
  /** Session phase from the voice relay; drives the orb's pulse ring. */
  state: VoicePhase;
  /** Live transcript of the current turn (user while listening, assistant while speaking). */
  transcript: string;
};

const defaults: VoiceState = { state: "idle", transcript: "" };

export const VOICE = key("VOICE", defaults);
