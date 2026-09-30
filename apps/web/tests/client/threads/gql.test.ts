import { describe, expect, test } from "bun:test";

import { backoffMs } from "client/threads/gql/backoff";
import { DEV_WS_URL, postGraphql, resolveWsUrl, SubscriptionClient, type WsLike } from "client/threads/gql/client";
import { GqlRpcClient, serveGqlRpc, type GqlHandlers } from "client/threads/gql/protocol";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("backoff and urls", () => {
  test("backoff doubles from 1 s and caps at 30 s", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(6)).toBe(30_000);
    expect(backoffMs(50)).toBe(30_000);
  });

  test("ws url: explicit, then dev Axum, then the page origin", () => {
    const location = { protocol: "https:", host: "ops.example" };
    expect(resolveWsUrl({ explicit: "ws://x/y", dev: true, location })).toBe("ws://x/y");
    expect(resolveWsUrl({ dev: true, location })).toBe(DEV_WS_URL);
    expect(resolveWsUrl({ dev: false, location })).toBe("wss://ops.example/v1/graphql");
    expect(resolveWsUrl({ dev: false, location: { protocol: "http:", host: "localhost:3050" } })).toBe("ws://localhost:3050/v1/graphql");
  });

});

describe("postGraphql", () => {
  test("returns data, surfaces errors, and marks network failures", async () => {
    const ok = await postGraphql("/g", "{ a }", { x: 1 }, async (_u, init) => {
      expect(JSON.parse(init.body as string)).toEqual({ query: "{ a }", variables: { x: 1 } });
      return new Response(JSON.stringify({ data: { a: 1 } }), { status: 200 });
    });
    expect(ok).toEqual({ data: { a: 1 }, status: 200 });
    const bad = await postGraphql("/g", "{ a }", {}, async () => new Response("<html>", { status: 502 }));
    expect(bad.errors?.[0]?.message).toMatch(/502/);
    const down = await postGraphql("/g", "{ a }", {}, async () => Promise.reject(new Error("ECONNREFUSED")));
    expect(down).toEqual({ errors: [{ message: "ECONNREFUSED", extensions: { network: true } }], status: 0 });
    const http500 = await postGraphql("/g", "{ a }", {}, async () => new Response("{}", { status: 500 }));
    expect(http500.errors?.[0]?.message).toBe("graphql http 500");
  });
});

/** A scriptable socket: the test plays the server. */
class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: { id?: string; type: string; payload?: unknown }[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string, readonly protocol: string) {
    FakeWs.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverDrop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

describe("SubscriptionClient", () => {
  test("handshake, subscribe, next, ping/pong, complete", () => {
    FakeWs.all = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const statuses: string[] = [];
    const client = new SubscriptionClient({ url: "ws://x", connect: (u, p) => new FakeWs(u, p), onStatus: (s) => statuses.push(s), setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} });
    const got: unknown[] = [];
    const off = client.subscribe("subscription { feeds { source } }", {}, { next: (d) => got.push(d), complete: () => got.push("done") });
    const ws = FakeWs.all[0]!;
    expect(ws.protocol).toBe("graphql-transport-ws");
    ws.serverOpen();
    expect(ws.sent).toEqual([{ type: "connection_init" }]);
    ws.serverSend({ type: "connection_ack" });
    expect(ws.sent[1]).toEqual({ id: "1", type: "subscribe", payload: { query: "subscription { feeds { source } }", variables: {} } });
    ws.serverSend({ id: "1", type: "next", payload: { data: { feeds: { source: "nws" } } } });
    ws.serverSend({ type: "ping" });
    expect(ws.sent[2]).toEqual({ type: "pong" });
    expect(got).toEqual([{ feeds: { source: "nws" } }]);
    expect(statuses).toEqual(["connecting", "open"]);
    off();
    expect(ws.sent[3]).toEqual({ id: "1", type: "complete" });
    expect(client.subscriptionCount).toBe(0);
    client.close();
    expect(statuses.at(-1)).toBe("closed");
  });

  test("reconnects with backoff, re-subscribes live subscriptions, resets on ack", () => {
    FakeWs.all = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const client = new SubscriptionClient({ url: "ws://x", connect: (u, p) => new FakeWs(u, p), setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} });
    const errors: string[] = [];
    client.subscribe("subscription { a }", { v: 1 }, { next: () => {}, error: (e) => errors.push(e.message) });
    FakeWs.all[0]!.serverOpen();
    FakeWs.all[0]!.serverSend({ type: "connection_ack" });
    FakeWs.all[0]!.serverDrop();
    expect(client.status).toBe("closed");
    expect(client.reconnectAttempts).toBe(1);
    expect(timers.map((t) => t.ms)).toEqual([1_000]);
    timers.shift()!.fn();
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1]!.serverDrop();
    expect(timers.map((t) => t.ms)).toEqual([2_000]);
    timers.shift()!.fn();
    const ws = FakeWs.all[2]!;
    ws.serverOpen();
    ws.serverSend({ type: "connection_ack" });
    expect(client.reconnectAttempts).toBe(0);
    expect(ws.sent).toEqual([{ type: "connection_init" }, { id: "1", type: "subscribe", payload: { query: "subscription { a }", variables: { v: 1 } } }]);
    // Transport drops never reach the sink as errors; server errors do.
    expect(errors).toEqual([]);
    ws.serverSend({ id: "1", type: "error", payload: [{ message: "unknown field" }] });
    expect(errors).toEqual(["unknown field"]);
    client.close();
  });

  test("a subscription added while open is sent immediately; after close nothing reconnects", () => {
    FakeWs.all = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const client = new SubscriptionClient({ url: "ws://x", connect: (u, p) => new FakeWs(u, p), setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} });
    client.subscribe("subscription { a }", {}, { next: () => {} });
    const ws = FakeWs.all[0]!;
    ws.serverOpen();
    ws.serverSend({ type: "connection_ack" });
    client.subscribe("subscription { b }", {}, { next: () => {} });
    expect(ws.sent.at(-1)).toEqual({ id: "2", type: "subscribe", payload: { query: "subscription { b }", variables: {} } });
    client.close();
    expect(ws.readyState).toBe(3);
    expect(timers).toEqual([]);
    expect(() => client.subscribe("subscription { c }", {}, { next: () => {} })).toThrow(/closed/);
  });
});

