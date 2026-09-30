/**
 * Data access contract for UI code (PLAN.md C16). UI leaves call only these functions.
 * This driver version runs on the main thread (fetch + graphql-transport-ws); T19 swaps the
 * internals to the gql and db workers without changing the signatures.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

export type GqlVariables = Record<string, unknown>;

export class GqlError extends Error {
  constructor(
    message: string,
    readonly errors: { message: string; extensions?: Record<string, unknown> }[],
  ) {
    super(message);
  }
}

const HTTP_URL = "/v1/graphql";

function wsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_INVERSA_WS_URL;
  if (explicit) return explicit;
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/v1/graphql`;
}

export async function gqlRequest<T>(query: string, variables: GqlVariables = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(HTTP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: Record<string, unknown> }[] };
  if (body.errors?.length) throw new GqlError(body.errors.map((e) => e.message).join("; "), body.errors);
  if (!res.ok || body.data === undefined) throw new GqlError(`graphql http ${res.status}`, []);
  return body.data;
}

/** graphql-transport-ws subscription. Reconnects with backoff until unsubscribed. */
export function gqlSubscribe<T>(
  query: string,
  variables: GqlVariables,
  onData: (data: T) => void,
  onError?: (err: Error) => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let attempt = 0;

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(wsUrl(), "graphql-transport-ws");
    socket.onopen = () => socket?.send(JSON.stringify({ type: "connection_init" }));
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; payload?: { data?: T; errors?: unknown } | unknown[] };
      if (msg.type === "connection_ack") {
        attempt = 0;
        socket?.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query, variables } }));
      } else if (msg.type === "next" && msg.payload && !Array.isArray(msg.payload) && msg.payload.data !== undefined) {
        onData(msg.payload.data);
      } else if (msg.type === "error") {
        onError?.(new Error(JSON.stringify(msg.payload)));
      } else if (msg.type === "ping") {
        socket?.send(JSON.stringify({ type: "pong" }));
      }
    };
    socket.onclose = () => {
      if (closed) return;
      attempt += 1;
      setTimeout(connect, Math.min(30_000, 500 * 2 ** attempt));
    };
  };
  connect();

  return () => {
    closed = true;
    socket?.close();
  };
}

let frameGrid: FrameGrid | null = null;
const gridListeners = new Set<(grid: FrameGrid) => void>();

/** The SAB-backed frame grid the db worker fills (T19). Null until the first chunk loads. */
export function getFrameGrid(): FrameGrid | null {
  return frameGrid;
}

export function onFrameGrid(cb: (grid: FrameGrid) => void): () => void {
  if (frameGrid) cb(frameGrid);
  gridListeners.add(cb);
  return () => gridListeners.delete(cb);
}

/**
 * Time axis of the published grid (PLAN.md C16). Frames are uniform: frame i covers
 * [frame0UnixMs + i*step, frame0UnixMs + (i+1)*step). One hourly grid spans the TIME window.
 */
export type FrameMeta = { frame0UnixMs: number; stepMinutes: number; frameCount: number };

/**
 * EVF2 sighting sections, which the SAB grid does not carry. `counts[i]` is frame i's sighting
 * count; `records(i)` returns that frame's raw 12-byte records (f32 lon, f32 lat, u16 taxon,
 * u8 quality, u8 flags; see shared/frames.ts).
 */
export type FrameSightings = { counts: Uint32Array; records(i: number): DataView };

let frameMeta: FrameMeta | null = null;
let frameSightings: FrameSightings | null = null;
const sightingListeners = new Set<(s: FrameSightings) => void>();

export function getFrameMeta(): FrameMeta | null {
  return frameMeta;
}

/** Frame index for a time, or null when no grid is loaded or the time falls outside it. */
export function frameIndexAt(atMs: number, meta: FrameMeta | null = frameMeta): number | null {
  if (!meta || meta.frameCount === 0) return null;
  const i = Math.floor((atMs - meta.frame0UnixMs) / (meta.stepMinutes * 60_000));
  return i >= 0 && i < meta.frameCount ? i : null;
}

/** Called by the thread boot code (T19) when a grid is allocated or replaced. */
export function publishFrameGrid(grid: FrameGrid, meta: FrameMeta): void {
  frameGrid = grid;
  frameMeta = meta;
  for (const cb of gridListeners) cb(grid);
}

export function getFrameSightings(): FrameSightings | null {
  return frameSightings;
}

export function onFrameSightings(cb: (s: FrameSightings) => void): () => void {
  if (frameSightings) cb(frameSightings);
  sightingListeners.add(cb);
  return () => sightingListeners.delete(cb);
}

/** Called by T19's EVF2 decoder alongside publishFrameGrid. */
export function publishFrameSightings(s: FrameSightings): void {
  frameSightings = s;
  for (const cb of sightingListeners) cb(s);
}
