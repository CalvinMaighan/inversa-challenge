/**
 * Data access contract for UI code (PLAN.md C16). UI leaves call only these functions.
 *
 * Internals run on the workers (T19): queries go to the db worker, which answers cacheable ones from
 * SQLite (stale-while-revalidate) and forwards the rest to the gql worker; subscriptions ride the gql
 * worker's graphql-transport-ws socket; the frame grid is the SAB (or transferred buffer) the db worker
 * fills. Outside a browser (SSR, bun) `gqlRequest` falls back to a direct fetch.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

import { bootThreads } from "./boot";
import { ttlForQuery } from "./db/cache";
import { frameIndexAt, type FrameWindow } from "./db/frames";
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

const HTTP_URL = "/v1/graphql";

const inBrowser = () => typeof window !== "undefined" && typeof Worker === "function";

function unwrap<T>(body: GqlResult<T>): T {
  if (body.errors?.length) throw new GqlError(body.errors.map((e) => e.message).join("; "), body.errors);
  if (body.data === undefined) throw new GqlError(`graphql http ${body.status ?? 0}`, []);
  return body.data;
}

async function directRequest<T>(query: string, variables: GqlVariables, signal?: AbortSignal): Promise<T> {
  const res = await fetch(HTTP_URL, {
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

/**
 * Run a query or mutation. Cacheable queries (see `db/cache.ts` for the TTL table) are answered by the db
 * worker from SQLite when fresh, served stale and revalidated when past their TTL, and fetched otherwise.
 * Mutations and uncacheable roots go straight to the gql worker.
 */
export async function gqlRequest<T>(query: string, variables: GqlVariables = {}, signal?: AbortSignal): Promise<T> {
  if (!inBrowser()) return directRequest<T>(query, variables, signal);
  const threads = bootThreads();
  if (ttlForQuery(query) === 0) return unwrap(await threads.gql.request(query, variables, signal) as GqlResult<T>);
  const result = await abortable(threads.db("query", { query, variables }), signal);
  return unwrap(result as GqlResult<T>);
}

/** graphql-transport-ws subscription on the gql worker's socket. Reconnects with backoff until unsubscribed. */
export function gqlSubscribe<T>(query: string, variables: GqlVariables, onData: (data: T) => void, onError?: (err: Error) => void): () => void {
  if (!inBrowser()) throw new Error("gqlSubscribe: needs a browser");
  return bootThreads().gql.subscribe(query, variables, { next: (data) => onData(data as T), error: onError });
}

let frameGrid: FrameGrid | null = null;
let frameWindow: FrameWindow | null = null;
const gridListeners = new Set<(grid: FrameGrid) => void>();
let wired = false;

function wire(): void {
  if (wired || !inBrowser()) return;
  wired = true;
  bootThreads().onGrid(({ grid, window }) => publishFrameGrid(grid, window));
}

/** The frame grid the db worker fills (T19). Null until the first chunk loads. */
export function getFrameGrid(): FrameGrid | null {
  wire();
  return frameGrid;
}

/** Time bounds and densities of the current grid; `frameIndexFor` maps a TIME cursor onto it. */
export function getFrameWindow(): FrameWindow | null {
  wire();
  return frameWindow;
}

/** Grid index of the frame at or before `at` (RFC 3339 or unix ms), or -1 before any grid is published. */
export function frameIndexFor(at: string | number): number {
  const w = getFrameWindow();
  if (!w) return -1;
  return frameIndexAt(w, typeof at === "number" ? at : Date.parse(at));
}

export function onFrameGrid(cb: (grid: FrameGrid) => void): () => void {
  wire();
  if (frameGrid) cb(frameGrid);
  gridListeners.add(cb);
  return () => gridListeners.delete(cb);
}

/** Called by the thread boot code (T19) when a grid is allocated or replaced. */
export function publishFrameGrid(grid: FrameGrid, window?: FrameWindow): void {
  frameGrid = grid;
  if (window) frameWindow = window;
  for (const cb of gridListeners) cb(grid);
}