describe("GqlRpc over a MessageChannel", () => {
  function pair() {
    const { port1, port2 } = new MessageChannel();
    const calls: string[] = [];
    let sinkRef: { next(d: unknown): void; error?(e: Error): void; complete?(): void } | null = null;
    const handlers: GqlHandlers = {
      async request(query, variables, signal) {
        calls.push(query);
        if (query === "slow") {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(resolve, 50);
          });
          return signal.aborted ? { errors: [{ message: "server saw abort" }] } : { data: "late" };
        }
        if (query === "boom") throw new Error("handler exploded");
        return { data: { echo: variables } };
      },
      subscribe(_query, _variables, sink) {
        sinkRef = sink;
        return () => {
          sinkRef = null;
        };
      },
    };
    const detach = serveGqlRpc(port2, handlers);
    const client = new GqlRpcClient(port1, "t");
    return { client, calls, detach, sink: () => sinkRef, ports: [port1, port2] };
  }

  test("request/response with ids, thrown handler errors become GraphQL errors", async () => {
    const { client, calls, detach, ports } = pair();
    const [a, b] = await Promise.all([client.request("{ a }", { n: 1 }), client.request("{ b }", { n: 2 })]);
    expect(a).toEqual({ data: { echo: { n: 1 } } });
    expect(b).toEqual({ data: { echo: { n: 2 } } });
    expect(calls).toEqual(["{ a }", "{ b }"]);
    expect(await client.request("boom")).toEqual({ errors: [{ message: "handler exploded" }] });
    client.close();
    detach();
    ports.forEach((p) => p.close());
  });

  test("abort resolves the caller at once and cancels the handler's signal", async () => {
    const { client, detach, ports } = pair();
    const ac = new AbortController();
    const p = client.request("slow", {}, ac.signal);
    ac.abort();
    expect(await p).toEqual({ errors: [{ message: "aborted" }] });
    expect(await client.request("{ x }", {}, AbortSignal.abort())).toEqual({ errors: [{ message: "aborted" }] });
    await tick();
    client.close();
    detach();
    ports.forEach((p) => p.close());
  });

  test("subscriptions fan out next, error and complete; unsubscribe detaches the server sink", async () => {
    const { client, detach, sink, ports } = pair();
    const got: string[] = [];
    const off = client.subscribe("subscription { s }", {}, { next: (d) => got.push(`next:${JSON.stringify(d)}`), error: (e) => got.push(`err:${e.message}`), complete: () => got.push("done") });
    await tick();
    expect(sink()).not.toBeNull();
    sink()!.next({ s: 1 });
    sink()!.error?.(new Error("bad"));
    await tick();
    expect(got).toEqual(["next:{\"s\":1}", "err:bad"]);
    off();
    await tick();
    expect(sink()).toBeNull();
    const off2 = client.subscribe("subscription { s }", {}, { next: () => {}, complete: () => got.push("done2") });
    await tick();
    sink()!.complete?.();
    await tick();
    expect(got.at(-1)).toBe("done2");
    off2();
    client.close();
    detach();
    ports.forEach((p) => p.close());
  });

  test("closing the client settles pending requests", async () => {
    const { client, detach, ports } = pair();
    const p = client.request("slow");
    client.close();
    expect(await p).toEqual({ errors: [{ message: "gql client closed" }] });
    detach();
    ports.forEach((p) => p.close());
  });
});
