// WebRTC rendezvous for board rooms (PLAN C9). Peers announce themselves into a per-room
// list, swap offer/answer/ICE through per-peer inboxes, and fetch TURN credentials.
// Everything lives in R2: one peers.json per room written with etag preconditions, and
// one object per inbox message, deleted once the recipient has read it.

import type { R2Bucket } from "./r2";

export interface Env {
  SIGNAL: R2Bucket;
  /** Comma-separated list of exact origins allowed to call the worker from a browser. */
  ALLOWED_ORIGIN: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_KEY_TOKEN?: string;
}

export interface Peer {
  peerId: string;
  name: string;
  seenAt: number;
}

export type MessageKind = "offer" | "answer" | "ice";

export interface InboxMessage {
  from: string;
  kind: MessageKind;
  payload: unknown;
  sentAt: number;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Room and peer ids. `:` is allowed so a room can be `<app>:main` (PLAN.md C-A6). */
export const ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
export const MAX_BODY_BYTES = 64 * 1024;
export const PEER_TTL_MS = 60_000;
export const MAX_NAME_LENGTH = 64;
export const TURN_TTL_S = 3600;
export const STUN_ONLY: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
/** Read-modify-write attempts on peers.json before giving up with 503. */
export const ANNOUNCE_ATTEMPTS = 12;
/** Messages returned per inbox poll: 1 list + N gets + 1 delete stays under the 50 subrequest cap. */
export const DRAIN_LIMIT = 32;

const KINDS: ReadonlySet<string> = new Set<MessageKind>(["offer", "answer", "ice"]);
const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- request parsing ----------

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (!req.body) throw new HttpError(400, "JSON body required");

  // Count bytes as they arrive so a missing or lying content-length cannot push past the cap.
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new HttpError(400, `${field} must match ${ID_RE.source}`);
  }
  return value;
}

// ---------- peers ----------

const peersKey = (room: string) => `rooms/${room}/peers.json`;

function isPeer(p: unknown): p is Peer {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  return typeof r.peerId === "string" && typeof r.name === "string" && typeof r.seenAt === "number";
}

function parsePeers(text: string): Peer[] {
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data.filter(isPeer) : [];
  } catch {
    // A corrupt list is rebuilt from the next round of heartbeats instead of wedging the room.
    return [];
  }
}

const livePeers = (peers: Peer[], now: number) => peers.filter((p) => now - p.seenAt < PEER_TTL_MS);

