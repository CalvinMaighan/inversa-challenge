import {
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_OUTPUT_SAMPLE_RATE,
  VOICE_TOKEN_HEADER,
  type VoiceServerEvent,
  type VoiceSessionOpenResponse,
} from "shared/voice/protocol";
import { APP_IDS, getApp, isAppId } from "shared/apps";

import { clientIp } from "../rate-limit";
import { isVoiceControlMessage } from "./view-state-control";
import type { VoiceSessionRegistry } from "./voice-sessions";

/**
 * Request handlers behind `app/api/voice/session/**`. The route files only bind these to the
 * process registry, so tests can drive the same code with their own registry.
 */

/** 200 ms of PCM16 at 16 kHz is 6.4 KB (8.5 KB base64); allow a generous multiple for coalesced batches. */
export const MAX_AUDIO_CHARS = 256 * 1024;
export const MAX_TEXT_CHARS = 4_000;
/** Blank NDJSON line so idle proxies keep the events stream open. */
const EVENTS_KEEPALIVE_MS = 20_000;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

const notFound = () => json({ error: "Voice session not found" }, 404);

/** First `X-Forwarded-For` hop (Caddy sets it), then `X-Real-IP`, else one shared local bucket. */
export { clientIp };

/** `POST /api/voice/session?app=<id>`: the session runs in that app (persona, tools, scope). */
export async function handleOpenSession(request: Request, registry: VoiceSessionRegistry): Promise<Response> {
  const app = new URL(request.url).searchParams.get("app");
  if (!isAppId(app)) return json({ error: "unknown_app", apps: APP_IDS }, 404);
  const result = await registry.open(clientIp(request), getApp(app));
  if (!result.ok) {
    const headers: Record<string, string> = result.retryAfterSeconds ? { "Retry-After": String(result.retryAfterSeconds) } : {};
    return json({ error: result.error }, result.status, headers);
  }
  const payload: VoiceSessionOpenResponse = {
    sessionId: result.session.id,
    token: result.session.token,
    inputSampleRate: VOICE_INPUT_SAMPLE_RATE,
    outputSampleRate: VOICE_OUTPUT_SAMPLE_RATE,
  };
  return json(payload);
}

export async function handleAudio(request: Request, id: string, registry: VoiceSessionRegistry): Promise<Response> {
  const session = registry.get(id, request.headers.get(VOICE_TOKEN_HEADER));
  if (!session) return notFound();
  const body = (await request.json().catch(() => null)) as { audio?: unknown } | null;
  const audio = typeof body?.audio === "string" ? body.audio : "";
  if (!audio) return json({ error: "Missing audio" }, 400);
  if (audio.length > MAX_AUDIO_CHARS) return json({ error: "Audio batch too large" }, 413);
  session.appendAudio(audio);
  return new Response(null, { status: 204 });
}

export async function handleControl(request: Request, id: string, registry: VoiceSessionRegistry): Promise<Response> {
  const session = registry.get(id, request.headers.get(VOICE_TOKEN_HEADER));
  if (!session) return notFound();
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isVoiceControlMessage(body)) return json({ error: "Invalid control request" }, 400);
  switch (body.type) {
    case "interrupt":
      session.interrupt();
      break;
    case "text":
      if (body.text.length > MAX_TEXT_CHARS) return json({ error: "Text too long" }, 400);
      session.sendText(body.text);
      break;
    case "playback":
      session.playbackReceipt(body.responseId, body.state);
      break;
    case "close":
      session.close("user");
      break;
    case "mode":
      session.setInputMode(body.mode);
      break;
    case "view_state":
      session.setViewState(body.state);
      break;
  }
  return new Response(null, { status: 204 });
}

/**
 * NDJSON stream of voice events. Do not listen to `request.signal`: Next aborts it when the
 * handler returns, which would close this stream at once.
 */
export function handleEvents(request: Request, id: string, registry: VoiceSessionRegistry): Response {
  const session = registry.get(id, request.headers.get(VOICE_TOKEN_HEADER));
  if (!session) return notFound();

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    unsubscribe();
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeStream = () => {
        stop();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      unsubscribe = session.subscribe((event: VoiceServerEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          stop();
          return;
        }
        if (event.type === "session.closed") closeStream();
      });
      if (session.isClosed) {
        closeStream();
        return;
      }
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          stop();
        }
      }, EVENTS_KEEPALIVE_MS);
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
