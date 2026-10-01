import { rateLimited } from "server/rate-limit";
import { handleOpenSession } from "server/voice/http";
import { voiceRegistry } from "server/voice/voice-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open a voice session: the per-IP request limit (10 a minute), then the voice caps (429 over one), then
 * Grok Voice; returns the per-session token.
 */
export async function POST(request: Request): Promise<Response> {
  return rateLimited(request, "voice") ?? handleOpenSession(request, voiceRegistry());
}
