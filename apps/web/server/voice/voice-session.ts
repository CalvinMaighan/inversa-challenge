import { createHash, randomBytes, randomUUID } from "node:crypto";

import { isAgentStreamEvent } from "shared/agent/events";
import type { AppConfig } from "shared/apps";
import {
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_OUTPUT_SAMPLE_RATE,
  type VoiceInputMode,
  type VoicePlaybackReceiptState,
  type VoiceServerEvent,
  type VoiceState,
  type VoiceTaskSnapshot,
  type VoiceTaskStatus,
} from "shared/voice/protocol";

import type { AgentRunner } from "./agent-runner";
import { AnnouncementWindow, type AnnouncementOrigin } from "./announcement-window";
import type { VoiceBudget } from "./budget";
import {
  RealtimeConnection,
  VOICE_REALTIME_VOICE,
  isRealtimeFatal,
  type RealtimeEvent,
  type RealtimeTarget,
} from "./grok-realtime";
import { routeMessage, type Route, type RouteInput } from "@/server/agent/decisions";
import { claimTurn, decidesStop, looksLikeHangUp, looksLikeStop } from "./stop-intent";
import { isUiToolName, validateUiToolCall } from "./ui-command";
import {
  CANCEL_TASK_TOOL,
  GET_TASK_STATUS_TOOL,
  PROGRESS_RESPONSE_INSTRUCTIONS,
  RESULT_RESPONSE_INSTRUCTIONS,
  SPAWN_THINKING_TOOL,
  VIEW_SCREEN_TOOL,
  buildVoiceInstructions,
  greetingInstructions,
  voiceToolsFor,
  formatProgressContext,
  formatResultContext,
  type ResultContextItem,
} from "./voice-prompt";

