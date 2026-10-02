/**
 * Data access contract for UI code (PLAN.md C16). UI leaves call only these functions.
 *
 * Internals run on the workers (T19): queries go to the db worker, which answers cacheable ones from
 * SQLite (stale-while-revalidate) and forwards the rest to the gql worker; subscriptions ride the gql
 * worker's graphql-transport-ws socket; the frame grid and sightings are what the db worker decodes from
 * EVF2 and hands to `boot.ts`. Outside a browser (SSR, bun) `gqlRequest` falls back to a direct fetch.
 *
 * Every request is the active app's (PLAN.md C-A5, `/v1/<app>/...`). When the app changes, the workers of the
 * old app are closed, the published grid and sightings are replaced by empty ones (so nothing of the old app
 * stays drawn), and live subscriptions move to the new app's socket; listeners stay registered.
 */
import { allocFrameGrid, type FrameGrid } from "@calvinjs/active-state/threads";
import { subscribe } from "@calvinjs/active-state";

import { APP, activeAppId } from "client/state/app";
import type { SightingRecord } from "shared/frames";

import { bootThreads, threadsBooted, type Threads } from "./boot";
import { ttlForQuery } from "./db/cache";
import { graphqlPath } from "./gql/client";
import type { GqlErrorShape, GqlResult } from "./gql/protocol";

export type GqlVariables = Record<string, unknown>;

export class GqlError extends Error {
  constructor(
    message: string,
    readonly errors: GqlErrorShape[],
  ) {
    super(message);
    this.name = "GqlError";
  }
}

const inBrowser = () => typeof window !== "undefined" && typeof Worker === "function";

function unwrap<T>(body: GqlResult<T>): T {
  if (body.errors?.length) throw new GqlError(body.errors.map((e) => e.message).join("; "), body.errors);
  if (body.data === undefined) throw new GqlError(`graphql http ${body.status ?? 0}`, []);
  return body.data;
}

