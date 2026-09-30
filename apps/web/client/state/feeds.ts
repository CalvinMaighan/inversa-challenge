import { key, set } from "@calvinjs/active-state";

import type { FeedState } from "shared/feed-state";

/** Latest envelope per source (PLAN.md C3), sorted by source id so chips keep a stable order. */
export const FEEDS = key("FEEDS", [] as FeedState[]);

/** Replace the entry for `next.source`, or add it. Returns the new list. */
export function mergeFeedState(list: readonly FeedState[], next: FeedState): FeedState[] {
  const rest = list.filter((f) => f.source !== next.source);
  return [...rest, next].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** Apply one realtime `FeedState` event to the store. */
export function upsertFeedState(next: FeedState): void {
  set<FeedState[]>(FEEDS, (prev = []) => mergeFeedState(prev, next));
}
