import { handleEvents } from "server/voice/http";
import { voiceRegistry } from "server/voice/voice-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** NDJSON stream of `VoiceServerEvent`s, token-authenticated. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handleEvents(request, id, voiceRegistry());
}
