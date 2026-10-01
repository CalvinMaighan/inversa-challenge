import { key } from "@calvinjs/active-state";

import type { VoiceInputMode, VoiceState as VoicePhase, VoiceTaskSnapshot } from "shared/voice/protocol";

export type VoiceStatus = "off" | "connecting" | "live" | "error";

/** Voice session as the chat column reads it. Written by `client/voice/voice-runtime.ts`. */
export type VoiceState = {
  status: VoiceStatus;
  sessionId: string | null;
  /** Session phase from the voice relay; drives the mic pulse and status line. */
  state: VoicePhase;
  /** Live transcript of the current turn (user while listening, assistant while speaking). */
  transcript: string;
  /** Latest user and assistant lines, kept apart for the card. */
  userText: string;
  assistantText: string;
  error: string | null;
  /** Realtime tool Grok is running right now, if any. */
  activeTool: string | null;
  inputMode: VoiceInputMode;
  /** Background analysis spawned from this session, oldest first. Streamed output: `onTaskEvent`. */
  tasks: VoiceTaskSnapshot[];
  /** Last UI command applied, e.g. "fly_to", for the column's receipt line. */
  lastCommand: string | null;
};

const defaults: VoiceState = {
  status: "off",
  sessionId: null,
  state: "idle",
  transcript: "",
  userText: "",
  assistantText: "",
  error: null,
  activeTool: null,
  inputMode: "talk",
  tasks: [],
  lastCommand: null,
};

export const VOICE = key("VOICE", defaults);
