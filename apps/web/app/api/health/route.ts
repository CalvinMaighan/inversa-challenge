import { health } from "@/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health: the web tier's view of its dependencies (server/health.ts). 503 only when the data path is down. */
export async function GET(): Promise<Response> {
  const body = await health();
  return Response.json(body, { status: body.status === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