async function directRequest<T>(query: string, variables: GqlVariables, signal?: AbortSignal): Promise<T> {
  const res = await fetch(graphqlPath(activeAppId()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const body = (await res.json()) as GqlResult<T>;
  body.status = res.status;
  return unwrap(body);
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// ---- the active app's threads ----------------------------------------------------------------

type LiveSubscription = { query: string; variables: GqlVariables; onData: (data: unknown) => void; onError?: (err: Error) => void; stop: () => void };

const subscriptions = new Set<LiveSubscription>();
/** The threads the frame publications and subscriptions are attached to. */
let attached: Threads | null = null;
let detachPublications: (() => void) | null = null;
let watchingApp = false;

/** The active app's threads, booting them (and closing another app's) on first use. */
function threads(): Threads {
  watchApp();
  const t = bootThreads(activeAppId());
  if (t !== attached) attach(t);
  return t;
}

function attach(t: Threads): void {
  attached = t;
  detachPublications?.();
  const offGrid = t.onGrid(({ grid, meta }) => publishFrameGrid(grid, meta, false));
  const offSightings = t.onSightings((s) => publishFrameSightings(s));
  detachPublications = () => {
    offGrid();
    offSightings();
  };
  for (const sub of subscriptions) {
    sub.stop = t.gql.subscribe(sub.query, sub.variables, { next: sub.onData, error: sub.onError });
  }
}

/**
 * On an app switch: close the old app's workers, clear what they published, and boot the new app's when anyone
 * is listening (the globe's frame listeners, a live subscription). Installed on first use, in the browser only.
 */
function watchApp(): void {
  if (watchingApp || !inBrowser()) return;
  watchingApp = true;
  let current = activeAppId();
  subscribe(APP, () => {
    const next = activeAppId();
    if (next === current) return;
    current = next;
    for (const sub of subscriptions) sub.stop();
    detachPublications?.();
    detachPublications = null;
    attached = null;
    threadsBooted()?.close();
    if (!fixtureFrames) clearFrames();
    if (fixtureFrames || (!wired && subscriptions.size === 0)) return;
    threads();
  });
}

/** Empty grid and sightings, so the old app's frames stop drawing before the new app's arrive. */
function clearFrames(): void {
  if (frameGrid === null && frameSightings === null) return;
  const sightings: FrameSightings = { counts: new Uint32Array(0), records: () => [] };
  try {
    const grid = allocFrameGrid({ frameCount: 0, hsCols: 0, hsRows: 0, speciesCount: 0, envCols: 0, envRows: 0, hotspotScale: 1 });
    publishFrameGrid(grid, { frame0UnixMs: 0, stepMinutes: 60, frameCount: 0, geometry: { west: 0, south: 0, hsCellDeg: 1, envCellDeg: 1 } }, false);
  } catch {
    // No SharedArrayBuffer (not cross-origin isolated): the old grid stays until the new app's replaces it.
  }
  publishFrameSightings(sightings);
}

/**
 * Run a query or mutation. Cacheable queries (see `db/cache.ts` for the TTL table) are answered by the db
 * worker from SQLite when fresh, served stale and revalidated when past their TTL, and fetched otherwise.
 * Mutations and uncacheable roots go straight to the gql worker.
 */
export async function gqlRequest<T>(query: string, variables: GqlVariables = {}, signal?: AbortSignal): Promise<T> {
  if (!inBrowser()) return directRequest<T>(query, variables, signal);
  const t = threads();
  if (ttlForQuery(query) === 0) return unwrap((await t.gql.request(query, variables, signal)) as GqlResult<T>);
  const result = await abortable(t.db("query", { query, variables }), signal);
  return unwrap(result as GqlResult<T>);
}

/**
 * graphql-transport-ws subscription on the gql worker's socket. Reconnects with backoff until unsubscribed, and
 * follows the active app: after a switch it resubscribes on the new app's socket.
 */
export function gqlSubscribe<T>(query: string, variables: GqlVariables, onData: (data: T) => void, onError?: (err: Error) => void): () => void {
  if (!inBrowser()) throw new Error("gqlSubscribe: needs a browser");
  const sub: LiveSubscription = { query, variables, onData: onData as (data: unknown) => void, onError, stop: () => {} };
  subscriptions.add(sub);
  const before = attached;
  const t = threads();
  // New threads were attached just now, which subscribed every live subscription, this one included.
  if (before === t) sub.stop = t.gql.subscribe(query, variables, { next: sub.onData, error: onError });
  return () => {
    subscriptions.delete(sub);
    sub.stop();
  };
}

// ---- frames ----------------------------------------------------------------------------------

let frameGrid: FrameGrid | null = null;
const gridListeners = new Set<(grid: FrameGrid) => void>();
let wired = false;
/** A dev fixture page published the grid itself: never boot workers for frames. */
let fixtureFrames = false;

/** Attach the boot publications the first time anyone asks for frames. */
function wire(): void {
  if (wired || !inBrowser()) return;
  wired = true;
  threads();
}

/** The SAB-backed frame grid the db worker fills (T19). Null until the first chunk loads. */
export function getFrameGrid(): FrameGrid | null {
  wire();
  return frameGrid;
}

export function onFrameGrid(cb: (grid: FrameGrid) => void): () => void {
  wire();
  if (frameGrid) cb(frameGrid);
  gridListeners.add(cb);
  return () => gridListeners.delete(cb);
}

/**
 * Time axis of the published grid (PLAN.md C16). Frames are uniform: frame i covers
 * [frame0UnixMs + i*step, frame0UnixMs + (i+1)*step). One hourly grid spans the TIME window.
 */
export type FrameMeta = {
  frame0UnixMs: number;
  stepMinutes: number;
  frameCount: number;
  /** Grid placement from the EVF2 header (south-west corner and cell sizes, degrees). */
  geometry: { west: number; south: number; hsCellDeg: number; envCellDeg: number };
};

/**
 * EVF2 sighting sections, which the SAB grid does not carry. `counts[i]` is frame i's sighting
 * count; `records(i)` returns that frame's decoded records (shared/frames.ts readSightingRecords).
 */
export type FrameSightings = { counts: Uint32Array; records(i: number): readonly SightingRecord[] };

let frameMeta: FrameMeta | null = null;
let frameSightings: FrameSightings | null = null;
const sightingListeners = new Set<(s: FrameSightings) => void>();

export function getFrameMeta(): FrameMeta | null {
  wire();
  return frameMeta;
}

/** Frame index for a time, or null when no grid is loaded or the time falls outside it. */
export function frameIndexAt(atMs: number, meta: FrameMeta | null = getFrameMeta()): number | null {
  if (!meta || meta.frameCount === 0) return null;
  const i = Math.floor((atMs - meta.frame0UnixMs) / (meta.stepMinutes * 60_000));
  return i >= 0 && i < meta.frameCount ? i : null;
}

/**
 * Called by the thread boot code (T19) when a grid is allocated or replaced. A grid published before anyone
 * asked for frames comes from a fixture page (dev routes): that page is the grid's source, so reading it must
 * not boot the workers, whose frame fetches and socket reconnects would race the fixture.
 */
export function publishFrameGrid(grid: FrameGrid, meta: FrameMeta, fromFixture = !wired): void {
  if (fromFixture) fixtureFrames = true;
  wired = true;
  frameGrid = grid;
  frameMeta = meta;
  for (const cb of gridListeners) cb(grid);
}

export function getFrameSightings(): FrameSightings | null {
  wire();
  return frameSightings;
}

export function onFrameSightings(cb: (s: FrameSightings) => void): () => void {
  wire();
  if (frameSightings) cb(frameSightings);
  sightingListeners.add(cb);
  return () => sightingListeners.delete(cb);
}

/** Called by T19's EVF2 decoder alongside publishFrameGrid. */
export function publishFrameSightings(s: FrameSightings): void {
  frameSightings = s;
  for (const cb of sightingListeners) cb(s);
}
