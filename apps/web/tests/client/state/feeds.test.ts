import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { FEEDS, mergeFeedState, upsertFeedState } from "client/state/feeds";
import type { FeedState } from "shared/feed-state";

init(state);

const feed = (source: string, s: FeedState["state"] = "nominal"): FeedState => ({
  source,
  mode: "poll",
  state: s,
  newestObservedAt: null,
  lastFetchAt: null,
  lastFetchRunId: null,
  lagSeconds: null,
  note: null,
});

describe("FEEDS", () => {
  test("starts as an empty list", () => {
    expect(FEEDS.defaults).toEqual([]);
  });

  test("mergeFeedState replaces by source and keeps source order", () => {
    const list = mergeFeedState(mergeFeedState([], feed("nws")), feed("inat"));
    expect(list.map((f) => f.source)).toEqual(["inat", "nws"]);
    const updated = mergeFeedState(list, feed("nws", "stale"));
    expect(updated).toHaveLength(2);
    expect(updated.find((f) => f.source === "nws")?.state).toBe("stale");
    expect(list.find((f) => f.source === "nws")?.state).toBe("nominal");
  });

  test("upsertFeedState writes through the bus", () => {
    upsertFeedState(feed("goes", "lagging"));
    upsertFeedState(feed("coops"));
    upsertFeedState(feed("goes", "down"));
    expect(get<FeedState[]>(FEEDS)?.map((f) => `${f.source}:${f.state}`)).toEqual(["coops:nominal", "goes:down"]);
    set(FEEDS, []);
  });
});
