/**
 * Background preload of every app's two years of data, started the moment the page loads (docs/intro.md).
 *
 * - carp: the sightings store (`loadFish`), read once into memory, so choosing carp draws instantly.
 * - lionfish and python: the frame chunks of the default 2-year window, fetched with the exact URLs the db worker
 *   asks for, so the worker's own request is answered from the HTTP cache when the species is chosen. (The workers
 *   are per app and one at a time; the HTTP cache is what is shared.) The API keeps the built chunks in memory too.
 *
 * Chunks go newest first, a few at a time, at low priority, so the active app's own loading wins every contest.
 */
import { loadFish } from "client/carp/fish";
import { DEFAULT_RANGE_DAYS } from "client/state/range";
import { timeWindow } from "client/state/time";
import { allChunks, chunkUrl, frameAxis } from "client/threads/db/frames";
import { framesPath } from "client/threads/gql/client";
import { APP_IDS, getApp, type AppId } from "shared/apps";

/** Simultaneous warm requests. */
const LANES = 4;

/** The frame chunk URLs of a species app's default window, newest first. */
export function warmUrls(app: AppId, nowMs: number, days: number = DEFAULT_RANGE_DAYS): string[] {
  if (getApp(app).kind !== "species") return [];
  const { from, to } = timeWindow(nowMs, days);
  return allChunks(frameAxis(from, to))
    .reverse()
    .map((c) => chunkUrl(framesPath(app), c));
}

/** The apps' URLs interleaved (one of each in turn), so a slow app does not starve the next one. */
export function interleave(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

export type Preload = { total: number; done(): number; finished: Promise<void> };

let running: Preload | null = null;

/**
 * Start the preload once per page load. `active` is the app already loading through its own workers, so its frame
 * chunks are not fetched twice. `onProgress` is called with (done, total) as requests settle.
 */
export function startPreload(active: AppId, onProgress: (done: number, total: number) => void = () => {}, nowMs = Date.now()): Preload {
  if (running) return running;
  const queue = interleave(APP_IDS.filter((id) => id !== active).map((id) => warmUrls(id, nowMs)));
  const total = queue.length + 1;
  let done = 0;
  const tick = () => {
    done += 1;
    onProgress(done, total);
  };
  const lane = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      try {
        const res = await fetch(url, { priority: "low" } as RequestInit);
        // The body has to be read to the end for the browser to keep it.
        await res.arrayBuffer();
      } catch {
        // A failed warm only means the worker fetches that chunk itself later.
      }
      tick();
    }
  };
  const finished = Promise.all([loadFish().finally(tick),...Array.from({ length: Math.min(LANES, queue.length) }, lane)]).then(() => undefined);
  onProgress(0, total);
  running = { total, done: () => done, finished };
  return running;
}

/** Test hook: forget the running preload. */
export function resetPreload(): void {
  running = null;
}