/** Delivery retry while the announcement window is blocked. */
/** Server VAD: how sure the model must be that it hears speech, and how long a pause ends the turn. */
const VAD_THRESHOLD = 0.6;
/** Silence that ends a turn for the provider. Shorter than a breath-and-think pause is wrong, longer feels slow: the early path below does not wait for it. */
const VAD_SILENCE_MS = 450;
/** A sentence the transcript ends with . ? or !, quiet this long, is treated as said: the analyst starts without waiting for the provider's end of turn. */
const EARLY_QUIET_MS = 180;
const SENTENCE_END = /[.?!]['")\]]*\s*$/;
const normalizeSaid = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Data questions the analyst can start on at once (GLiDE intents). */
const EAGER_INTENTS: ReadonlySet<string> = new Set(["reports", "conditions", "priority", "data_sources", "species_info"]);
/** Words that point back at an earlier turn: such a question is worded by the voice model, not eagerly. (Not "this", "there", "more", "also", "other": "this week" and "how many are there" stand alone.) */
const LEANS_ON_BEFORE = /\b(it|its|that|those|them|these|same|again|previous|earlier)\b/i;
const ANNOUNCE_RETRY_MS = 1_000;
/** Progress updates are spoken at most this often per task. */
const PROGRESS_MIN_INTERVAL_MS = 8_000;
/** Wait for `session.updated` after the socket opens. */
const HANDSHAKE_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 400;
/** Daily budget is charged on this cadence (and once more on close). */
const METER_MS = 10_000;

type Subscriber = (event: VoiceServerEvent) => void;

type PendingResponse = { origin: AnnouncementOrigin; turnId: string };

type ResponseContext = {
  origin: AnnouncementOrigin;
  turnId: string;
  hasAudio: boolean;
  transcript: string;
  /** Function calls seen in this response, and how many are still executing. */
  calls: number;
  pendingCalls: number;
  done: boolean;
  followUpSent: boolean;
};

type TrackedTask = {
  id: string;
  objective: string;
  fingerprint: string;
  abort: AbortController;
  lastProgressAt: number;
  status: VoiceTaskStatus;
  step: string | null;
  summary: string | null;
  error: string | null;
  /** What the analyst cited (id to label), handed to the voice for `show_card`. */
  sources: Map<string, string>;
};

type ToolReceipt = Record<string, unknown>;

const INVALID_JSON = Symbol("invalid-json");

export type VoiceSessionOptions = {
  ip: string;
  /** The app the browser opened voice in: persona, scope, UI tool enums and the analyst's app (C-A5). */
  app: AppConfig;
  target: RealtimeTarget;
  runner: AgentRunner;
  budget: VoiceBudget;
  maxSessionMs: number;
  meterMs?: number;
  /** Speak a one-line "I'm listening" as soon as the microphone is live (default on). */
  greet?: boolean;
  /** The first-run welcome ("Welcome to the Inversa Experience"), spoken in place of the plain listening line. */
  welcome?: boolean;
  /** Decides what a transcript is (Fastino); a stub in tests. Defaults to `routeMessage`. */
  route?: (input: RouteInput) => Promise<Route | null>;
};

function fingerprint(objective: string): string {
  return createHash("sha256")
    .update(objective.replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Provider sends `arguments` as a JSON string. Empty means no arguments. */
function parseArgs(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function responseIdOf(event: RealtimeEvent): string {
  const direct = str(event.response_id);
  if (direct) return direct;
  const response = event.response as { id?: unknown } | undefined;
  return str(response?.id);
}

function providerErrorMessage(event: RealtimeEvent): string {
  const error = event.error as { message?: unknown } | undefined;
  return str(error?.message) || str(event.message) || "Realtime provider error";
}

function isTerminal(status: VoiceTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function snapshot(task: TrackedTask): VoiceTaskSnapshot {
  return {
    id: task.id,
    status: task.status,
    objective: task.objective,
    step: task.step,
    summary: task.summary,
    error: task.error,
  };
}

function userTranscriptText(event: RealtimeEvent): string {
  const stash = str(event.stash);
  const text = str(event.text);
  if (text || stash) return `${text}${stash}`;
  return str(event.delta) || str(event.transcript);
}

/**
 * One live voice conversation: a Grok Voice socket, the browser event stream, direct UI
 * commands, and background analysis turns spawned from it.
 *
 * Grok never touches data. `spawn_thinking` runs an agent turn through the injected
 * `AgentRunner`; its result is spoken only when the announcement window is clear, so the user
 * is never interrupted mid-sentence.
 */
export class VoiceSession {
  readonly id = randomUUID();
  readonly token = randomBytes(24).toString("base64url");
  readonly createdAt = Date.now();
  readonly ip: string;
  lastActivityAt = Date.now();

  private conn: RealtimeConnection | null = null;
  private readonly subscribers = new Set<Subscriber>();
  private readonly window = new AnnouncementWindow();
  private readonly pendingResponses: PendingResponse[] = [];
  private readonly responses = new Map<string, ResponseContext>();
  private readonly tasks = new Map<string, TrackedTask>();
  /** Turn id from server VAD → the one analysis task for that utterance. */
  private readonly turnTasks = new Map<string, string>();
  private readonly announcements: ResultContextItem[] = [];
  private readonly progressQueue: { taskId: string; step: string }[] = [];
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private state: VoiceState = "idle";
  private inputMode: VoiceInputMode = "talk";
  private viewState: Record<string, unknown> | null = null;
  private viewStateAt: number | null = null;
  private turnCounter = 0;
  private closed = false;
  private greeted = false;
  /** The user's words so far this turn, from the streaming transcript, and the sentence the analyst was started on early. */
  private partialText = "";
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;
  private early: { turnId: string; said: string; taskId: string | null } | null = null;
  private connGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChargeAt: number | null = null;
  private closeListeners: (() => void)[] = [];

  constructor(private readonly opts: VoiceSessionOptions) {
    this.ip = opts.ip;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get taskIds(): string[] {
    return [...this.tasks.keys()];
  }

  async connect(): Promise<void> {
    const generation = ++this.connGeneration;
    const handshake = await this.connectGrok(generation);
    if (handshake !== "ok") throw new Error(handshake || "Could not start Grok Voice");
  }

  private connectGrok(generation: number): Promise<"ok" | string> {
    return new Promise<"ok" | string>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const finish = (result: "ok" | string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const conn = new RealtimeConnection(this.opts.target, {
        onEvent: (event) => {
          if (generation !== this.connGeneration) return;
          if (event.type === "session.updated") finish("ok");
          if (event.type === "error" && !settled) {
            finish(providerErrorMessage(event));
            return;
          }
          this.onProviderEvent(event);
        },
        onClose: (reason) => {
          if (generation !== this.connGeneration) return;
          this.conn = null;
          if (!settled) {
            finish(reason);
            return;
          }
          if (this.closed) return;
          console.error("[voice] provider closed", reason);
          if (isRealtimeFatal(reason)) {
            this.emit({ type: "error", message: reason, fatal: true });
            this.close("provider_denied");
            return;
          }
          this.scheduleReconnect();
        },
      });
      timer = setTimeout(() => finish("Timed out waiting for Grok Voice"), HANDSHAKE_TIMEOUT_MS);
      void conn
        .connect()
        .then(() => {
          if (this.closed || generation !== this.connGeneration) {
            conn.close();
            finish("closed");
            return;
          }
          this.conn = conn;
          conn.send({
            type: "session.update",
            session: {
              instructions: buildVoiceInstructions(this.opts.app),
              tools: voiceToolsFor(this.opts.app),
              voice: VOICE_REALTIME_VOICE,
              // Explicit, so a quiet room ends the turn: 0.6 ignores a hum that 0.5 hears as speech, and 650 ms of silence
              // ends it (the default 200 ms cuts a pause mid-question; far longer feels sluggish).
              turn_detection: { type: "server_vad", threshold: VAD_THRESHOLD, prefix_padding_ms: 300, silence_duration_ms: VAD_SILENCE_MS },
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: VOICE_INPUT_SAMPLE_RATE },
                  transcription: { model: "grok-transcribe" },
                },
                output: { format: { type: "audio/pcm", rate: VOICE_OUTPUT_SAMPLE_RATE } },
              },
            },
          });
        })
        .catch((error: unknown) => {
          conn.close();
          finish(error instanceof Error ? error.message : "connect failed");
        });
    }).then((result) => {
      if (result === "ok") {
        this.setState("listening");
        this.startMeter();
        this.greet();
      } else {
        this.conn?.close();
        this.conn = null;
      }
      return result;
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.conn) return;
      void this.connect().catch((error: unknown) => {
        console.error("[voice] reconnect failed", error);
        const message = error instanceof Error ? error.message : String(error);
        if (isRealtimeFatal(message)) {
          this.emit({ type: "error", message, fatal: true });
          this.close("provider_denied");
          return;
        }
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  /** Session cap and daily budget start once the provider accepted the session. */
  private startMeter(): void {
    if (this.maxTimer) return;
    this.lastChargeAt = Date.now();
    this.maxTimer = setTimeout(() => this.close("max_duration"), this.opts.maxSessionMs);
    this.meterTimer = setInterval(() => this.meterTick(), this.opts.meterMs ?? METER_MS);
  }

  private chargeElapsed(): void {
    if (this.lastChargeAt === null) return;
    const now = Date.now();
    this.opts.budget.charge(now - this.lastChargeAt);
    this.lastChargeAt = now;
  }

  private meterTick(): void {
    if (this.closed) return;
    this.chargeElapsed();
    if (this.opts.budget.exhausted()) {
      this.emit({ type: "error", message: "Daily voice minutes are used up", fatal: true });
      this.close("daily_budget");
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    fn({
      type: "voice.ready",
      sessionId: this.id,
      inputSampleRate: VOICE_INPUT_SAMPLE_RATE,
      outputSampleRate: VOICE_OUTPUT_SAMPLE_RATE,
    });
    fn({ type: "voice.state", state: this.state });
    for (const tracked of this.tasks.values()) fn({ type: "task.updated", task: snapshot(tracked) });
    return () => {
      this.subscribers.delete(fn);
    };
  }

  onClose(fn: () => void): void {
    if (this.closed) {
      fn();
      return;
    }
    this.closeListeners.push(fn);
  }

  appendAudio(base64: string): void {
    this.touch();
    this.conn?.send({ type: "input_audio_buffer.append", audio: base64 });
  }

  sendText(text: string): void {
    this.touch();
    const trimmed = text.trim();
    if (!trimmed || !this.conn) return;
    const turnId = this.nextTurnId();
    this.window.beginTurn(turnId);
    this.window.endSpeech();
    this.emit({ type: "transcript.user", turnId, text: trimmed, final: true });
    this.conn.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: trimmed }] },
    });
    this.pendingResponses.push({ origin: "turn", turnId });
    this.conn.send({ type: "response.create" });
    this.setState("thinking");
  }

  interrupt(): void {
    this.touch();
    this.conn?.send({ type: "response.cancel" });
    this.window.interrupt();
    this.emit({ type: "playback.clear", reason: "user_interruption" });
    this.setState("listening");
    this.scheduleAnnouncements();
  }

  setInputMode(mode: VoiceInputMode): void {
    this.inputMode = mode;
    this.touch();
  }

  /** HUD state from the browser (`view_state` control). Read by `view_screen` and passed to the runner. */
  setViewState(state: Record<string, unknown>): void {
    this.touch();
    this.viewState = state;
    this.viewStateAt = Date.now();
  }

  playbackReceipt(responseId: string, state: VoicePlaybackReceiptState): void {
    this.touch();
    if (state === "started") {
      this.window.startPlayback(responseId);
      this.setState("speaking");
      return;
    }
    this.window.finishPlayback(responseId);
    const context = this.responses.get(responseId);
    if (context && context.pendingCalls > 0) {
      // Audio is over but a tool call is still running: keep the context for its follow-up.
      context.hasAudio = false;
    } else {
      this.responses.delete(responseId);
    }
    if (!this.window.isPlaying()) this.setState("listening");
    this.scheduleAnnouncements();
  }

  close(reason: string): void {
    if (this.closed) return;
    this.chargeElapsed();
    this.closed = true;
    this.connGeneration += 1;
    this.clearEarly();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.meterTimer) clearInterval(this.meterTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.reconnectTimer = null;
    this.meterTimer = null;
    this.maxTimer = null;
    this.announceTimer = null;
    this.lastChargeAt = null;
    for (const tracked of this.tasks.values()) {
      if (!isTerminal(tracked.status)) tracked.abort.abort();
    }
    this.conn?.close();
    this.conn = null;
    this.emit({ type: "session.closed", reason });
    this.subscribers.clear();
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const fn of listeners) fn();
  }

  private onProviderEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        this.clearEarly();
        const turnId = this.nextTurnId();
        this.window.beginTurn(turnId);
        this.emit({ type: "playback.clear", reason: "user_speaking" });
        this.setState("listening");
        return;
      }
      case "input_audio_buffer.speech_stopped":
        this.window.endSpeech();
        this.setState("thinking");
        return;
      case "input_audio_buffer.committed":
        this.pendingResponses.push({ origin: "turn", turnId: this.window.currentTurnId() });
        return;
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.updated":
        this.emit({
          type: "transcript.user",
          turnId: this.window.currentTurnId(),
          text: userTranscriptText(event),
          final: false,
        });
        this.onPartial(userTranscriptText(event));
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const text = userTranscriptText(event);
        this.emit({ type: "transcript.user", turnId: this.window.currentTurnId(), text, final: true });
        if (this.inputMode === "talk") this.onFinalTranscript(text);
        return;
      }
      case "response.created": {
        const id = responseIdOf(event);
        if (this.inputMode === "dictate") {
          this.pendingResponses.shift();
          this.conn?.send({ type: "response.cancel" });
          return;
        }
        const pending = this.pendingResponses.shift() ?? { origin: "turn" as const, turnId: this.window.currentTurnId() };
        this.responses.set(id, this.newResponseContext(pending));
        return;
      }
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const id = responseIdOf(event);
        const context = this.responseContext(id);
        if (!context.hasAudio) {
          context.hasAudio = true;
          this.window.queueAudio(id, { turnId: context.turnId, origin: context.origin });
        }
        this.emit({ type: "audio.delta", responseId: id, audio: str(event.delta), sampleRate: VOICE_OUTPUT_SAMPLE_RATE });
        return;
      }
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const id = responseIdOf(event);
        const context = this.responseContext(id);
        const delta = str(event.delta) || str(event.text);
        context.transcript += delta;
        this.emit({ type: "transcript.assistant", responseId: id, text: delta, final: false, origin: context.origin });
        return;
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const id = responseIdOf(event);
        const context = this.responseContext(id);
        const text = str(event.transcript) || str(event.text) || context.transcript;
        this.emit({ type: "transcript.assistant", responseId: id, text, final: true, origin: context.origin });
        return;
      }
      case "response.function_call_arguments.done": {
        const id = responseIdOf(event);
        const context = this.responseContext(id);
        context.calls += 1;
        context.pendingCalls += 1;
        void this.runToolCall({
          responseId: id,
          callId: str(event.call_id),
          name: str(event.name),
          args: parseArgs(event.arguments),
          turnId: context.turnId,
        });
        return;
      }
      case "response.done": {
        const id = responseIdOf(event);
        const context = this.responses.get(id);
        if (context) {
          context.done = true;
          this.window.responseDone({
            turnId: context.turnId,
            origin: context.origin,
            hasAudio: context.hasAudio,
            awaitsToolFollowUp: context.calls > 0,
          });
          if (context.hasAudio) this.emit({ type: "audio.done", responseId: id });
          this.settleResponse(id, context);
        }
        if (!this.window.isPlaying() && this.state !== "listening") this.setState("listening");
        this.scheduleAnnouncements();
        return;
      }
      case "error": {
        const message = providerErrorMessage(event);
        if (/no active response/i.test(message)) return;
        const fatal = isRealtimeFatal(message);
        this.emit({ type: "error", message, fatal });
        if (fatal) this.close(`provider error: ${message}`);
        return;
      }
      default:
        return;
    }
  }

  private newResponseContext(pending: PendingResponse): ResponseContext {
    return {
      ...pending,
      hasAudio: false,
      transcript: "",
      calls: 0,
      pendingCalls: 0,
      done: false,
      followUpSent: false,
    };
  }

  private responseContext(id: string): ResponseContext {
    let context = this.responses.get(id);
    if (!context) {
      context = this.newResponseContext({ origin: "turn", turnId: this.window.currentTurnId() });
      this.responses.set(id, context);
    }
    return context;
  }

  /**
   * Once a response is done and every tool call in it has returned its output, ask for one
   * follow-up response. One `response.create` per response (not per call) avoids the provider's
   * "active response" rejection when Grok calls several tools at once.
   */
  private settleResponse(id: string, context: ResponseContext): void {
    if (!context.done || context.pendingCalls > 0) return;
    if (context.calls > 0 && !context.followUpSent && this.conn) {
      context.followUpSent = true;
      this.pendingResponses.push({ origin: "turn", turnId: context.turnId });
      this.conn.send({ type: "response.create" });
    }
    if (!context.hasAudio) this.responses.delete(id);
  }

  private onFinalTranscript(text: string): void {
    if (this.closed || !text.trim()) return;
    if (looksLikeHangUp(text)) {
      this.interrupt();
      this.close("user");
      return;
    }
    if (looksLikeStop(text)) {
      this.stopEverything();
      return;
    }
    // The sentence was already acted on while the provider waited out its silence: the same words change nothing; more words
    // mean the early question was cut short, so its analyst is stopped and the whole one is asked.
    const early = this.early;
    this.clearEarly();
    if (early && early.turnId === this.window.currentTurnId()) {
      if (early.said === normalizeSaid(text)) return;
      this.dropEarlyTask(early);
    }
    void this.decideAndAct(text);
  }

  private clearEarly(): void {
    if (this.earlyTimer) clearTimeout(this.earlyTimer);
    this.earlyTimer = null;
    this.partialText = "";
    this.early = null;
  }

  /** Stop the analyst started on a sentence the user then went on from, and free the turn for the whole question. */
  private dropEarlyTask(early: { turnId: string; taskId: string | null }): void {
    if (!early.taskId) return;
    this.cancelTask(early.taskId);
    this.turnTasks.delete(early.turnId);
  }

  /** A streaming transcript update: when it ends a sentence and nothing more arrives for a moment, start the analyst now. */
  private onPartial(text: string): void {
    if (this.closed || this.inputMode !== "talk") return;
    this.partialText = text.trim();
    if (this.earlyTimer) clearTimeout(this.earlyTimer);
    this.earlyTimer = null;
    if (!SENTENCE_END.test(this.partialText) || this.partialText.split(/\s+/).length < 3) return;
    this.earlyTimer = setTimeout(() => {
      this.earlyTimer = null;
      const said = normalizeSaid(this.partialText);
      const turnId = this.window.currentTurnId();
      if (!said || this.early?.said === said) return;
      if (looksLikeStop(this.partialText) || looksLikeHangUp(this.partialText)) return;
      // A longer sentence replaces the shorter one the analyst started on.
      if (this.early && this.early.turnId === turnId) this.dropEarlyTask(this.early);
      this.early = { turnId, said, taskId: null };
      void this.decideAndAct(this.partialText, true);
    }, EARLY_QUIET_MS);
  }

  private stopEverything(): void {
    this.interrupt();
    for (const tracked of this.tasks.values()) {
      if (!isTerminal(tracked.status)) this.cancelTask(tracked.id);
    }
  }

  /**
   * What a transcript's wording does not settle goes to Fastino GLiDE (null without a key, so nothing changes then): whether a
   * short utterance is a stop, and whether a data question can be handed to the analyst this instant instead of waiting for the
   * voice model to decide to. The analyst joins the one task per turn (claimTurn), so the voice model calling spawn_thinking too
   * attaches to it. Not for a follow-up that leans on earlier turns ("and those?"): the voice model words that objective.
   */
  private async decideAndAct(text: string, early = false): Promise<void> {
    const turnId = this.window.currentTurnId();
    const [stop, route] = await Promise.all([decidesStop(text), (this.opts.route ?? routeMessage)({ app: this.opts.app, question: text })]);
    if (this.closed) return;
    if (stop === true) {
      this.stopEverything();
      return;
    }
    if (!route || turnId !== this.window.currentTurnId() || LEANS_ON_BEFORE.test(text)) return;
    if (EAGER_INTENTS.has(route.intent) && route.intentConfidence >= 0.9 && route.onTopic >= 0.8) {
      const receipt = this.spawnThinking(text);
      if (early && this.early && this.early.turnId === turnId && typeof receipt.task_id === "string") this.early.taskId = receipt.task_id;
    }
  }

  private async runToolCall(call: {
    responseId: string;
    callId: string;
    name: string;
    args: unknown;
    turnId: string;
  }): Promise<void> {
    this.emit({ type: "tool.call", name: call.name, status: "started" });
    let output: ToolReceipt;
    try {
      output = await this.executeTool(call.name, call.args);
    } catch (error) {
      output = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.emit({ type: "tool.call", name: call.name, status: "done" });
    this.conn?.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(output) },
    });
    const context = this.responses.get(call.responseId);
    if (!context) return;
    context.pendingCalls = Math.max(0, context.pendingCalls - 1);
    this.settleResponse(call.responseId, context);
  }

  private async executeTool(name: string, rawArgs: unknown): Promise<ToolReceipt> {
    if (rawArgs === INVALID_JSON) return { ok: false, error: `Arguments for ${name} were not valid JSON` };
    if (isUiToolName(name)) return this.runUiTool(name, rawArgs);
    const args = record(rawArgs);
    switch (name) {
      case SPAWN_THINKING_TOOL:
        return this.spawnThinking(str(args.objective));
      case GET_TASK_STATUS_TOOL:
        return this.taskStatus(str(args.task_id) || null);
      case CANCEL_TASK_TOOL:
        return this.cancelTask(str(args.task_id) || null);
      case VIEW_SCREEN_TOOL:
        return this.viewScreen();
      default:
        return { ok: false, error: `Unknown tool ${name}` };
    }
  }

  /** Validated UI commands go to the browser; invalid ones go back to the model only. */
  private runUiTool(name: string, args: unknown): ToolReceipt {
    const result = validateUiToolCall(name, args, this.opts.app);
    if (!result.ok) return { ok: false, error: result.error };
    this.emit({ type: "ui.command", name: result.command.name, args: result.command.args });
    return { ok: true };
  }

  private viewScreen(): ToolReceipt {
    if (!this.viewState) {
      return { ok: true, screen: null, note: "The screen has not reported its state yet." };
    }
    return {
      ok: true,
      screen: this.viewState,
      reported_ms_ago: this.viewStateAt === null ? null : Date.now() - this.viewStateAt,
    };
  }

  private spawnThinking(objective: string): ToolReceipt {
    const turnId = this.window.currentTurnId();
    const decision = claimTurn(turnId ? (this.turnTasks.get(turnId) ?? null) : null);
    if (decision.action === "attach") return { status: "accepted", task_id: decision.taskId };
    const trimmed = objective.trim();
    if (!trimmed) return { status: "failed", error: "objective is required" };
    const print = fingerprint(trimmed);
    for (const tracked of this.tasks.values()) {
      if (tracked.fingerprint === print && !isTerminal(tracked.status)) {
        if (turnId) this.turnTasks.set(turnId, tracked.id);
        return { status: "duplicate", task_id: tracked.id };
      }
    }
    const abort = new AbortController();
    const tracked: TrackedTask = {
      id: randomUUID(),
      objective: trimmed,
      fingerprint: print,
      abort,
      lastProgressAt: Date.now(),
      status: "running",
      step: null,
      summary: null,
      error: null,
      sources: new Map(),
    };
    this.tasks.set(tracked.id, tracked);
    if (turnId) this.turnTasks.set(turnId, tracked.id);
    this.emit({ type: "task.updated", task: snapshot(tracked) });

    let run: Promise<{ content: string }>;
    try {
      run = this.opts.runner.run(
        { sessionId: this.id, app: this.opts.app.id, question: trimmed, view: this.viewState, signal: abort.signal },
        (event) => {
          if (tracked.status !== "running") return;
          // Every C7 agent event streams to the orb card; anything else the runner emits stays local.
          if (isAgentStreamEvent(event)) this.emit({ type: "task.event", taskId: tracked.id, event });
          if (event.type === "citation" && typeof event.id === "string" && typeof event.label === "string") tracked.sources.set(event.id, event.label);
          if (event.type === "tool_start") this.onTaskStep(tracked.id, str(event.capabilityName) || "working");
          if (event.type === "status") this.onTaskStep(tracked.id, str(event.state) || "working");
        },
      );
    } catch (error) {
      run = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    run
      .then((result) => {
        if (tracked.status !== "running") return;
        tracked.status = "completed";
        tracked.summary = result.content || null;
        tracked.step = null;
        this.onTaskSettled(tracked.id);
      })
      .catch((error: unknown) => {
        if (tracked.status !== "running") return;
        if (abort.signal.aborted) {
          tracked.status = "canceled";
        } else {
          tracked.status = "failed";
          tracked.error = error instanceof Error ? error.message : String(error);
        }
        tracked.step = null;
        this.onTaskSettled(tracked.id);
      });

    return { status: "accepted", task_id: tracked.id };
  }

  private taskStatus(taskId: string | null): ToolReceipt {
    const describe = (tracked: TrackedTask) => ({
      task_id: tracked.id,
      status: tracked.status,
      question: tracked.objective,
      step: tracked.step,
      summary: tracked.summary,
      error: tracked.error,
    });
    if (taskId) {
      const tracked = this.tasks.get(taskId);
      if (!tracked) return { status: "not_found", task_id: taskId };
      return { status: "ok", task: describe(tracked) };
    }
    const all = [...this.tasks.values()].reverse().slice(0, 20).map(describe);
    return all.length ? { status: "ok", tasks: all } : { status: "empty" };
  }

  private cancelTask(taskId: string | null): ToolReceipt {
    const target = taskId
      ? this.tasks.get(taskId)
      : [...this.tasks.values()].reverse().find((t) => !isTerminal(t.status));
    if (!target) return taskId ? { status: "not_found", task_id: taskId } : { status: "empty" };
    if (isTerminal(target.status)) return { status: "not_active", task_id: target.id, current: target.status };
    target.abort.abort();
    target.status = "canceled";
    target.step = null;
    for (let i = this.progressQueue.length - 1; i >= 0; i -= 1) {
      if (this.progressQueue[i]!.taskId === target.id) this.progressQueue.splice(i, 1);
    }
    this.emit({ type: "task.updated", task: snapshot(target) });
    return { status: "cancelled", task_id: target.id };
  }

  private onTaskStep(taskId: string, step: string): void {
    const tracked = this.tasks.get(taskId);
    if (!tracked) return;
    tracked.step = step;
    this.emit({ type: "task.updated", task: snapshot(tracked) });
    const now = Date.now();
    if (now - tracked.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
    tracked.lastProgressAt = now;
    this.progressQueue.push({ taskId, step });
    this.scheduleAnnouncements();
  }

  private onTaskSettled(taskId: string): void {
    const tracked = this.tasks.get(taskId);
    if (!tracked || this.closed) return;
    this.emit({ type: "task.updated", task: snapshot(tracked) });
    if (tracked.status === "canceled") return;
    this.announcements.push({
      taskId,
      status: tracked.status,
      objective: tracked.objective,
      result: tracked.summary,
      error: tracked.error,
      sources: [...tracked.sources].slice(0, 8).map(([id, label]) => ({ id, label })),
    });
    this.scheduleAnnouncements();
  }

  private scheduleAnnouncements(): void {
    if (this.closed || this.announceTimer) return;
    if (this.announcements.length === 0 && this.progressQueue.length === 0) return;
    if (this.window.isBlocked() || !this.conn) {
      this.announceTimer = setTimeout(() => {
        this.announceTimer = null;
        this.scheduleAnnouncements();
      }, ANNOUNCE_RETRY_MS);
      return;
    }
    this.deliverAnnouncements();
  }

  private deliverAnnouncements(): void {
    const turnId = this.window.currentTurnId();
    if (this.announcements.length > 0) {
      const batch = this.announcements.splice(0, 8);
      const finished = new Set(batch.map((b) => b.taskId));
      for (let i = this.progressQueue.length - 1; i >= 0; i -= 1) {
        if (finished.has(this.progressQueue[i]!.taskId)) this.progressQueue.splice(i, 1);
      }
      this.inject(formatResultContext(batch), RESULT_RESPONSE_INSTRUCTIONS, turnId);
      return;
    }
    const progress = this.progressQueue.shift();
    if (progress) {
      this.inject(formatProgressContext(progress.taskId, progress.step), PROGRESS_RESPONSE_INSTRUCTIONS, turnId);
    }
  }

  private inject(text: string, instructions: string, turnId: string): void {
    if (!this.conn) return;
    this.conn.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.pendingResponses.push({ origin: "announcement", turnId });
    this.conn.send({
      type: "response.create",
      response: { modalities: ["text", "audio"], tool_choice: "none", instructions },
    });
    this.setState("thinking");
  }

  /** The spoken "I'm listening" the moment the microphone goes live (once per session, not on a reconnect). */
  private greet(): void {
    if (!this.conn || this.greeted || this.opts.greet === false) return;
    this.greeted = true;
    this.pendingResponses.push({ origin: "announcement", turnId: this.nextTurnId() });
    this.conn.send({ type: "response.create", response: { modalities: ["text", "audio"], tool_choice: "none", instructions: greetingInstructions(this.opts.app, { welcome: this.opts.welcome }) } });
  }

  private nextTurnId(): string {
    this.turnCounter += 1;
    return `voice-${Date.now()}-${this.turnCounter}`;
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "voice.state", state });
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private emit(event: VoiceServerEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a dead subscriber must not break the session */
      }
    }
  }
}
