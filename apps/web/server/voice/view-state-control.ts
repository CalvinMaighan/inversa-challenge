import { isVoiceControlRequest, type VoiceControlRequest } from "shared/voice/protocol";

/**
 * Local control extension (not in shared/voice/protocol.ts): the browser posts its HUD state
 * so `view_screen` and `spawn_thinking` can see what the user sees.
 *
 *   POST /api/voice/session/:id/control  { "type": "view_state", "state": { ...HUD JSON } }
 *
 * `state` must be a plain JSON object whose JSON is at most VIEW_STATE_MAX_CHARS characters.
 */
export type VoiceViewStateRequest = { type: "view_state"; state: Record<string, unknown> };

export type VoiceControlMessage = VoiceControlRequest | VoiceViewStateRequest;

export const VIEW_STATE_MAX_CHARS = 16 * 1024;

export function isVoiceViewStateRequest(value: unknown): value is VoiceViewStateRequest {
  if (!value || typeof value !== "object") return false;
  const { type, state } = value as { type?: unknown; state?: unknown };
  if (type !== "view_state") return false;
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  try {
    return JSON.stringify(state).length <= VIEW_STATE_MAX_CHARS;
  } catch {
    return false;
  }
}

export function isVoiceControlMessage(value: unknown): value is VoiceControlMessage {
  return isVoiceControlRequest(value) || isVoiceViewStateRequest(value);
}
