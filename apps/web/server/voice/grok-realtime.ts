import { randomUUID } from "node:crypto";

import WebSocket from "ws";

/**
 * Thin xAI Grok Voice WebSocket client (ported from deedee). OpenAI-style realtime envelope:
 * `session.update`, `input_audio_buffer.append`, `conversation.item.create`, `response.create`,
 * `response.cancel`. The API key stays on the server.
 */

export const VOICE_REALTIME_MODEL = "grok-voice-latest";
export const VOICE_REALTIME_VOICE = "eve";
export const GROK_REALTIME_URL = `wss://api.x.ai/v1/realtime?model=${VOICE_REALTIME_MODEL}`;

const CONNECT_TIMEOUT_MS = 10_000;
const PING_MS = 15_000;

export type RealtimeEvent = { type: string } & Record<string, unknown>;

export type RealtimeTarget = { url: string; apiKey: string };

export function xaiRealtimeApiKey(): string | null {
  const key = process.env.XAI_API_KEY?.trim();
  return key || null;
}

/** Production target, or null when `XAI_API_KEY` is unset. */
export function defaultRealtimeTarget(): RealtimeTarget | null {
  const apiKey = xaiRealtimeApiKey();
  return apiKey ? { url: GROK_REALTIME_URL, apiKey } : null;
}

export function isRealtimeFatal(reason: string): boolean {
  return /invalid[_ -]?api[_ -]?key|authentication failed|unauthorized|accessdenied|model[_ -]?not[_ -]?found|model denied|not eligible/i.test(
    reason,
  );
}

export type RealtimeConnectionHandlers = {
  onEvent: (event: RealtimeEvent) => void;
  onClose: (reason: string) => void;
};

export class RealtimeConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly target: RealtimeTarget,
    private readonly handlers: RealtimeConnectionHandlers,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.target.url, {
        headers: { Authorization: `Bearer ${this.target.apiKey}` },
      });
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("Timed out connecting to Grok Voice"));
        ws.terminate();
      }, CONNECT_TIMEOUT_MS);

      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_MS);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("message", (data) => {
        let event: RealtimeEvent | null = null;
        try {
          event = JSON.parse(data.toString()) as RealtimeEvent;
        } catch {
          return;
        }
        if (event && typeof event.type === "string") this.handlers.onEvent(event);
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        if (this.ping) clearInterval(this.ping);
        if (!this.closed) reject(error);
        this.handlers.onEvent({ type: "error", error: { message: error.message } });
      });
      ws.on("close", (code, reason) => {
        clearTimeout(timer);
        if (this.ping) clearInterval(this.ping);
        if (this.closed) return;
        this.closed = true;
        this.handlers.onClose(`${code}${reason.length ? ` ${reason.toString()}` : ""}`);
      });
    });
  }

  send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event_id: `event_${randomUUID().replaceAll("-", "")}`, ...payload }));
  }

  isOpen(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}