async function announce(bucket: R2Bucket, room: string, peerId: string, name: string): Promise<void> {
  const key = peersKey(room);
  for (let attempt = 0; attempt < ANNOUNCE_ATTEMPTS; attempt++) {
    const current = await bucket.get(key);
    const peers = current ? parsePeers(await current.text()) : [];
    const now = Date.now();
    const next = livePeers(peers, now).filter((p) => p.peerId !== peerId);
    next.push({ peerId, name, seenAt: now });

    // Compare-and-swap: overwrite only the version we read, or create only if still absent.
    const written = await bucket.put(key, JSON.stringify(next), {
      onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    if (written) return;
    await sleep(5 + Math.random() * 20 * (attempt + 1));
  }
  throw new HttpError(503, "peer list is busy, retry the announce", { "Retry-After": "1" });
}

async function listPeers(bucket: R2Bucket, room: string): Promise<Peer[]> {
  const current = await bucket.get(peersKey(room));
  if (!current) return [];
  return livePeers(parsePeers(await current.text()), Date.now());
}

// ---------- inbox ----------

const inboxPrefix = (room: string, peer: string) => `rooms/${room}/inbox/${peer}/`;

// Per-isolate counter so two messages stored in the same millisecond keep their send order.
let sequence = 0;

function messageKey(room: string, peer: string, now: number): string {
  const ts = String(now).padStart(13, "0");
  sequence = (sequence + 1) % 1e8;
  const rand = String(sequence).padStart(8, "0") + crypto.getRandomValues(new Uint32Array(1))[0]!.toString(16).padStart(8, "0");
  return `${inboxPrefix(room, peer)}${ts}-${rand}.json`;
}

async function deliver(bucket: R2Bucket, room: string, peer: string, body: Record<string, unknown>): Promise<void> {
  const from = requireId(body.from, "from");
  if (typeof body.kind !== "string" || !KINDS.has(body.kind)) {
    throw new HttpError(400, `kind must be one of ${[...KINDS].join(", ")}`);
  }
  if (body.payload === undefined) throw new HttpError(400, "payload required");
  const now = Date.now();
  const message: InboxMessage = { from, kind: body.kind as MessageKind, payload: body.payload, sentAt: now };
  await bucket.put(messageKey(room, peer, now), JSON.stringify(message), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function drain(bucket: R2Bucket, room: string, peer: string): Promise<InboxMessage[]> {
  const listed = await bucket.list({ prefix: inboxPrefix(room, peer), limit: DRAIN_LIMIT });
  const keys = listed.objects.map((o) => o.key).sort();
  if (keys.length === 0) return [];

  const bodies = await Promise.all(keys.map((k) => bucket.get(k)));
  const messages: InboxMessage[] = [];
  for (const obj of bodies) {
    if (!obj) continue; // deleted by a concurrent poll
    try {
      messages.push(JSON.parse(await obj.text()) as InboxMessage);
    } catch {
      // unreadable message: dropped with the rest of the batch below
    }
  }
  await bucket.delete(keys);
  return messages;
}

// ---------- TURN ----------

function normalizeIceServers(raw: unknown): IceServer[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out: IceServer[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
      .filter((u): u is string => typeof u === "string")
      // Browsers time out on port 53 candidates; Cloudflare recommends dropping them.
      .filter((u) => !/:53(\?|$)/.test(u));
    if (urls.length === 0) continue;
    const server: IceServer = { urls };
    if (typeof s.username === "string") server.username = s.username;
    if (typeof s.credential === "string") server.credential = s.credential;
    out.push(server);
  }
  return out;
}

async function iceServers(env: Env): Promise<IceServer[]> {
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_KEY_TOKEN) return STUN_ONLY;
  try {
    const res = await fetch(`${TURN_API}/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_TURN_KEY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
    });
    if (!res.ok) throw new Error(`TURN API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const servers = normalizeIceServers(((await res.json()) as { iceServers?: unknown }).iceServers);
    if (servers.length === 0) throw new Error("TURN API returned no usable iceServers");
    return servers;
  } catch (err) {
    // STUN still connects most peers; a TURN outage should not block the handshake.
    console.error("turn credentials failed, serving STUN only:", err);
    return STUN_ONLY;
  }
}

// ---------- routing ----------

function methodNotAllowed(allow: string): never {
  throw new HttpError(405, "method not allowed", { Allow: allow });
}

async function route(req: Request, env: Env): Promise<Response> {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);

  if (parts.length === 1 && parts[0] === "turn") {
    if (req.method !== "GET") methodNotAllowed("GET, OPTIONS");
    return json({ iceServers: await iceServers(env) });
  }

  if (parts[0] === "rooms" && parts[2] === "peers" && parts.length === 3) {
    const room = requireId(parts[1], "room");
    if (req.method === "GET") return json(await listPeers(env.SIGNAL, room));
    if (req.method !== "POST") methodNotAllowed("GET, POST, OPTIONS");
    const body = await readJson(req);
    const peerId = requireId(body.peerId, "peerId");
    if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > MAX_NAME_LENGTH) {
      throw new HttpError(400, `name must be a string of 1-${MAX_NAME_LENGTH} characters`);
    }
    await announce(env.SIGNAL, room, peerId, body.name);
    return new Response(null, { status: 204 });
  }

  if (parts[0] === "rooms" && parts[2] === "inbox" && parts.length === 4) {
    const room = requireId(parts[1], "room");
    const peer = requireId(parts[3], "peer");
    if (req.method === "GET") return json(await drain(env.SIGNAL, room, peer));
    if (req.method !== "POST") methodNotAllowed("GET, POST, OPTIONS");
    await deliver(env.SIGNAL, room, peer, await readJson(req));
    return new Response(null, { status: 204 });
  }

  throw new HttpError(404, "not found");
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get("Origin");
  const allowed = origin !== null && allowedOrigins(env).includes(origin);

  let res: Response;
  if (origin !== null && !allowed) {
    // Browsers from other sites could still send simple (unpreflighted) POSTs; refuse them outright.
    res = json({ error: "origin not allowed" }, 403);
  } else if (req.method === "OPTIONS") {
    res = new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  } else {
    try {
      res = await route(req, env);
    } catch (err) {
      if (err instanceof HttpError) {
        res = json({ error: err.message }, err.status, err.headers);
      } else {
        console.error("unhandled", err);
        res = json({ error: "internal error" }, 500);
      }
    }
  }

  // The app runs with COEP require-corp, so every response, errors included, must opt in.
  res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Vary", "Origin");
  if (allowed) res.headers.set("Access-Control-Allow-Origin", origin);
  return res;
}
