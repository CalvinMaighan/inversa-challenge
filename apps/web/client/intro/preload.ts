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
import { areasOf } from "client/lionfish/model";
import { DEFAULT_REEF_MODE, reefUrl, wideUrls } from "client/lionfish/reef";
import { DEFAULT_RANGE_DAYS } from "client/state/range";
import { viewFor } from "client/state/view";
import { timeWindow } from "client/state/time";
import { allChunks, chunkUrl, frameAxis } from "client/threads/db/frames";
import { cyclonesUrl, overlayTileUrl, overlaysForApp, snapOverlayTime } from "shared/overlays";
import { framesPath } from "client/threads/gql/client";
import { APP_IDS, getApp, hasLayer, type AppId } from "shared/apps";

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

/**
 * The reef heat pictures of the newest product day (default map): the wide backdrop tiles and one picture per area, the
 * ones the lionfish map asks for when the layer is switched on, so the server holds them and the browser has them.
 */
export function heatWarmUrls(nowMs: number): string[] {
  const areas = areasOf(getApp(APP_IDS[1]));
  return [...wideUrls(areas, DEFAULT_REEF_MODE, nowMs, nowMs), ...areas.map((a) => reefUrl(a, DEFAULT_REEF_MODE, nowMs, nowMs))];
}

/**
 * The water and weather overlay pictures of an app, every overlay it lists (all start switched off), for the tiles a camera
 * 5,000 km over its area needs at the zoom levels given: the same URLs Cesium asks for when a layer is switched on, so the
 * server's tile cache and the browser's already hold them. Tile addresses are the usual Web Mercator z/x/y.
 */
export function overlayWarmUrls(app: AppId, nowMs: number, zooms: readonly number[] = [3, 4]): string[] {
  const view = viewFor(getApp(app));
  // What a camera 5,000 km up sees: about 26 degrees of latitude each way, wider in longitude away from the equator.
  const half = 28;
  const lonHalf = Math.min(180, half / Math.max(0.3, Math.cos((view.lat * Math.PI) / 180)));
  const box = { west: Math.max(-180, view.lon - lonHalf), east: Math.min(180, view.lon + lonHalf), south: Math.max(-85, view.lat - half), north: Math.min(85, view.lat + half) };
  const out: string[] = [];
  // Only the overlays the app's config lists (clouds are listed by none).
  for (const spec of overlaysForApp(app).filter((o) => hasLayer(getApp(app), o.id))) {
    if (spec.maxZoom === null) {
      out.push(cyclonesUrl(app));
      continue;
    }
    const shownMs = snapOverlayTime(spec, nowMs, nowMs).shownMs;
    for (const z of zooms) {
      if (z > spec.maxZoom) continue;
      const n = 2 ** z;
      const x0 = Math.max(0, Math.floor(((box.west + 180) / 360) * n));
      const x1 = Math.min(n - 1, Math.floor(((box.east + 180) / 360) * n));
      const y = (lat: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
      const y0 = Math.max(0, y(box.north));
      const y1 = Math.min(n - 1, y(box.south));
      for (let tx = x0; tx <= x1; tx += 1) for (let ty = y0; ty <= y1; ty += 1) out.push(overlayTileUrl(app, spec.id, z, tx, ty, shownMs));
    }
  }
  return out;
}

/** The apps' URLs interleaved (one of each in turn), so a slow app does not starve the next one. */
export function interleave(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** The finer zoom levels of the chosen app's overlays, once it is chosen (a few at a time, low priority, once per app). */
const finer = new Set<AppId>();
export function warmFiner(app: AppId, nowMs = Date.now()): void {
  if (finer.has(app) || typeof fetch !== "function") return;
  finer.add(app);
  const urls = overlayWarmUrls(app, nowMs, [5]).filter((u) => !u.endsWith("/cyclones"));
  const lane = async () => {
    for (let u = urls.shift(); u !== undefined; u = urls.shift()) {
      try {
        await (await fetch(u, { priority: "low" } as RequestInit)).arrayBuffer();
      } catch {
        // Only a warm: the layer asks for the tile itself when it is switched on.
      }
    }
  };
  for (let i = 0; i < 2; i += 1) void lane();
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
  // The layers' pictures (reef heat, sea temperature, radar, lightning) all start switched off and come from slow public
  // services: they warm after the chunks and never hold the gate's progress.
  const heat = [...APP_IDS.flatMap((id) => overlayWarmUrls(id, nowMs)), ...heatWarmUrls(nowMs)];
  const total = queue.length + 1;
  let done = 0;
  const tick = () => {
    done += 1;
    onProgress(done, total);
  };
  const lane = (urls: string[], counted: boolean) => async () => {
    for (let url = urls.shift(); url !== undefined; url = urls.shift()) {
      try {
        const res = await fetch(url, { priority: "low" } as RequestInit);
        // The body has to be read to the end for the browser to keep it.
        await res.arrayBuffer();
      } catch {
        // A failed warm only means the worker fetches that chunk itself later.
      }
      if (counted) tick();
    }
  };
  const finished = Promise.all([loadFish().finally(tick), ...Array.from({ length: Math.min(LANES, queue.length) }, lane(queue, true))]).then(() => undefined);
  void finished.then(() => Promise.all(Array.from({ length: 2 }, lane(heat, false))));
  onProgress(0, total);
  running = { total, done: () => done, finished };
  return running;
}

/** Test hook: forget the running preload. */
export function resetPreload(): void {
  running = null;
}
