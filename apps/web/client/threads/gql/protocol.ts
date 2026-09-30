/**
 * GraphQL RPC between threads. The gql worker serves it on its own scope (for main) and on a MessagePort
 * (for the db worker); both callers use `GqlRpcClient`. Messages carry a `t` tag so they coexist with the
 * active-state thread handshake and ring fallback on the same port.
 */
import type { MessagePortLike } from "@calvinjs/active-state/threads";

export type GqlVariables = Record<string, unknown>;

export type GqlErrorShape = { message: string; extensions?: Record<string, unknown> };

export type GqlResult<T = unknown> = { data?: T; errors?: GqlErrorShape[]; status?: number };

export type ToGql =
  | { t: "gql:req"; id: string; query: string; variables: GqlVariables }
  | { t: "gql:abort"; id: string }
  | { t: "gql:sub"; id: string; query: string; variables: GqlVariables }
  | { t: "gql:unsub"; id: string }
  | { t: "gql:link-db"; port: MessagePort };

export type FromGql =
  | { t: "gql:res"; id: string; result: GqlResult }
  | { t: "gql:next"; id: string; data: unknown }
  | { t: "gql:err"; id: string; message: string }
  | { t: "gql:complete"; id: string }
  | { t: "gql:status"; socket: SocketStatus }
  | { t: "gql:frames-updated"; from: string; to: string };

export type SocketStatus = "connecting" | "open" | "closed";

export type Sink<T = unknown> = { next(data: T): void; error?(err: Error): void; complete?(): void };

export type GqlHandlers = {
  request(query: string, variables: GqlVariables, signal: AbortSignal): Promise<GqlResult>;
  subscribe(query: string, variables: GqlVariables, sink: Sink): () => void;
};

export function isFromGql(d: unknown): d is FromGql {
  return Boolean(d) && typeof d === "object" && typeof (d as { t?: unknown }).t === "string" && (d as { t: string }).t.startsWith("gql:");
}

export function isToGql(d: unknown): d is ToGql {
  return isFromGql(d);
}

/** Caller side: request/response and subscriptions multiplexed over one port. */
export class GqlRpcClient {
  private readonly requests = new Map<string, { resolve: (r: GqlResult) => void; signal?: AbortSignal; onAbort?: () => void }>();
  private readonly subs = new Map<string, Sink>();
  private readonly statusListeners = new Set<(s: SocketStatus) => void>();
  private readonly extra = new Set<(m: FromGql) => void>();
  private seq = 0;
  private closed = false;
  socket: SocketStatus = "connecting";

  private readonly onEvent = (ev: MessageEvent): void => {
    const m = ev.data as unknown;
    if (!isFromGql(m)) return;
    switch (m.t) {
      case "gql:res": {
        const p = this.requests.get(m.id);
        if (!p) return;
        this.requests.delete(m.id);
        if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
        p.resolve(m.result);
        return;
      }
      case "gql:next":
        this.subs.get(m.id)?.next(m.data);
        return;
      case "gql:err":
        this.subs.get(m.id)?.error?.(new Error(m.message));
        return;
      case "gql:complete": {
        const s = this.subs.get(m.id);
        this.subs.delete(m.id);
        s?.complete?.();
        return;
      }
      case "gql:status":
        this.socket = m.socket;
        for (const cb of this.statusListeners) cb(m.socket);
        return;
      default:
        for (const cb of this.extra) cb(m);
    }
  };

  constructor(
    readonly port: MessagePortLike,
    readonly prefix = "c",
  ) {
    port.addEventListener("message", this.onEvent);
    port.start?.();
  }

  private nextId(): string {
    return `${this.prefix}${++this.seq}`;
  }

  request(query: string, variables: GqlVariables = {}, signal?: AbortSignal): Promise<GqlResult> {
    if (this.closed) return Promise.resolve({ errors: [{ message: "gql client closed" }] });
    if (signal?.aborted) return Promise.resolve({ errors: [{ message: "aborted" }] });
    const id = this.nextId();
    return new Promise<GqlResult>((resolve) => {
      const onAbort = () => {
        if (!this.requests.delete(id)) return;
        this.port.postMessage({ t: "gql:abort", id } satisfies ToGql);
        resolve({ errors: [{ message: "aborted" }] });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.requests.set(id, { resolve, signal, onAbort });
      this.port.postMessage({ t: "gql:req", id, query, variables } satisfies ToGql);
    });
  }

  subscribe(query: string, variables: GqlVariables, sink: Sink): () => void {
    const id = this.nextId();
    this.subs.set(id, sink);
    this.port.postMessage({ t: "gql:sub", id, query, variables } satisfies ToGql);
    return () => {
      if (!this.subs.delete(id)) return;
      this.port.postMessage({ t: "gql:unsub", id } satisfies ToGql);
    };
  }

  onStatus(cb: (s: SocketStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Messages other than responses, e.g. `gql:frames-updated`. */
  onMessage(cb: (m: FromGql) => void): () => void {
    this.extra.add(cb);
    return () => {
      this.extra.delete(cb);
    };
  }

  close(): void {
    this.closed = true;
    this.port.removeEventListener("message", this.onEvent);
    for (const p of this.requests.values()) p.resolve({ errors: [{ message: "gql client closed" }] });
    this.requests.clear();
    this.subs.clear();
  }
}

/** Worker side: answer one port's RPC with `handlers`. Returns a detach function. */
export function serveGqlRpc(port: MessagePortLike, handlers: GqlHandlers, onOther?: (m: ToGql) => void): () => void {
  const aborts = new Map<string, AbortController>();
  const unsubs = new Map<string, () => void>();
  const onEvent = (ev: MessageEvent): void => {
    const m = ev.data as unknown;
    if (!isToGql(m)) return;
    switch (m.t) {
      case "gql:req": {
        const ac = new AbortController();
        aborts.set(m.id, ac);
        handlers
          .request(m.query, m.variables, ac.signal)
          .catch((err: unknown): GqlResult => ({ errors: [{ message: err instanceof Error ? err.message : String(err) }] }))
          .then((result) => {
            aborts.delete(m.id);
            port.postMessage({ t: "gql:res", id: m.id, result } satisfies FromGql);
          });
        return;
      }
      case "gql:abort":
        aborts.get(m.id)?.abort();
        aborts.delete(m.id);
        return;
      case "gql:sub": {
        const off = handlers.subscribe(m.query, m.variables, {
          next: (data) => port.postMessage({ t: "gql:next", id: m.id, data } satisfies FromGql),
          error: (err) => port.postMessage({ t: "gql:err", id: m.id, message: err.message } satisfies FromGql),
          complete: () => {
            unsubs.delete(m.id);
            port.postMessage({ t: "gql:complete", id: m.id } satisfies FromGql);
          },
        });
        unsubs.set(m.id, off);
        return;
      }
      case "gql:unsub": {
        const off = unsubs.get(m.id);
        unsubs.delete(m.id);
        off?.();
        return;
      }
      default:
        onOther?.(m);
    }
  };
  port.addEventListener("message", onEvent);
  port.start?.();
  return () => {
    port.removeEventListener("message", onEvent);
    for (const off of unsubs.values()) off();
    unsubs.clear();
    for (const ac of aborts.values()) ac.abort();
    aborts.clear();
  };
}
