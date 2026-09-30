/**
 * Query cache policy for the db worker (PRD §12 "New tech 2": `cache_queries`, TTL by feed cadence,
 * stale-while-revalidate). Pure: the worker persists rows, this module decides what to do with them.
 */

export type CacheRow = {
  hash: string;
  json: string;
  /** Unix ms when the body was fetched. */
  fetchedAt: number;
  ttlMs: number;
};

/**
 * - `fresh`: serve the row, no network.
 * - `stale`: serve the row now, revalidate in the background.
 * - `miss`: go to the network first; a row older than `MAX_STALE_MS` is still returned when the network fails.
 */
export type CacheDecision = "fresh" | "stale" | "miss";

/** Past this age a cached body is a last resort, not an answer. */
export const MAX_STALE_MS = 24 * 60 * 60_000;

export function cacheDecision(row: CacheRow | null | undefined, nowMs: number, maxStaleMs = MAX_STALE_MS): CacheDecision {
  if (!row || row.ttlMs <= 0) return "miss";
  const age = nowMs - row.fetchedAt;
  if (age < 0) return "fresh";
  if (age <= row.ttlMs) return "fresh";
  if (age <= maxStaleMs) return "stale";
  return "miss";
}

const MINUTE = 60_000;

/** TTL per root field, by how often the feed behind it changes. 0 = never cached. */
export const ROOT_TTL_MS: Readonly<Record<string, number>> = Object.freeze({
  feeds: 30_000,
  sightings: 5 * MINUTE,
  readings: 5 * MINUTE,
  alerts: 5 * MINUTE,
  frames: 5 * MINUTE,
  hotspots: 10 * MINUTE,
  explainCell: 10 * MINUTE,
  backtest: 60 * MINUTE,
  evidence: 60 * MINUTE,
  // The CRDT tables are the source of truth for the board; caching would serve two truths.
  board: 0,
  opsSince: 0,
});

export const DEFAULT_TTL_MS = MINUTE;

/** Root field of the first selection: `{ feeds {...} }`, `query X($a: Int) { alias: feeds(...) }`. */
export function rootField(query: string): string | null {
  const m = /^\s*(?:(query|mutation|subscription)\b[^{]*)?\{\s*(?:\w+\s*:\s*)?(\w+)/.exec(query);
  if (!m) return null;
  if (m[1] === "mutation" || m[1] === "subscription") return null;
  return m[2] ?? null;
}

/** 0 for mutations, subscriptions, uncacheable roots and unparsable text. */
export function ttlForQuery(query: string): number {
  const root = rootField(query);
  if (root === null) return 0;
  return ROOT_TTL_MS[root] ?? DEFAULT_TTL_MS;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(",")}}`;
}

/** FNV-1a 64-bit over the canonical request; same hash for the same query and variables in any key order. */
export function queryHash(query: string, variables: Record<string, unknown> = {}): string {
  const text = `${query.replace(/\s+/g, " ").trim()}\u0000${stable(variables)}`;
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
