import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

/**
 * Thin xAI Grok Voice WebSocket client (ported from deedee). OpenAI-style realtime envelope:
 * `session.update`, `input_audio_buffer.append`, `conversation.item.create`, `response.create`,
 * `response.cancel`. The API key stays on the server.
 */

/**
 * The `ws` module, loaded at run time and left out of the bundle: the production server runs on Bun, which supplies its own
 * native `ws`; the pure-JS copy the bundler would inline closed every connection to xAI with code 1006 there (the standalone
 * server's chunks held it). Under Node (dev, tests) the installed package loads as usual.
 */
async function loadWebSocket(): Promise<typeof import("ws").default> {
  const mod = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "ws");
  return mod.default;
}

/** `WS_OPEN`. */
const WS_OPEN = 1;

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

  async connect(): Promise<void> {
    const WS = await loadWebSocket();
    return new Promise((resolve, reject) => {
      const ws = new WS(this.target.url, {
        headers: { Authorization: `Bearer ${this.target.apiKey}` },
      });
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("Timed out connecting to Grok Voice"));
        ws.terminate();
      }, CONNECT_TIMEOUT_MS);

      this.ping = setInterval(() => {
        if (ws.readyState === WS_OPEN) ws.ping();
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
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(JSON.stringify({ event_id: `event_${randomUUID().replaceAll("-", "")}`, ...payload }));
  }

  isOpen(): boolean {
    return Boolean(this.ws && this.ws.readyState === WS_OPEN);
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
