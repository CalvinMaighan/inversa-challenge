import { z } from "zod";

import { runTurn } from "@/server/agent/run-turn";
import { MISSING_KEY_MESSAGE, openRouterApiKey } from "@/server/agent/runtime/model";
import { isValidSessionId } from "@/server/agent/session";
import { rateLimited } from "@/server/rate-limit";
import { AGENT_STREAM_CONTENT_TYPE, type AgentStreamEvent, type AgentStreamRequest } from "@/shared/agent/events";
import { SPECIES_IDS } from "@/shared/voice/ui-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 90 s turn cap plus slack. */
export const maxDuration = 120;

const MAX_QUESTION_CHARS = 4_000;

const bbox = z
  .object({ west: z.number(), south: z.number(), east: z.number(), north: z.number() })
  .refine((b) => b.west < b.east && b.south < b.north, "bbox needs west < east and south < north");

const requestSchema: z.ZodType<AgentStreamRequest> = z.object({
  sessionId: z.string().refine(isValidSessionId, "sessionId must be 1–128 of [A-Za-z0-9_-]"),
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  view: z
    .object({
      bbox,
      time: z.string().refine((value) => Number.isFinite(Date.parse(value)), "time must be ISO 8601"),
      layers: z.array(z.string().max(64)).max(64),
      species: z.array(z.enum([...SPECIES_IDS, "animals", "plants", "others", "other"])).max(8).optional(),
      windowHours: z.number().int().min(1).max(24 * 31).optional(),
      selection: z.string().max(256).nullable(),
    })
    .optional(),
});

function jsonError(status: number, error: string, issues?: unknown): Response {
  return Response.json({ error, ...(issues ? { issues } : {}) }, { status });
}

/** POST /api/agent/stream: AgentStreamRequest in, C7 NDJSON out (one event per line, ending in `done`). */
export async function POST(request: Request): Promise<Response> {
  // Before anything else: a flood of bad requests is still a flood.
  const limited = rateLimited(request, "agent");
  if (limited) return limited;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "Invalid agent request", parsed.error.issues);
  // No key, no agent: say so before streaming, never fall back to anything else.
  if (!openRouterApiKey()) return jsonError(503, MISSING_KEY_MESSAGE);

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
          send({ type: "error", message: error instanceof Error ? error.message : "Agent turn failed" });
          send({ type: "done", content: "" });
        } finally {
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
