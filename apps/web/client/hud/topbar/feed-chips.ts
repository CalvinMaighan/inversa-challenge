/**
 * Feed chips (PLAN.md C3, PRD §7 "Stale feed"): one chip per source, coloured by health, with push/poll mode,
 * lag and the server's note in the tooltip. After God's Eye View `feedState.js`, minus its inference: the
 * server already decided the state, the chip only presents it.
 */
import { worstHealth, type FeedHealth, type FeedState } from "shared/feed-state";

/** GraphQL selection for a C3 envelope. */
export const FEED_FIELDS = "source mode state newestObservedAt lastFetchAt lastFetchRunId lagSeconds note";

export type ChipTone = "ok" | "warn" | "stale" | "danger";

export type FeedChip = {
  source: string;
  label: string;
  state: FeedHealth;
  tone: ChipTone;
  mode: FeedState["mode"];
  /** Short lag, e.g. `4m`, or `—` when unknown. */
  lag: string;
  /** Multi-line tooltip. */
  title: string;
};

const TONE: Record<FeedHealth, ChipTone> = { nominal: "ok", lagging: "warn", stale: "stale", down: "danger" };

/** Short display names; unknown sources fall back to the id in capitals. */
const LABELS: Record<string, string> = {
  goes: "GOES",
  goes19: "GOES",
  nwws: "NWWS",
  nws: "NWS",
  inat: "iNat",
  usgs: "USGS",
  ndbc: "NDBC",
  coops: "CO-OPS",
  openmeteo: "METEO",
  nas: "NAS",
  gbif: "GBIF",
  aisstream: "AIS",
};

export function feedLabel(source: string): string {
  const base = source.toLowerCase().replace(/[_-].*$/, "");
  return LABELS[source.toLowerCase()] ?? LABELS[base] ?? source.toUpperCase();
}

/** Seconds → `45s`, `4m`, `2h 5m`, `3d 4h`. Null or negative → `—`. */
export function formatLag(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const hhmm = (iso: string | null) => {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z` : "never";
};

export function feedChip(feed: FeedState): FeedChip {
  const lag = formatLag(feed.lagSeconds);
  const lines = [
    `${feed.source} · ${feed.mode} · ${feed.state}`,
    `lag ${lag} · newest ${hhmm(feed.newestObservedAt)} · fetched ${hhmm(feed.lastFetchAt)}`,
  ];
  if (feed.lastFetchRunId) lines.push(`last run fetch:${feed.lastFetchRunId}`);
  if (feed.note) lines.push(feed.note);
  return {
    source: feed.source,
    label: feedLabel(feed.source),
    state: feed.state,
    tone: TONE[feed.state],
    mode: feed.mode,
    lag,
    title: lines.join("\n"),
  };
}

/** Summary chip for narrow screens: worst state across feeds, and how many are not nominal. */
export function feedSummary(feeds: readonly FeedState[]): { state: FeedHealth; tone: ChipTone; degraded: number } {
  const state = worstHealth(feeds);
  return { state, tone: TONE[state], degraded: feeds.filter((f) => f.state !== "nominal").length };
}

const SEVERITY: Record<FeedHealth, number> = { down: 0, stale: 1, lagging: 2, nominal: 3 };

/** The status popover's order: worst feeds first, then by display name. */
export function sortFeedsForStatus(feeds: readonly FeedState[]): FeedState[] {
  return [...feeds].sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state] || feedLabel(a.source).localeCompare(feedLabel(b.source)));
}

const HEALTH = new Set<FeedHealth>(["nominal", "lagging", "stale", "down"]);

/**
 * GraphQL `FeedState` → C3 envelope. The SDL enums are upper case (`PUSH`, `STALE`); the TS contract is lower
 * case. Returns null for a malformed row so one bad feed cannot blank the bar.
 */
export function normalizeFeedState(raw: unknown): FeedState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string" || !r.source) return null;
  const mode = String(r.mode ?? "").toLowerCase();
  const state = String(r.state ?? "").toLowerCase() as FeedHealth;
  if ((mode !== "push" && mode !== "webhook" && mode !== "poll") || !HEALTH.has(state)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    source: r.source,
    mode,
    state,
    newestObservedAt: str(r.newestObservedAt),
    lastFetchAt: str(r.lastFetchAt),
    lastFetchRunId: typeof r.lastFetchRunId === "number" ? String(r.lastFetchRunId) : str(r.lastFetchRunId),
    lagSeconds: typeof r.lagSeconds === "number" && Number.isFinite(r.lagSeconds) ? r.lagSeconds : null,
    note: str(r.note),
  };
}
