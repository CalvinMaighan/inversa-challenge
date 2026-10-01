import { z } from "zod";

import { spendRefusal } from "@/server/agent/budget";
import { runTurn } from "@/server/agent/run-turn";
import { MISSING_KEY_MESSAGE, openRouterApiKey } from "@/server/agent/runtime/model";
import { isValidSessionId } from "@/server/agent/session";
import { rateLimited } from "@/server/rate-limit";
import { AGENT_STREAM_CONTENT_TYPE, type AgentStreamEvent, type AgentStreamRequest } from "@/shared/agent/events";
import { APP_IDS, getApp, speciesIds } from "@/shared/apps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 90 s turn cap plus slack. */
export const maxDuration = 120;

const MAX_QUESTION_CHARS = 4_000;

const bbox = z
  .object({ west: z.number(), south: z.number(), east: z.number(), north: z.number() })
  .refine((b) => b.west < b.east && b.south < b.north, "bbox needs west < east and south < north");

const requestSchema: z.ZodType<AgentStreamRequest> = z
  .object({
    app: z.enum(APP_IDS),
    // Room for the server's `<app>-` prefix within the session store's 128 characters.
    sessionId: z.string().max(110).refine(isValidSessionId, "sessionId must be 1–110 of [A-Za-z0-9_-]"),
    question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
    view: z
      .object({
        bbox,
        time: z.string().refine((value) => Number.isFinite(Date.parse(value)), "time must be ISO 8601"),
        layers: z.array(z.string().max(64)).max(64),
        species: z.array(z.string().max(64)).max(64).optional(),
        windowHours: z.number().int().min(1).max(24 * 31).optional(),
        selection: z.string().max(256).nullable(),
        // Carp view state (shared contract with the carp UI): selected site, knowledge time, replay flag.
        site: z.string().max(64).optional(),
        asOf: z.number().int().min(0).optional(),
        replay: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    // Species filter keys are the app's species; anything else is another app's.
    const allowed = new Set<string>(speciesIds(getApp(body.app)));
    body.view?.species?.forEach((key, i) => {
      if (!allowed.has(key)) ctx.addIssue({ code: "custom", path: ["view", "species", i], message: `not a species of app ${body.app}` });
    });
  });

/**
 * Every refusal is `{error, code}` JSON, never a stack trace: `error` is the sentence the chat shows as is
 * (`client/agent/chat/ndjson.ts` `errorText`), `code` is for scripts and monitors.
 */
type AgentErrorCode = "invalid_request" | "rate_limited" | "cost_cap" | "busy" | "agent_unavailable";

function jsonError(status: number, code: AgentErrorCode, error: string, extra?: Record<string, unknown>, headers?: HeadersInit): Response {
  return Response.json({ error, code, ...extra }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Turns streaming at once across all clients (`AGENT_MAX_CONCURRENT`, default 4); bounds spend overshoot too. */
const DEFAULT_MAX_CONCURRENT = 4;

function maxConcurrent(): number {
  const n = Number(process.env.AGENT_MAX_CONCURRENT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT;
}

/** The daily caps reset at 00:00 UTC. */
function secondsToUtcMidnight(now = Date.now()): number {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight.getTime() - now) / 1000));
}

/** Live turn count, on globalThis so dev module reloads share it. */
function inFlight(): { n: number } {
  const g = globalThis as unknown as { __inversaAgentInFlight?: { n: number } };
  return (g.__inversaAgentInFlight ??= { n: 0 });
}

/** POST /api/agent/stream: AgentStreamRequest in, C7 NDJSON out (one event per line, ending in `done`). */
export async function POST(request: Request): Promise<Response> {
  // Before anything else: a flood of bad requests is still a flood.
  const limited = rateLimited(request, "agent");
  if (limited) return limited;
  // JSON only. A cross-site page can make a visitor's browser POST text/plain or a form without a preflight, which
  // would spend this site's agent budget from many addresses; application/json needs a preflight, which fails here
  // (no CORS headers), so only same-origin pages and non-browser clients get through.
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return jsonError(415, "invalid_request", "Send the question as application/json.");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Invalid JSON body");
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request", "Invalid agent request", { issues: parsed.error.issues });
  // A used-up daily cap (tokens, all apps' dollars, or this app's dollars) refuses before any model call.
  const overSpend = spendRefusal(parsed.data.app);
  if (overSpend) return jsonError(429, "cost_cap", overSpend.message, { cap: overSpend.cap }, { "Retry-After": String(secondsToUtcMidnight()) });
  // No key, no agent: say so before streaming, never fall back to anything else.
  if (!openRouterApiKey()) return jsonError(503, "agent_unavailable", MISSING_KEY_MESSAGE);
  const live = inFlight();
  if (live.n >= maxConcurrent()) {
    return jsonError(503, "busy", "The agent is answering other questions right now. Try again in a few seconds.", undefined, { "Retry-After": "5" });
  }
  live.n += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    live.n -= 1;
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: AgentStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true; // Client went away.
        }
      };
      void (async () => {
        try {
          await runTurn({ ...parsed.data, signal: request.signal }, send);
        } catch (error) {
          // The message only, never the stack; the stack goes to the server log.
          console.error("[agent] turn failed", error);
          send({ type: "error", message: error instanceof Error ? error.message : "Agent turn failed" });
          send({ type: "done", content: "" });
        } finally {
          release();
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": `${AGENT_STREAM_CONTENT_TYPE}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
