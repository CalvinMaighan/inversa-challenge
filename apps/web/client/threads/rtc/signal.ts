/**
 * Signaling client for the Cloudflare Worker (PLAN.md C9). Plain fetches; the room is the board id.
 * `fetchImpl` is injectable so the lifecycle runs under bun against an in-memory fake.
 */

export const DEV_SIGNAL_URL = "http://127.0.0.1:8799";

export type SignalKind = "offer" | "answer" | "ice";

export type SignalPeer = { peerId: string; name: string; seenAt: number };

export type SignalMessage = { from: string; kind: SignalKind; payload: unknown; sentAt?: number };

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

export type Signaling = {
  announce(room: string, peerId: string, name: string): Promise<void>;
  listPeers(room: string): Promise<SignalPeer[]>;
  send(room: string, to: string, from: string, kind: SignalKind, payload: unknown): Promise<void>;
  drain(room: string, peerId: string): Promise<SignalMessage[]>;
  iceServers(): Promise<IceServer[]>;
};

export function resolveSignalUrl(explicit: string | undefined): string {
  const url = (explicit ?? "").trim();
  return (url || DEV_SIGNAL_URL).replace(/\/+$/, "");
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createSignaling(baseUrl: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Signaling {
  const base = baseUrl.replace(/\/+$/, "");
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Response> => {
    const res = await fetchImpl(base + path, {
      method,
      mode: "cors",
      cache: "no-store",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`signal ${method} ${path}: ${res.status}`);
    return res;
  };
  // Rooms are `<app>:main` (C-A6). `:` is legal in a path segment and the Worker matches ids as written (it
  // refuses percent-escapes), so it goes unescaped; anything else unusual stays escaped and is refused there.
  const room = (id: string) => `/rooms/${encodeURIComponent(id).replaceAll("%3A", ":")}`;
  return {
    async announce(r, peerId, name) {
      await call("POST", `${room(r)}/peers`, { peerId, name });
    },
    async listPeers(r) {
      return (await (await call("GET", `${room(r)}/peers`)).json()) as SignalPeer[];
    },
    async send(r, to, from, kind, payload) {
      await call("POST", `${room(r)}/inbox/${encodeURIComponent(to)}`, { from, kind, payload });
    },
    async drain(r, peerId) {
      return (await (await call("GET", `${room(r)}/inbox/${encodeURIComponent(peerId)}`)).json()) as SignalMessage[];
    },
    async iceServers() {
      const body = (await (await call("GET", "/turn")).json()) as { iceServers?: IceServer[] };
      return Array.isArray(body.iceServers) ? body.iceServers : [];
    },
  };
}
