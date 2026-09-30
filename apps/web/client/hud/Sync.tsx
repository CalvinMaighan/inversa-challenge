"use client";

import { useEffect } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import type { FeedState } from "shared/feed-state";

import { FEEDS, mergeFeedState, upsertFeedState } from "client/state/feeds";
import { TIME, type TimeState } from "client/state/time";
import { REGION_BBOX } from "client/state/view";
import { gqlRequest, gqlSubscribe } from "client/threads/api";

import { cell } from "./store";
import { alertSampleTimes, alertsQuery, alertsVariables, collectAlerts, type AlertRow } from "./timeline/alerts";
import { FEED_FIELDS, normalizeFeedState } from "./topbar/feed-chips";

/** Alerts that touched the TIME window, for the timeline bands. */
export const alertRows = cell<AlertRow[]>([]);

const FEEDS_QUERY = `query HudFeeds { feeds { ${FEED_FIELDS} } }`;
const FEEDS_SUBSCRIPTION = `subscription HudFeedUpdates { feeds { ${FEED_FIELDS} } }`;
/** Alerts change on the scale of hours; refresh the bands this often while the window stays put. */
const ALERT_REFRESH_MS = 5 * 60_000;

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
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [from, to]);
  return null;
}

export default function Sync() {
  return (
    <>
      <FeedSync />
      <AlertSync />
    </>
  );
}
