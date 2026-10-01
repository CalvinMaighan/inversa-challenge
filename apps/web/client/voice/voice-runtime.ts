"use client";

import { get, init, set, subscribe } from "@calvinjs/active-state";

import { LAYERS, SELECTION, state, TIME, VIEW, VOICE } from "client/state";
import { activeAppId } from "client/state/app";
import type { VoiceState as VoiceKeyState } from "client/state/voice";
import type { VoiceControlMessage } from "server/voice/view-state-control";
import {
  VOICE_EVENTS_RESUBSCRIBE_MS,
  VOICE_TOKEN_HEADER,
  type VoiceServerEvent,
  type VoiceSessionOpenResponse,
} from "shared/voice/protocol";

import { createAudioUplink } from "./audio-uplink";
import { createBargeInDetector } from "./barge-in";
import { readHudState } from "./hud-state";
import { startMicCapture, type MicCapture } from "./mic-capture";
import { createPcmPlayback, type PcmPlayback } from "./playback";
import { emitTaskEvent } from "./task-events";
import { applyUiCommand } from "./ui-command-handler";

/** Chat column API: `onTaskEvent((taskId, event) => …)` streams agent output for voice tasks. */
export { onTaskEvent, type TaskEventListener } from "./task-events";

/**
 * Browser side of voice mode (ported from deedee). One module-level runtime so any component
 * can start or stop it; UI reads the `VOICE` key.
 */

/** HUD changes are coalesced before they are posted as `view_state`. */
const VIEW_STATE_DEBOUNCE_MS = 250;

type Runtime = {
  sessionId: string;
  token: string;
  audio: AudioContext;
  mic: MicCapture;
  playback: PcmPlayback;
  events: AbortController;
  resubscribeTimer: ReturnType<typeof setTimeout> | null;
  uplink: ReturnType<typeof createAudioUplink>;
  barge: ReturnType<typeof createBargeInDetector>;
  unwatchHud: () => void;
  stopped: boolean;
};

let runtime: Runtime | null = null;
let starting: AbortController | null = null;
let assistantResponseId: string | null = null;

function readVoice(): VoiceKeyState {
  return { ...VOICE.defaults, ...get<VoiceKeyState>(VOICE) };
}

function patchVoice(patch: Partial<VoiceKeyState>): void {
  set<VoiceKeyState>(VOICE, { ...readVoice(), ...patch });
}

/** Clean session state, keeping the task list so the card can still show finished answers. */
function offState(status: VoiceKeyState["status"], error: string | null): VoiceKeyState {
  return { ...VOICE.defaults, status, error, tasks: readVoice().tasks };
}

