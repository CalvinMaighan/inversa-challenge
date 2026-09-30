import { describe, expect, test } from "bun:test";

import { readNdjson, streamAgentTurn } from "client/agent/chat/ndjson";
import type { AgentStreamEvent, AgentStreamRequest } from "shared/agent/events";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const REQUEST: AgentStreamRequest = { sessionId: "s1", question: "q" };

describe("NDJSON reader", () => {
  test("reassembles lines split across chunks and skips junk", async () => {
    const events: AgentStreamEvent[] = [];
    await readNdjson(
      streamOf([
        '{"type":"status","sta',
        'te":"thinking"}\n\n{"type":"content_delta","text":"a',
        '\\nb"}\nnot json\n{"type":"mystery"}\n{"type":"citation","id":"sighting:1","kind":"sighting","label":"x"}\n',
        '{"type":"done","content":"a\\nb"}',
      ]),
      (event) => events.push(event),
    );
    expect(events).toEqual([
      { type: "status", state: "thinking" },
      { type: "content_delta", text: "a\nb" },
      { type: "citation", id: "sighting:1", kind: "sighting", label: "x" },
      { type: "done", content: "a\nb" },
    ]);
  });

  test("multi-byte characters split between chunks survive", async () => {
    const bytes = new TextEncoder().encode('{"type":"content_delta","text":"10.4 °C"}\n');
    const cut = bytes.indexOf(0xc2) + 1;
    const events: AgentStreamEvent[] = [];
    await readNdjson(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      }),
      (event) => events.push(event),
    );
    expect(events).toEqual([{ type: "content_delta", text: "10.4 °C" }]);
  });

  test("posts the request and streams events", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(streamOf(['{"type":"done","content":"ok"}\n']), { headers: { "Content-Type": "application/x-ndjson" } });
    }) as unknown as typeof fetch;
    const events: AgentStreamEvent[] = [];
    const result = await streamAgentTurn({ request: REQUEST, signal: new AbortController().signal, onEvent: (e) => events.push(e), fetchImpl });
    expect(result).toEqual({ ok: true });
    expect(sent!).toEqual({ url: "/api/agent/stream", body: REQUEST });
    expect(events).toEqual([{ type: "done", content: "ok" }]);
  });

  test("a 400 surfaces the route's error message", async () => {
    const fetchImpl = (async () => Response.json({ error: "Invalid agent request", issues: [] }, { status: 400 })) as unknown as typeof fetch;
    const result = await streamAgentTurn({ request: REQUEST, signal: new AbortController().signal, onEvent: () => {}, fetchImpl });
    expect(result).toEqual({ ok: false, aborted: false, error: "Invalid agent request" });
  });

  test("a non-JSON failure falls back to its text, then the status", async () => {
    const text = (async () => new Response("  upstream\n down ", { status: 502 })) as unknown as typeof fetch;
    expect(await streamAgentTurn({ request: REQUEST, signal: new AbortController().signal, onEvent: () => {}, fetchImpl: text })).toEqual({
      ok: false,
      aborted: false,
      error: "upstream down",
    });
    const empty = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await streamAgentTurn({ request: REQUEST, signal: new AbortController().signal, onEvent: () => {}, fetchImpl: empty })).toEqual({
      ok: false,
      aborted: false,
      error: "Agent request failed (503)",
    });
  });

  test("abort reports aborted, network failure reports the error", async () => {
    const abort = new AbortController();
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))) as unknown as typeof fetch;
    const pending = streamAgentTurn({ request: REQUEST, signal: abort.signal, onEvent: () => {}, fetchImpl: hanging });
    abort.abort();
    expect(await pending).toEqual({ ok: false, aborted: true, error: "" });

    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await streamAgentTurn({ request: REQUEST, signal: new AbortController().signal, onEvent: () => {}, fetchImpl: offline })).toEqual({
      ok: false,
      aborted: false,
      error: "Failed to fetch",
    });
  });
});
