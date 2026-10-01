/** Feed-state envelope (PLAN.md C3). Mirrors api/src/feed_state.rs. */

export type FeedHealth = "nominal" | "lagging" | "stale" | "down";

export type FeedState = {
  source: string;
  mode: "push" | "webhook" | "poll";
  state: FeedHealth;
  newestObservedAt: string | null;
  lastFetchAt: string | null;
  /** `fetch_runs.id` of the latest run; cite it as `fetch:<id>` (PLAN.md C14). */
  lastFetchRunId: string | null;
  lagSeconds: number | null;
  note: string | null;
};

/** Worst state wins when summarizing several feeds. */
const RANK: Record<FeedHealth, number> = { nominal: 0, lagging: 1, stale: 2, down: 3 };

export function worstHealth(states: readonly FeedState[]): FeedHealth {
  return states.reduce<FeedHealth>((worst, s) => (RANK[s.state] > RANK[worst] ? s.state : worst), "nominal");
}
