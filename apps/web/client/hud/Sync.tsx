"use client";

import { useEffect } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import type { FeedState } from "shared/feed-state";

import { FEEDS, mergeFeedState, upsertFeedState } from "client/state/feeds";
import { TIME, timeWindow, type TimeState } from "client/state/time";
import { REGION_BBOX } from "client/state/view";
import { gqlRequest, gqlSubscribe, onFrameGrid } from "client/threads/api";

import { cell } from "./store";
import { alertSampleTimes, alertsQuery, alertsVariables, collectAlerts, type AlertRow } from "./timeline/alerts";
import { isLive } from "./topbar/clock";
import { FEED_FIELDS, normalizeFeedState } from "./topbar/feed-chips";

/** Alerts that touched the TIME window, for the timeline bands. */
export const alertRows = cell<AlertRow[]>([]);

const FEEDS_QUERY = `query HudFeeds { feeds { ${FEED_FIELDS} } }`;
const FEEDS_SUBSCRIPTION = `subscription HudFeedUpdates { feeds { ${FEED_FIELDS} } }`;
/** Alerts change on the scale of hours; refresh the bands this often while the window stays put. */
const ALERT_REFRESH_MS = 5 * 60_000;
/** A burst of grid republishes (one per refetched chunk) triggers one reload. */
const DATA_RELOAD_DEBOUNCE_MS = 1_000;
/** How often the live edge checks the clock; the window moves in 15-minute steps. */
const LIVE_TICK_MS = 20_000;

/** Current envelopes once, then realtime updates (PLAN.md C3). Feeds the top-bar chips. */
function FeedSync() {
  useEffect(() => {
    const controller = new AbortController();
    gqlRequest<{ feeds: unknown[] }>(FEEDS_QUERY, {}, controller.signal)
      .then(({ feeds }) => {
        const rows = feeds.map(normalizeFeedState).filter((f): f is FeedState => f !== null);
        set<FeedState[]>(FEEDS, (prev = []) => rows.reduce<FeedState[]>((list, f) => mergeFeedState(list, f), prev));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) console.warn("[hud] feeds query failed", err);
      });
    const stop = gqlSubscribe<{ feeds: unknown }>(FEEDS_SUBSCRIPTION, {}, ({ feeds }) => {
      const f = normalizeFeedState(feeds);
      if (f) upsertFeedState(f);
    });
    return () => {
      controller.abort();
      stop();
    };
  }, []);
  return null;
}

/** Alert rows for the window: one aliased request per window change, never per scrub. */
function AlertSync() {
  const from = useActiveState<TimeState, string>(TIME, (t) => t.from)[0];
  const to = useActiveState<TimeState, string>(TIME, (t) => t.to)[0];
  useEffect(() => {
    if (!from || !to) return;
    const controller = new AbortController();
    const load = () => {
      const samples = alertSampleTimes(Date.parse(from), Date.parse(to));
      if (samples.length === 0) return;
      gqlRequest<Record<string, AlertRow[]>>(alertsQuery(samples.length), alertsVariables(REGION_BBOX, samples), controller.signal)
        .then((data) => alertRows.set(collectAlerts(data)))
        .catch((err: unknown) => {
          if (!controller.signal.aborted) console.warn("[hud] alert bands query failed", err);
        });
    };
    load();
    const id = setInterval(load, ALERT_REFRESH_MS);
    // New rows reach Axum -> framesUpdated -> the db worker republishes the grid: reload the bands with it.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const offGrid = onFrameGrid(() => {
      if (first) return void (first = false);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(load, DATA_RELOAD_DEBOUNCE_MS);
    });
    return () => {
      controller.abort();
      clearInterval(id);
      offGrid();
      if (debounce) clearTimeout(debounce);
    };
  }, [from, to]);
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
        const next = timeWindow(Date.now());
        return next.to === prev.to && next.at === prev.at ? prev : { ...prev, ...next };
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
      <AlertSync />
      <LiveFollow />
    </>
  );
}
