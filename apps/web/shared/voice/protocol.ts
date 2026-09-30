/**
 * Voice mode wire contract (PLAN.md C8, copied from deedee) between the browser and the Next voice
 * relay. The relay holds the Grok Voice WebSocket; the browser only ever sees
 * these events, never the provider protocol.
 */

/** PCM16 mono the browser sends after resampling. Matches the provider input rate. */
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
/** PCM16 mono the provider returns. */
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000;
/** Microphone batch the browser posts per request. */
export const VOICE_AUDIO_BATCH_MS = 200;
/** Header carrying the per-session secret on audio / control / events calls. */
export const VOICE_TOKEN_HEADER = "x-voice-token";
/** The events stream is reopened on this cadence so the server can refresh auth context. */
export const VOICE_EVENTS_RESUBSCRIBE_MS = 25 * 60 * 1000;
/** Hard cap for one voice session. */
export const VOICE_MAX_SESSION_MS = 5 * 60 * 1000;
/** Daily voice budget across all sessions, in minutes (R19). */
export const VOICE_DAILY_MINUTES = 60;

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export type VoiceAssistantOrigin = "turn" | "announcement";

export type VoiceTaskStatus = "running" | "completed" | "failed" | "canceled";

export type VoiceTaskSnapshot = {
  id: string;
  status: VoiceTaskStatus;
  objective: string;
  step: string | null;
  summary: string | null;
  error: string | null;
};

export type VoiceServerEvent =
  | {
      type: "voice.ready";
      sessionId: string;
      inputSampleRate: number;
      outputSampleRate: number;
    }
  | { type: "voice.state"; state: VoiceState }
  | { type: "audio.delta"; responseId: string; audio: string; sampleRate: number }
  | { type: "audio.done"; responseId: string }
  | { type: "playback.clear"; reason: string }
  | { type: "transcript.user"; turnId: string; text: string; final: boolean; hold?: boolean }
  | {
      type: "transcript.assistant";
      responseId: string;
      text: string;
      final: boolean;
      origin: VoiceAssistantOrigin;
    }
  | { type: "task.updated"; task: VoiceTaskSnapshot }
  | { type: "tool.call"; name: string; status: "started" | "done" }
  /** Direct UI tool call validated by shared/voice/ui-tools.ts; the client applies it. */
  | { type: "ui.command"; name: string; args: unknown }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "session.closed"; reason: string };

export type VoicePlaybackReceiptState = "started" | "ended" | "cancelled";

export type VoiceInputMode = "talk" | "dictate";

export type VoiceControlRequest =
  | { type: "interrupt" }
  | { type: "text"; text: string }
  | { type: "playback"; responseId: string; state: VoicePlaybackReceiptState }
  | { type: "close" }
  | { type: "mode"; mode: VoiceInputMode };

export type VoiceSessionOpenResponse = {
  sessionId: string;
  token: string;
  inputSampleRate: number;
  outputSampleRate: number;
};

export function isVoiceControlRequest(value: unknown): value is VoiceControlRequest {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  if (type === "interrupt" || type === "close") return true;
  if (type === "mode") {
    const mode = (value as { mode?: unknown }).mode;
    return mode === "talk" || mode === "dictate";
  }
  if (type === "text") return typeof (value as { text?: unknown }).text === "string";
  if (type === "playback") {
    const state = (value as { state?: unknown }).state;
    return (
      typeof (value as { responseId?: unknown }).responseId === "string" &&
      (state === "started" || state === "ended" || state === "cancelled")
    );
  }
  return false;
}