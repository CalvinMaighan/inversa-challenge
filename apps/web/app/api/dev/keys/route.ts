import { handleGet, handlePost } from "@/server/dev-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/dev/keys: server keys set or missing, never a value (server/dev-keys.ts). */
export function GET(req: Request): Response {
  return handleGet(req, process.env);
}

/** POST /api/dev/keys: local development on loopback only, 403 otherwise (server/dev-keys.ts). */
export function POST(req: Request): Promise<Response> {
  return handlePost(req, process.env);
}
