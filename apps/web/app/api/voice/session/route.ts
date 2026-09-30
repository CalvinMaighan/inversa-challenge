import { handleOpenSession } from "server/voice/http";
import { voiceRegistry } from "server/voice/voice-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open a voice session: checks the caps (429 over one), connects Grok Voice, returns the per-session token. */
export async function POST(request: Request): Promise<Response> {
  return handleOpenSession(request, voiceRegistry());
}
