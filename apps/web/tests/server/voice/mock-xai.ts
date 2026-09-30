import type { ServerWebSocket } from "bun";

/**
 * Local stand-in for `wss://api.x.ai/v1/realtime`: accepts the relay's socket, answers
 * `session.update` with `session.updated`, records every client event, and lets a test push
 * provider events (function calls, response lifecycle) at the relay.
 */

export type ClientEvent = { type: string } & Record<string, unknown>;

export type MockXai = {
  url: string;
  received: ClientEvent[];
  authHeaders: (string | null)[];
  send(event: Record<string, unknown>): void;
  waitFor(predicate: (event: ClientEvent) => boolean, timeoutMs?: number): Promise<ClientEvent>;
  stop(): void;
};

export function startMockXai(opts: { rejectSession?: string } = {}): MockXai {
  const received: ClientEvent[] = [];
  const authHeaders: (string | null)[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  const waiters: { predicate: (e: ClientEvent) => boolean; resolve: (e: ClientEvent) => void }[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      authHeaders.push(request.headers.get("authorization"));
      if (srv.upgrade(request)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const event = JSON.parse(String(raw)) as ClientEvent;
        received.push(event);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (waiters[i]!.predicate(event)) {
            waiters[i]!.resolve(event);
            waiters.splice(i, 1);
          }
        }
        if (event.type === "session.update") {
          ws.send(
            JSON.stringify(
              opts.rejectSession
                ? { type: "error", error: { message: opts.rejectSession } }
                : { type: "session.updated", session: event.session },
            ),
          );
        }
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/v1/realtime?model=grok-voice-latest`,
    received,
    authHeaders,
    send(event) {
      for (const ws of sockets) ws.send(JSON.stringify(event));
    },
    waitFor(predicate, timeoutMs = 2_000) {
      const hit = received.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("mock xAI: timed out waiting for client event")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    stop() {
      for (const ws of sockets) ws.close();
      server.stop(true);
    },
  };
}

/** `function_call_output` items the relay sent back, parsed. */
export function toolOutputs(mock: MockXai): { callId: string; output: Record<string, unknown> }[] {
  return mock.received
    .filter((e) => e.type === "conversation.item.create")
    .map((e) => e.item as { type?: string; call_id?: string; output?: string })
    .filter((item) => item.type === "function_call_output")
    .map((item) => ({ callId: item.call_id ?? "", output: JSON.parse(item.output ?? "{}") as Record<string, unknown> }));
}

export async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
