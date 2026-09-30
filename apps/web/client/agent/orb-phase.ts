import type { VoiceState } from "shared/voice/protocol";

/** What the orb shows. */
export type OrbPhase = "idle" | "connecting" | "listening" | "speaking" | "thinking";

/**
 * The VOICE key as the orb reads it. T15 writes `status` and `state`; the catalog declares only `state`, so
 * both are optional here.
 */
export type OrbVoice = { status?: "off" | "connecting" | "live" | "error"; state?: VoiceState; error?: string | null };

/**
 * Voice owns the orb while live: listening and speaking pulse, thinking spins. Otherwise a typed turn still
 * streaming spins, and anything else is the idle presence dot.
 */
export function orbPhase(voice: OrbVoice | undefined, agentWorking: boolean): OrbPhase {
  const live = voice?.status === "live" || (voice?.status === undefined && voice?.state !== undefined && voice.state !== "idle");
  if (voice?.status === "connecting") return "connecting";
  if (live && voice?.state === "listening") return "listening";
  if (live && voice?.state === "speaking") return "speaking";
  if ((live && voice?.state === "thinking") || agentWorking) return "thinking";
  return "idle";
}

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
