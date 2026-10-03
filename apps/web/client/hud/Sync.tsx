"use client";

import { useEffect } from "react";
import { get, set } from "@calvinjs/active-state";

import type { FeedState } from "shared/feed-state";

import { FEEDS, mergeFeedState, upsertFeedState } from "client/state/feeds";
import { DEFAULT_RANGE_DAYS, RANGE_DAYS } from "client/state/range";
import { TIME, timeWindow, type TimeState } from "client/state/time";
import { gqlRequest, gqlSubscribe } from "client/threads/api";

import { isLive } from "./topbar/clock";
import { FEED_FIELDS, shownFeedState } from "./topbar/feed-chips";

const FEEDS_QUERY = `query HudFeeds { feeds { ${FEED_FIELDS} } }`;
const FEEDS_SUBSCRIPTION = `subscription HudFeedUpdates { feeds { ${FEED_FIELDS} } }`;
/** How often the live edge checks the clock; the window moves in 15-minute steps. */
const LIVE_TICK_MS = 20_000;

/** Current envelopes once, then realtime updates (PLAN.md C3). Feeds the About popover. */
function FeedSync() {
  useEffect(() => {
    const controller = new AbortController();
    gqlRequest<{ feeds: unknown[] }>(FEEDS_QUERY, {}, controller.signal)
      .then(({ feeds }) => {
        const rows = feeds.map(shownFeedState).filter((f): f is FeedState => f !== null);
        set<FeedState[]>(FEEDS, (prev = []) => rows.reduce<FeedState[]>((list, f) => mergeFeedState(list, f), prev));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) console.warn("[hud] feeds query failed", err);
      });
    const stop = gqlSubscribe<{ feeds: unknown }>(FEEDS_SUBSCRIPTION, {}, ({ feeds }) => {
      const f = shownFeedState(feeds);
      if (f) upsertFeedState(f);
    });
    return () => {
      controller.abort();
      stop();
    };
  }, []);
  return null;
}


/**
 * PLAN.md C18: at the live edge TIME follows now. The window slides forward with the clock, the db worker
 * appends the new hours (boot.ts refetches when the bounds move), and the cursor stays on the edge. Scrubbing
 * back or playing leaves the edge; the Live button returns to it.
 */
function LiveFollow() {
  useEffect(() => {
    const tick = () =>
      set<TimeState>(TIME, (prev = TIME.defaults) => {
        if (prev.playing || !isLive(prev, Date.now())) return prev;
        // The window is the chosen period long (the range button), sliding with the clock.
        const next = timeWindow(Date.now(), get<number>(RANGE_DAYS) ?? DEFAULT_RANGE_DAYS);
        return next.to === prev.to && next.at === prev.at && next.from === prev.from ? prev : { ...prev, ...next };
      });
    tick();
    const id = setInterval(tick, LIVE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return null;
}

export default function Sync() {
  return (
    <>
      <FeedSync />
      <LiveFollow />
    </>
  );
}
