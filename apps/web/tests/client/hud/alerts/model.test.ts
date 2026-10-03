import { describe, expect, test } from "bun:test";

import { describeSource, hasNewData, latestMs, liveRows } from "client/hud/alerts/model";
import { ALERTS_SEEN } from "client/state/alerts";
import type { FeedState } from "shared/feed-state";

const feed = (source: string, newestObservedAt: string | null, lastFetchAt: string | null = null): FeedState => ({ source, mode: "poll", state: "nominal", newestObservedAt, lastFetchAt, lastFetchRunId: null, lagSeconds: null, note: null });
const NOW = Date.parse("2026-10-02T12:00:00Z");

describe("live data rows", () => {
  const feeds = [feed("nas", "2026-10-01T12:00:00Z"), feed("inat", "2026-10-02T11:50:00Z", "2026-10-02T11:58:00Z"), feed("ndbc", null)];

  test("freshest first, sources that have not reported left out", () => {
    const rows = liveRows(feeds, NOW);
    expect(rows.map((r) => r.source)).toEqual(["inat", "nas"]);
    expect(rows[0]).toMatchObject({ label: "iNaturalist", what: "photo sightings by the public" });
    expect(describeSource("nws-alerts").name).not.toBe(describeSource("nws-forecast").name);
    expect(describeSource("mystery")).toEqual({ name: "MYSTERY", what: "" });
    expect(rows[0]!.age).toBe("10m ago");
    expect(rows[1]!.age).toBe("24h ago");
    expect(rows[0]!.fetchedMs).toBe(Date.parse("2026-10-02T11:58:00Z"));
    expect(rows[0]!.checked).toBe("2m ago");
    expect(rows[1]!.checked).toBeNull();
  });

  test("latestMs is the newest record anywhere", () => {
    expect(latestMs(feeds)).toBe(Date.parse("2026-10-02T11:50:00Z"));
    expect(latestMs([])).toBe(0);
  });

  test("a dot only when something is newer than what was seen; the first look sets the baseline", () => {
    expect(hasNewData(feeds, 0)).toBe(false);
    expect(hasNewData(feeds, Date.parse("2026-10-02T11:50:00Z"))).toBe(false);
    expect(hasNewData(feeds, Date.parse("2026-10-02T11:40:00Z"))).toBe(true);
  });

  test("ALERTS_SEEN starts at zero", () => {
    expect(ALERTS_SEEN.defaults).toBe(0);
  });
});
