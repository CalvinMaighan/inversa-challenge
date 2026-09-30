import { handleAudio } from "server/voice/http";
import { voiceRegistry } from "server/voice/voice-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Microphone batches `{ audio: base64 PCM16 16 kHz }`, token-authenticated. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handleAudio(request, id, voiceRegistry());
}