async function control(request: VoiceControlMessage, rt: Runtime | null = runtime): Promise<void> {
  if (!rt) return;
  try {
    await fetch(`/api/voice/session/${rt.sessionId}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [VOICE_TOKEN_HEADER]: rt.token },
      body: JSON.stringify(request),
      keepalive: request.type === "close",
    });
  } catch {
    /* transient; the events loop reports fatal states */
  }
}

const CLOSE_MESSAGES: Record<string, string> = {
  max_duration: "Voice session reached its time limit. Press the mic to start again.",
  daily_budget: "Today's voice minutes are used up.",
  provider_denied: "Grok Voice is not available on this server's xAI key.",
  replaced: "Voice moved to another tab or window.",
  idle: "Voice stopped after being idle.",
};

function handleEvent(event: VoiceServerEvent): void {
  const rt = runtime;
  if (!rt) return;
  switch (event.type) {
    case "voice.ready":
      patchVoice({ status: "live", sessionId: event.sessionId, error: null });
      return;
    case "voice.state":
      patchVoice({ state: event.state });
      return;
    case "audio.delta":
      rt.playback.push(event.responseId, event.audio, event.sampleRate);
      return;
    case "audio.done":
      rt.playback.finish(event.responseId);
      return;
    case "playback.clear":
      rt.playback.clear();
      return;
    case "transcript.user":
      if (event.text.trim() || event.final) patchVoice({ userText: event.text, transcript: event.text });
      return;
    case "transcript.assistant": {
      // Deltas of a new response start a fresh line instead of appending to the previous answer.
      const prefix = event.responseId === assistantResponseId ? readVoice().assistantText : "";
      assistantResponseId = event.responseId;
      const text = event.final ? event.text : `${prefix}${event.text}`;
      patchVoice({ assistantText: text, transcript: text });
      return;
    }
    case "task.updated": {
      const tasks = readVoice().tasks.filter((t) => t.id !== event.task.id);
      patchVoice({ tasks: [...tasks, event.task].slice(-20) });
      return;
    }
    case "task.event":
      emitTaskEvent(event.taskId, event.event);
      return;
    case "tool.call":
      patchVoice({ activeTool: event.status === "started" ? event.name : null });
      return;
    case "ui.command":
      applyUiCommand(event);
      return;
    case "error":
      patchVoice({ error: event.message, ...(event.fatal ? { status: "error" as const } : {}) });
      if (event.fatal) stopVoice({ notifyServer: false });
      return;
    case "session.closed": {
      const message = CLOSE_MESSAGES[event.reason];
      if (message) patchVoice({ status: "error", error: message });
      stopVoice({ notifyServer: false });
      return;
    }
    default:
      return;
  }
}

async function readEvents(rt: Runtime): Promise<void> {
  const res = await fetch(`/api/voice/session/${rt.sessionId}/events`, {
    headers: { [VOICE_TOKEN_HEADER]: rt.token },
    signal: rt.events.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(res.status === 404 ? "Voice session ended" : `Voice events failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: VoiceServerEvent;
      try {
        event = JSON.parse(line) as VoiceServerEvent;
      } catch {
        continue;
      }
      handleEvent(event);
    }
  }
}

/** Reopen the stream on a schedule and after drops; a 404 means the session is gone. */
function subscribeEvents(rt: Runtime): void {
  if (rt.stopped) return;
  rt.events = new AbortController();
  if (rt.resubscribeTimer) clearTimeout(rt.resubscribeTimer);
  rt.resubscribeTimer = setTimeout(() => rt.events.abort(), VOICE_EVENTS_RESUBSCRIBE_MS);
  void readEvents(rt)
    .then(() => {
      if (!rt.stopped && runtime === rt) subscribeEvents(rt);
    })
    .catch((error: unknown) => {
      if (rt.stopped || runtime !== rt) return;
      if (rt.events.signal.aborted) {
        subscribeEvents(rt);
        return;
      }
      patchVoice({ status: "error", error: error instanceof Error ? error.message : "Voice failed" });
      stopVoice({ notifyServer: false });
    });
}

/** Post the HUD snapshot now and after every VIEW / TIME / LAYERS / SELECTION change. */
function watchHud(rt: Runtime): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const post = () => {
    timer = null;
    if (rt.stopped) return;
    void control({ type: "view_state", state: readHudState() }, rt);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(post, VIEW_STATE_DEBOUNCE_MS);
  };
  const unsubs = [VIEW, TIME, LAYERS, SELECTION].map((k) => subscribe(k, schedule));
  // subscribe() replays current values into schedule(); post once now instead of after the debounce.
  if (timer) clearTimeout(timer);
  post();
  return () => {
    if (timer) clearTimeout(timer);
    for (const off of unsubs) off();
  };
}

