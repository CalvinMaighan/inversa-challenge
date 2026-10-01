import type { VoiceState } from "client/state/voice";

/** What the chat column's status line and mic button show. */
export type AgentPhase = "idle" | "connecting" | "listening" | "speaking" | "thinking";

/** The VOICE fields the phase reads; partial because the key may not be set yet. */
export type PhaseVoice = Partial<Pick<VoiceState, "status" | "state" | "error">>;

/**
 * Voice owns the phase while live: listening and speaking pulse the mic, thinking shows as working. Otherwise
 * a typed turn still streaming is working, and anything else is ready.
 */
export function agentPhase(voice: PhaseVoice | undefined, agentWorking: boolean): AgentPhase {
  const live = voice?.status === "live";
  if (voice?.status === "connecting") return "connecting";
  if (live && voice.state === "listening") return "listening";
  if (live && voice.state === "speaking") return "speaking";
  if ((live && voice.state === "thinking") || agentWorking) return "thinking";
  return "idle";
}

/** Live or connecting: the mic control stops (or cancels) instead of starting. */
export function voiceIsLive(voice: PhaseVoice | undefined): boolean {
  return voice?.status === "live" || voice?.status === "connecting";
}

export const PHASE_LABELS: Record<AgentPhase, string> = {
  idle: "Agent ready",
  connecting: "Connecting voice",
  listening: "Listening",
  speaking: "Speaking",
  thinking: "Working",
};
