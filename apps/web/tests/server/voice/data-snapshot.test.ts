import { describe, expect, test } from "bun:test";

import { snapshotText } from "server/voice/data-snapshot";
import { getApp } from "shared/apps";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const row = (id: string, daysAgo: number, ingestedDaysAgo = daysAgo) => ({
  id,
  source: "inat",
  taxon: { id: "python-bivittatus", commonName: "Burmese python" },
  lat: 25.5,
  lon: -80.8,
  observedAt: day(daysAgo),
  quality: "RESEARCH",
  conflict: false,
  ingestedAt: day(ingestedDaysAgo),
});

describe("voice data snapshot", () => {
  test("counts by window, the newest sightings with their ids, late records and feed freshness", () => {
    const text = snapshotText(
      getApp("python"),
      [row("1", 0.2), row("2", 3), row("3", 20, 10), row("4", 6, 1)],
      [{ source: "inat", mode: "poll", state: "nominal", newestObservedAt: day(0.2), lastFetchAt: null, lastFetchRunId: null, lagSeconds: null, note: null }],
      NOW,
    );
    expect(text).toContain("last 24 hours: 1");
    expect(text).toContain("last 7 days: 3");
    expect(text).toContain("last 30 days: 4");
    expect(text).toContain("sighting:1");
    expect(text).toContain("2 were reported more than a day after");
    expect(text).toContain("inat nominal");
  });
});
