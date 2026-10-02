import { handleControl } from "server/voice/http";
import { voiceRegistry } from "server/voice/voice-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Interrupt, typed text, playback receipts, input mode, close, and the local `view_state` extension. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handleControl(request, id, voiceRegistry());
}
