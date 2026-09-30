/** Feed-state wire shape from the API and its mapping onto the C3 envelope. Pure. */
import type { FeedState } from "shared/feed-state";

export const FEED_FIELDS = "source mode state newestObservedAt lastFetchAt lagSeconds note";
export const FEEDS_QUERY = `{ feeds { ${FEED_FIELDS} } }`;
export const FEEDS_SUBSCRIPTION = `subscription { feeds { ${FEED_FIELDS} } }`;
export const FRAMES_UPDATED_SUBSCRIPTION = "subscription { framesUpdated { from to } }";

export type WireFeed = {
  source: string;
  mode: string;
  state: string;
  newestObservedAt?: string | null;
  lastFetchAt?: string | null;
  lagSeconds?: number | null;
  note?: string | null;
};

const HEALTH: readonly FeedState["state"][] = ["nominal", "lagging", "stale", "down"];

/** The API's enums are SCREAMING_CASE (async-graphql default); the C3 envelope is lowercase. */
export function normalizeFeed(f: WireFeed): FeedState {
  const health = f.state.toLowerCase() as FeedState["state"];
  return {
    source: f.source,
    mode: f.mode.toLowerCase() === "push" ? "push" : "poll",
    state: HEALTH.includes(health) ? health : "down",
    newestObservedAt: f.newestObservedAt ?? null,
    lastFetchAt: f.lastFetchAt ?? null,
    lagSeconds: f.lagSeconds ?? null,
    note: f.note ?? null,
  };
}
