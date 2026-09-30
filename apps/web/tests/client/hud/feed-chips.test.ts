import { describe, expect, test } from "bun:test";

import type { FeedState } from "shared/feed-state";

import { feedChip, feedLabel, feedSummary, formatLag, normalizeFeedState } from "client/hud/topbar/feed-chips";

const base: FeedState = {
  source: "inat",
  mode: "poll",
  state: "nominal",
  newestObservedAt: "2026-09-30T20:10:00Z",
  lastFetchAt: "2026-09-30T20:12:00Z",
  lastFetchRunId: "812",
  lagSeconds: 240,
  note: null,
};

describe("feed chip mapping", () => {
  test("each C3 state maps to its own tone", () => {
    expect(feedChip({ ...base, state: "nominal" }).tone).toBe("ok");
    expect(feedChip({ ...base, state: "lagging" }).tone).toBe("warn");
    expect(feedChip({ ...base, state: "stale" }).tone).toBe("stale");
    expect(feedChip({ ...base, state: "down" }).tone).toBe("danger");
  });

  test("chip carries label, mode, lag, and a tooltip with the timestamps and the note", () => {
    const chip = feedChip({ ...base, source: "goes19", mode: "push", state: "down", lagSeconds: 7260, note: "No SQS delivery for 2 h" });
    expect(chip.label).toBe("GOES");
    expect(chip.mode).toBe("push");
    expect(chip.lag).toBe("2h 1m");
    expect(chip.title.split("\n")).toEqual([
      "goes19 · push · down",
      "lag 2h 1m · newest 09-30 20:10Z · fetched 09-30 20:12Z",
      "last run fetch:812",
      "No SQS delivery for 2 h",
    ]);
    expect(feedChip({ ...base, lastFetchRunId: null }).title).not.toContain("last run");
    expect(feedChip({ ...base, newestObservedAt: null, lastFetchAt: null }).title).toContain("newest never · fetched never");
  });

  test("labels: known sources get short names, unknown ones are upper-cased", () => {
    expect(feedLabel("openmeteo")).toBe("METEO");
    expect(feedLabel("coops")).toBe("CO-OPS");
    expect(feedLabel("openmeteo_marine")).toBe("METEO");
    expect(feedLabel("firecrawl")).toBe("FIRECRAWL");
  });

  test("lag formatting", () => {
    expect(formatLag(null)).toBe("—");
    expect(formatLag(-5)).toBe("—");
    expect(formatLag(Number.NaN)).toBe("—");
    expect(formatLag(0)).toBe("0s");
    expect(formatLag(59.4)).toBe("59s");
    expect(formatLag(60)).toBe("1m");
    expect(formatLag(3600)).toBe("1h");
    expect(formatLag(47 * 3600 + 59 * 60)).toBe("47h 59m");
    expect(formatLag(3 * 86400)).toBe("3d");
    expect(formatLag(3 * 86400 + 4 * 3600)).toBe("3d 4h");
  });

  test("summary is the worst state and the count of feeds off nominal", () => {
    const feeds = [base, { ...base, source: "nws", state: "lagging" as const }, { ...base, source: "goes19", state: "down" as const }];
    expect(feedSummary(feeds)).toEqual({ state: "down", tone: "danger", degraded: 2 });
    expect(feedSummary([])).toEqual({ state: "nominal", tone: "ok", degraded: 0 });
  });

  test("GraphQL rows with upper-case enums normalize to the C3 envelope; malformed rows are rejected", () => {
    expect(normalizeFeedState({ ...base, mode: "POLL", state: "STALE", lagSeconds: 900 })).toEqual({ ...base, state: "stale", lagSeconds: 900 });
    expect(normalizeFeedState({ source: "nws", mode: "PUSH", state: "NOMINAL" })).toEqual({
      source: "nws",
      mode: "push",
      state: "nominal",
      newestObservedAt: null,
      lastFetchAt: null,
      lastFetchRunId: null,
      lagSeconds: null,
      note: null,
    });
    expect(normalizeFeedState({ ...base, lastFetchRunId: 812 })?.lastFetchRunId).toBe("812");
    expect(normalizeFeedState({ ...base, state: "BROKEN" })).toBeNull();
    expect(normalizeFeedState({ ...base, mode: "stream" })).toBeNull();
    expect(normalizeFeedState({ ...base, source: "" })).toBeNull();
    expect(normalizeFeedState(null)).toBeNull();
    expect(normalizeFeedState("inat")).toBeNull();
  });
});
