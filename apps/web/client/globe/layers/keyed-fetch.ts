/**
 * Latest-wins fetch keyed by a time bucket, with a small LRU. Alerts, stations and missions ask for the bucket
 * at the cursor on every frame; during playback that is many asks for few distinct buckets, so at most one
 * request is in flight and only the newest wanted bucket is fetched after it.
 */

/**
 * Cache key for a time bucket at the current data revision. The revision moves when the db worker republishes
 * the grid (a window load, or new rows upstream: `framesUpdated`), so live data refetches the bucket instead
 * of serving what the cache held before the rows landed. Scrubbing does not move it.
 */
export function dataKey(bucketMs: number, ctx: { revision(): number }): string {
  return `${bucketMs}|${ctx.revision()}`;
}

/** The bucket time a `dataKey` was made from. */
export function bucketOfKey(key: string): number {
  return Number(key.split("|", 1)[0]);
}

export type KeyedFetch<T> = {
  /** The cached value for `key` now, or undefined (a fetch is started or queued). */
  want(key: string): T | undefined;
  cancel(): void;
};

export function createKeyedFetch<T>(opts: {
  load(key: string, signal: AbortSignal): Promise<T>;
  /** A fetched value arrived for `key`. */
  onData(key: string, value: T): void;
  onError(err: unknown): void;
  cacheSize: number;
  /** After a failure, the same key is not retried for this long (an API that is down gets no request storm). */
  retryAfterMs?: number;
  now?: () => number;
}): KeyedFetch<T> {
  const cache = new Map<string, T>();
  const failedAt = new Map<string, number>();
  const retryAfterMs = opts.retryAfterMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let inflight: { key: string; abort: AbortController } | null = null;
  let queued: string | null = null;

  const coolingDown = (key: string) => {
    const at = failedAt.get(key);
    return at !== undefined && now() - at < retryAfterMs;
  };

  const start = (key: string) => {
    if (coolingDown(key)) return;
    const job = { key, abort: new AbortController() };
    inflight = job;
    opts.load(key, job.abort.signal).then(
      (value) => {
        if (inflight !== job) return;
        inflight = null;
        failedAt.delete(key);
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > opts.cacheSize) cache.delete(cache.keys().next().value!);
        opts.onData(key, value);
        drain();
      },
      (err: unknown) => {
        if (inflight !== job) return;
        inflight = null;
        failedAt.set(key, now());
        while (failedAt.size > opts.cacheSize) failedAt.delete(failedAt.keys().next().value!);
        opts.onError(err);
        drain();
      },
    );
  };

  const drain = () => {
    const next = queued;
    queued = null;
    if (next !== null && !cache.has(next)) start(next);
  };

  return {
    want(key) {
      const hit = cache.get(key);
      if (hit !== undefined) {
        queued = null;
        return hit;
      }
      if (inflight?.key === key) queued = null;
      else if (inflight) queued = key;
      else start(key);
      return undefined;
    },
    cancel() {
      inflight?.abort.abort();
      inflight = null;
      queued = null;
    },
  };
}
