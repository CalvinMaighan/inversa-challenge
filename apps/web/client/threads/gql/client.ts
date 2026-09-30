/**
 * GraphQL over HTTP and graphql-transport-ws, as the gql worker runs them. `WebSocket` and `fetch` are
 * injectable so the reconnect logic runs under bun against fakes.
 */
import { backoffMs } from "./backoff";
import type { GqlResult, GqlVariables, Sink, SocketStatus } from "./protocol";

export const GRAPHQL_HTTP_PATH = "/v1/graphql";
export const WS_PROTOCOL = "graphql-transport-ws";
/** Axum's dev bind (PLAN.md C13). Next does not proxy WebSockets, so dev connects straight to it. */
export const DEV_WS_URL = "ws://127.0.0.1:4041/v1/graphql";

export type ResolveWsOptions = {
  explicit?: string;
  dev: boolean;
  location: { protocol: string; host: string };
};

/** `NEXT_PUBLIC_INVERSA_WS_URL` wins; dev falls back to Axum directly; prod rides the page origin (Caddy). */
export function resolveWsUrl({ explicit, dev, location }: ResolveWsOptions): string {
  if (explicit) return explicit;
  if (dev) return DEV_WS_URL;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${GRAPHQL_HTTP_PATH}`;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function postGraphql(url: string, query: string, variables: GqlVariables, fetchImpl: FetchLike, signal?: AbortSignal): Promise<GqlResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err), extensions: { network: true } }], status: 0 };
  }
  let body: GqlResult;
  try {
    body = (await res.json()) as GqlResult;
  } catch {
    return { errors: [{ message: `graphql http ${res.status}: not JSON` }], status: res.status };
  }
  if (!res.ok && !body.errors?.length) body.errors = [{ message: `graphql http ${res.status}` }];
  body.status = res.status;
  return body;
}

// ---- graphql-transport-ws ------------------------------------------------------------------

export type WsLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type WsFactory = (url: string, protocol: string) => WsLike;

export type SubscriptionClientOptions = {
  url: string;
  /** Defaults to the global `WebSocket`. */
  connect?: WsFactory;
  onStatus?: (status: SocketStatus) => void;
  /** Injected timer for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Idle sockets (no subscriptions) close after this many ms; 0 keeps them open. */
  idleCloseMs?: number;
};

type WireMessage = { id?: string; type: string; payload?: unknown };

const WS_OPEN = 1;

/**
 * One socket, many subscriptions. Reconnects with backoff and re-subscribes everything live; a
 * subscription's sink sees `error` on server errors only, never on transport drops (those are retried).
 */
export class SubscriptionClient {
  private ws: WsLike | null = null;
  private acked = false;
  private attempt = 0;
  private timer: unknown = null;
  private idleTimer: unknown = null;
  private closed = false;
  private seq = 0;
  private readonly subs = new Map<string, { query: string; variables: GqlVariables; sink: Sink }>();
  private readonly connectImpl: WsFactory;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  status: SocketStatus = "closed";

  constructor(private readonly options: SubscriptionClientOptions) {
    this.connectImpl = options.connect ?? ((url, protocol) => new WebSocket(url, protocol) as unknown as WsLike);
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get reconnectAttempts(): number {
    return this.attempt;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.options.onStatus?.(s);
  }

  private open(): void {
    if (this.closed || this.ws) return;
    this.setStatus("connecting");
    let ws: WsLike;
    try {
      ws = this.connectImpl(this.options.url, WS_PROTOCOL);
    } catch (err) {
      console.warn("[threads/gql] websocket construct failed", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init" }));
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.acked = false;
      this.setStatus("closed");
      if (!this.closed && this.subs.size > 0) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer !== null) return;
    this.attempt += 1;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.open();
    }, backoffMs(this.attempt));
  }

  private onMessage(raw: unknown): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(String(raw)) as WireMessage;
    } catch {
      return;
    }
    const ws = this.ws;
    if (!ws) return;
    switch (msg.type) {
      case "connection_ack":
        this.acked = true;
        this.attempt = 0;
        this.setStatus("open");
        for (const [id, s] of this.subs) ws.send(JSON.stringify({ id, type: "subscribe", payload: { query: s.query, variables: s.variables } }));
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      case "next": {
        const s = msg.id ? this.subs.get(msg.id) : undefined;
        const payload = msg.payload as GqlResult | undefined;
        if (s && payload && payload.data !== undefined) s.sink.next(payload.data);
        else if (s && payload?.errors?.length) s.sink.error?.(new Error(payload.errors.map((e) => e.message).join("; ")));
        return;
      }
      case "error": {
        const s = msg.id ? this.subs.get(msg.id) : undefined;
        if (!s) return;
        const errors = Array.isArray(msg.payload) ? (msg.payload as { message?: string }[]) : [];
        s.sink.error?.(new Error(errors.map((e) => e.message ?? "subscription error").join("; ") || "subscription error"));
        return;
      }
      case "complete": {
        const s = msg.id ? this.subs.get(msg.id) : undefined;
        if (!s || !msg.id) return;
        this.subs.delete(msg.id);
        s.sink.complete?.();
        this.maybeIdle();
        return;
      }
      default:
        return;
    }
  }

  private maybeIdle(): void {
    if (this.subs.size > 0 || !this.ws || !this.options.idleCloseMs) return;
    if (this.idleTimer !== null) this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (this.subs.size === 0 && this.ws) {
        const ws = this.ws;
        this.ws = null;
        this.acked = false;
        ws.close(1000, "idle");
        this.setStatus("closed");
      }
    }, this.options.idleCloseMs);
  }

  subscribe(query: string, variables: GqlVariables, sink: Sink): () => void {
    if (this.closed) throw new Error("subscription client closed");
    const id = String(++this.seq);
    this.subs.set(id, { query, variables, sink });
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.ws) this.open();
    else if (this.acked && this.ws.readyState === WS_OPEN) this.ws.send(JSON.stringify({ id, type: "subscribe", payload: { query, variables } }));
    return () => {
      if (!this.subs.delete(id)) return;
      if (this.ws && this.acked && this.ws.readyState === WS_OPEN) this.ws.send(JSON.stringify({ id, type: "complete" }));
      this.maybeIdle();
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.idleTimer !== null) this.clearTimer(this.idleTimer);
    this.timer = null;
    this.idleTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.subs.clear();
    ws?.close(1000, "closed");
    this.setStatus("closed");
  }
}
