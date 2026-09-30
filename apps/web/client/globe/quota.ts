/**
 * Cesium ion Community quota guard. The free tier allows about 1,000 imagery sessions and 1,000 Google
 * Photorealistic 3D root-tile loads a month; ion does not tell the browser how close it is, so each browser
 * keeps its own monthly tally in localStorage and the imagery ladder drops to keyless sources near 90 %.
 *
 * A per-browser count under-reports a team's total, which is why the threshold sits below the limit. Pure over
 * a `Storage`-shaped store so it runs in tests and survives a storage that throws (private mode, quota).
 */

export const ION_COMMUNITY_LIMITS = { sessions: 1_000, rootTiles: 1_000 } as const;
export const QUOTA_FALLBACK_RATIO = 0.9;
export const QUOTA_STORAGE_KEY = "inversa:ion-quota";

export type QuotaKind = keyof typeof ION_COMMUNITY_LIMITS;

export type QuotaCounts = {
  /** UTC month the counts belong to, "YYYY-MM". */
  month: string;
  sessions: number;
  rootTiles: number;
};

export type QuotaStore = Pick<Storage, "getItem" | "setItem">;

/** UTC "YYYY-MM" for an instant; ion resets usage on calendar months. */
export function monthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** Counts for the current month. A stored tally from an earlier month, or an unreadable one, reads as zero. */
export function readQuota(store: QuotaStore | null, nowMs: number): QuotaCounts {
  const month = monthKey(nowMs);
  const empty: QuotaCounts = { month, sessions: 0, rootTiles: 0 };
  if (!store) return empty;
  let raw: string | null;
  try {
    raw = store.getItem(QUOTA_STORAGE_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<QuotaCounts> | null;
    if (!parsed || parsed.month !== month) return empty;
    return { month, sessions: count(parsed.sessions), rootTiles: count(parsed.rootTiles) };
  } catch {
    return empty;
  }
}

/** Add `n` to one counter for the current month and persist it. Returns the new counts. */
export function recordQuota(store: QuotaStore | null, kind: QuotaKind, nowMs: number, n = 1): QuotaCounts {
  const current = readQuota(store, nowMs);
  const next = { ...current, [kind]: current[kind] + Math.max(0, Math.floor(n)) };
  try {
    store?.setItem(QUOTA_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the count still applies for this page load.
  }
  return next;
}

/** Fraction of the tighter limit used, 0..∞. */
export function quotaUsage(counts: QuotaCounts): number {
  return Math.max(counts.sessions / ION_COMMUNITY_LIMITS.sessions, counts.rootTiles / ION_COMMUNITY_LIMITS.rootTiles);
}

/** True once either counter reaches 90 % of its Community limit. */
export function quotaExhausted(counts: QuotaCounts): boolean {
  return quotaUsage(counts) >= QUOTA_FALLBACK_RATIO;
}

/** `localStorage`, or null where it is missing or access throws. */
export function browserQuotaStore(): QuotaStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
