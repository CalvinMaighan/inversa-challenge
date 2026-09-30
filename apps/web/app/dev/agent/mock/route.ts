import { GOLDEN, replayScript } from "@/eval/golden";
import { setMockScript } from "@/server/agent/cordis/plugins/mock-llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /dev/agent/mock: load the eval's golden replay plans into the mock LLM, so `/api/agent/stream` under
 * `AGENT_HARNESS=mock` answers the golden questions with real tool calls and verified citations (T14 e2e).
 * 404 unless the mock harness is on.
 */
export async function POST(): Promise<Response> {
  if (process.env.AGENT_HARNESS?.trim() !== "mock") return new Response("not found", { status: 404 });
  for (const golden of GOLDEN) setMockScript(golden.question, replayScript(golden));
  return Response.json({ scripted: GOLDEN.map((golden) => golden.question) });
}
