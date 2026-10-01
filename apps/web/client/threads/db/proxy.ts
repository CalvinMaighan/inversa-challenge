/**
 * Cross-tab DB call router. The leader answers calls locally (its db worker); a follower posts them on
 * `BroadcastChannel("inversa-db")` and the leader's main thread answers on the same channel. A call that gets
 * no answer (the leader closed mid-flight) is re-dispatched after `timeoutMs`; by then this tab may be the
 * leader, in which case the retry runs locally.
 *
 * The channel and clock are injected so the router runs under bun with a fake channel pair.
 */

export type ChannelLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  close?(): void;
};

export type DbCallRequest = { t: "db:req"; id: string; method: string; params: unknown };
export type DbCallResponse = { t: "db:res"; id: string; ok: boolean; value?: unknown; error?: string };
/** Leader -> followers: something in the leader changed that followers cache (frames, board rows). */
export type DbBroadcast = { t: "db:event"; event: string; detail?: unknown };

export type ProxyMessage = DbCallRequest | DbCallResponse | DbBroadcast;

export type RouterOptions = {
  channel: ChannelLike;
  isLeader: () => boolean;
  /** Runs a call on this tab's db worker. Only invoked while leader. */
  local: (method: string, params: unknown) => Promise<unknown>;
  /** Unique per tab; prefixes call ids so two tabs never collide. */
  tabId: string;
  timeoutMs?: number;
  /** Re-dispatches before giving up. */
  maxAttempts?: number;
  onEvent?: (event: string, detail: unknown) => void;
};

export type Router = {
  call(method: string, params?: unknown): Promise<unknown>;
  /** Leader only: tell followers about a change. */
  broadcast(event: string, detail?: unknown): void;
  readonly pending: number;
  close(): void;
};

export const CHANNEL_NAME = "inversa-db";

/** The db RPC channel of one app's tabs (C-A5: threads are per app, so two apps never share a leader). */
export function dbChannelName(app: string): string {
  return `${CHANNEL_NAME}:${app}`;
}
export const PROXY_TIMEOUT_MS = 5_000;

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

export function createRouter(options: RouterOptions): Router {
  const timeoutMs = options.timeoutMs ?? PROXY_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? 3;
  type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null };
  const inflight = new Map<string, Pending>();
  let seq = 0;
  let closed = false;

  const onMessage = (ev: MessageEvent) => {
    const m = ev.data as ProxyMessage | null;
    if (!m || typeof m !== "object") return;
    if (m.t === "db:req") {
      if (!options.isLeader()) return;
      options
        .local(m.method, m.params)
        .then((value) => options.channel.postMessage({ t: "db:res", id: m.id, ok: true, value } satisfies DbCallResponse))
        .catch((err: unknown) =>
          options.channel.postMessage({ t: "db:res", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies DbCallResponse),
        );
      return;
    }
    if (m.t === "db:res") {
      const p = inflight.get(m.id);
      if (!p) return;
      inflight.delete(m.id);
      if (p.timer !== null) clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value);
      else p.reject(new ProxyError(m.error ?? "db call failed", m.id));
      return;
    }
    if (m.t === "db:event") {
      if (options.isLeader()) return;
      options.onEvent?.(m.event, m.detail);
    }
  };
  options.channel.addEventListener("message", onMessage);

  const remote = (method: string, params: unknown, attempt: number): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const id = `${options.tabId}:${++seq}`;
      const timer = setTimeout(() => {
        inflight.delete(id);
        if (closed) return reject(new ProxyError("router closed", method));
        if (attempt >= maxAttempts) return reject(new ProxyError(`no leader answered ${method} after ${attempt} attempts`, method));
        dispatch(method, params, attempt + 1).then(resolve, reject);
      }, timeoutMs);
      inflight.set(id, { resolve, reject, timer });
      options.channel.postMessage({ t: "db:req", id, method, params } satisfies DbCallRequest);
    });

  const dispatch = (method: string, params: unknown, attempt: number): Promise<unknown> =>
    options.isLeader() ? options.local(method, params) : remote(method, params, attempt);

  return {
    call(method, params = {}) {
      if (closed) return Promise.reject(new ProxyError("router closed", method));
      return dispatch(method, params, 1);
    },
    broadcast(event, detail) {
      options.channel.postMessage({ t: "db:event", event, detail } satisfies DbBroadcast);
    },
    get pending() {
      return inflight.size;
    },
    close() {
      closed = true;
      options.channel.removeEventListener("message", onMessage);
      for (const [id, p] of inflight) {
        if (p.timer !== null) clearTimeout(p.timer);
        p.reject(new ProxyError("router closed", id));
      }
      inflight.clear();
      options.channel.close?.();
    },
  };
}
