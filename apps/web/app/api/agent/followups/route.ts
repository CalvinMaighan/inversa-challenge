import { z } from "zod";

import { suggestFollowUps } from "@/server/agent/followups";
import { APP_IDS, getApp } from "@/shared/apps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  app: z.enum(APP_IDS),
  question: z.string().max(4_000).default(""),
  answer: z.string().min(1).max(8_000),
  asked: z.array(z.string().max(300)).max(40).optional(),
});

/** Questions to offer after an answer; `{ items: [] }` when Fastino is not configured or does not answer. */
export async function POST(request: Request): Promise<Response> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return Response.json({ items: [] }, { status: 415 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ items: [] }, { status: 400 });
  const { app, question, answer, asked } = parsed.data;
  const items = await suggestFollowUps({ app: getApp(app), question, answer, asked, signal: request.signal });
  return Response.json({ items }, { headers: { "cache-control": "no-store" } });
}
