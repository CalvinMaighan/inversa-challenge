import type { VoiceState } from "client/state/voice";

/** What the orb shows. */
export type OrbPhase = "idle" | "connecting" | "listening" | "speaking" | "thinking";

/** The VOICE fields the orb reads; partial because the key may not be set yet. */
export type OrbVoice = Partial<Pick<VoiceState, "status" | "state" | "error">>;

/**
 * Voice owns the orb while live: listening and speaking pulse, thinking spins. Otherwise a typed turn still
 * streaming spins, and anything else is the idle presence dot.
 */
export function orbPhase(voice: OrbVoice | undefined, agentWorking: boolean): OrbPhase {
  const live = voice?.status === "live";
  if (voice?.status === "connecting") return "connecting";
  if (live && voice.state === "listening") return "listening";
  if (live && voice.state === "speaking") return "speaking";
  if ((live && voice.state === "thinking") || agentWorking) return "thinking";
  return "idle";
}

/** Live or connecting: the mic control stops (or cancels) instead of starting. */
export function voiceIsLive(voice: OrbVoice | undefined): boolean {
  return voice?.status === "live" || voice?.status === "connecting";
}

export const ORB_LABELS: Record<OrbPhase, string> = {
  idle: "Agent ready",
  connecting: "Connecting voice",
  listening: "Listening",
  speaking: "Speaking",
  thinking: "Working",
};