/** Mic permission, then session open, then audio flows. Safe to call twice; the second is a no-op. */
export async function startVoice(): Promise<void> {
  if (runtime || starting) return;
  // Idempotent: a no-op once the shell's <ActiveState init={state}> has booted the store.
  init(state);
  assistantResponseId = null;
  const abort = new AbortController();
  starting = abort;
  set(VOICE, { ...offState("connecting", null) });
  let audio: AudioContext | null = null;
  let mic: MicCapture | null = null;
  const session = { id: "", token: "" };
  const uplink = createAudioUplink(
    async (audioBatch) => {
      if (!session.id) return;
      await fetch(`/api/voice/session/${session.id}/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [VOICE_TOKEN_HEADER]: session.token },
        body: JSON.stringify({ audio: audioBatch }),
      }).catch(() => undefined);
    },
    { hold: true },
  );
  try {
    audio = new AudioContext();
    await audio.resume();
    if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
    mic = await startMicCapture(audio, {
      onBatch: (base64) => uplink.push(base64),
      onLevel: (level) => {
        const rt = runtime;
        if (!rt || rt.stopped) return;
        if (!rt.barge.push({ level, playing: rt.playback.isPlaying(), now: Date.now() })) return;
        rt.playback.clear();
        void control({ type: "interrupt" }, rt);
      },
      onError: (error) => {
        patchVoice({ status: "error", error: error.message });
        stopVoice({ notifyServer: true });
      },
    });
    if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
    // The session runs in the active app: its persona, its UI tools' layers and species (PLAN.md C-A5).
    const res = await fetch(`/api/voice/session?app=${activeAppId()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });
    const payload = (await res.json().catch(() => null)) as (VoiceSessionOpenResponse & { error?: string }) | null;
    if (!res.ok || !payload?.sessionId) {
      throw new Error(payload?.error ?? `Voice mode unavailable (${res.status})`);
    }
    session.id = payload.sessionId;
    session.token = payload.token;
    const rt: Runtime = {
      sessionId: payload.sessionId,
      token: payload.token,
      audio,
      mic,
      playback: createPcmPlayback(audio, (responseId, state) => void control({ type: "playback", responseId, state }, rt)),
      events: new AbortController(),
      resubscribeTimer: null,
      uplink,
      barge: createBargeInDetector(),
      unwatchHud: () => undefined,
      stopped: false,
    };
    if (abort.signal.aborted) {
      // Stop pressed while the open request was in flight: release the server session too.
      void control({ type: "close" }, rt);
      throw new DOMException("Aborted", "AbortError");
    }
    runtime = rt;
    starting = null;
    uplink.open();
    rt.unwatchHud = watchHud(rt);
    subscribeEvents(rt);
  } catch (error) {
    uplink.stop();
    mic?.stop();
    void audio?.close();
    if (starting === abort) starting = null;
    if (abort.signal.aborted) {
      if (!runtime) set(VOICE, offState("off", null));
      return;
    }
    runtime = null;
    set(VOICE, offState("error", error instanceof Error ? error.message : "Could not start voice mode"));
  }
}

export function stopVoice(opts: { notifyServer: boolean } = { notifyServer: true }): void {
  starting?.abort();
  starting = null;
  const rt = runtime;
  if (!rt) {
    const prev = readVoice();
    if (prev.status !== "error") set(VOICE, offState("off", null));
    return;
  }
  rt.stopped = true;
  runtime = null;
  rt.uplink.stop();
  if (opts.notifyServer) void control({ type: "close" }, rt);
  rt.unwatchHud();
  if (rt.resubscribeTimer) clearTimeout(rt.resubscribeTimer);
  rt.events.abort();
  rt.mic.stop();
  rt.playback.dispose();
  void rt.audio.close();
  const prev = readVoice();
  set(VOICE, offState(prev.status === "error" ? "error" : "off", prev.status === "error" ? prev.error : null));
}

/** Barge-in from the UI: stop playback locally and tell the provider. */
export function interrupt(): void {
  const rt = runtime;
  if (!rt) return;
  rt.playback.clear();
  void control({ type: "interrupt" }, rt);
}

/** Typed input into the live voice conversation. */
export function sendVoiceText(text: string): void {
  if (!text.trim()) return;
  void control({ type: "text", text });
}

export function isVoiceLive(): boolean {
  return runtime !== null && !runtime.stopped;
}
