import { observationPlace } from "@/server/places/observation-place";
import { clientIp, SlidingWindowLimiter } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A card opens one lookup; sixty a minute per address is more than a person can open. */
const limiter = new SlidingWindowLimiter(60);

/** `GET /api/place?source=inat|gbif&id=<record id>`: the place name the source gives that record, `{ place: null }` when it has none. */
export async function GET(request: Request): Promise<Response> {
  const decision = limiter.hit(clientIp(request));
  if (!decision.ok) return Response.json({ place: null }, { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } });
  const params = new URL(request.url).searchParams;
  const source = params.get("source");
  const id = params.get("id") ?? "";
  if ((source !== "inat" && source !== "gbif") || !/^\d{1,15}$/.test(id)) return Response.json({ place: null }, { status: 400 });
  const place = await observationPlace({ source, id });
  return Response.json({ place }, { headers: { "cache-control": "public, max-age=86400" } });
}
