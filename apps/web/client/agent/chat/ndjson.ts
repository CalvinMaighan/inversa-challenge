import { isAgentStreamEvent, type AgentStreamEvent, type AgentStreamRequest } from "shared/agent/events";

/** T13's route (PLAN.md C7). */
export const AGENT_STREAM_URL = "/api/agent/stream";

/**
 * NDJSON reader, ported from deedee `useAskNdjsonStream`: split on newlines across chunk boundaries, skip
 * blank and malformed lines, and drop anything outside the C7 union.
 */
export async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (event: AgentStreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (isAgentStreamEvent(parsed)) onEvent(parsed);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) emit(line);
  }
  buffer += decoder.decode();
  emit(buffer);
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

/** Readable message from a failed response: the route's `{ error }` JSON, else the first 400 chars of text. */
async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const json = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const message = json.error ?? json.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON.
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 400) || `Agent request failed (${res.status})`;
}

export type StreamResult = { ok: true } | { ok: false; aborted: boolean; error: string };

/** POST one question and feed each event to `onEvent` as it arrives. Never throws. */
export async function streamAgentTurn(params: {
  url?: string;
  request: AgentStreamRequest;
  signal: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void;
  fetchImpl?: typeof fetch;
}): Promise<StreamResult> {
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(params.url ?? AGENT_STREAM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.request),
      signal: params.signal,
    });
    if (!res.ok) return { ok: false, aborted: false, error: await errorText(res) };
    if (!res.body) return { ok: false, aborted: false, error: "No response stream" };
    await readNdjson(res.body, params.onEvent);
    return { ok: true };
  } catch (error) {
    if (isAbortError(error) || params.signal.aborted) return { ok: false, aborted: true, error: "" };
    return { ok: false, aborted: false, error: error instanceof Error ? error.message : "Could not reach the agent." };
  }
}
