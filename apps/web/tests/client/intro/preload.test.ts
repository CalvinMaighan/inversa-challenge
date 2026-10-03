import { describe, expect, test } from "bun:test";

import { interleave, warmUrls } from "client/intro/preload";
import { MAX_CHUNK_FRAMES } from "client/threads/db/frames";
import { APP_IDS } from "shared/apps";

const NOW = Date.parse("2026-10-03T12:20:00Z");
const [CARP_ID, LIONFISH_ID, PYTHON_ID] = APP_IDS;

describe("background preload plan", () => {
  test("carp has no frames to warm (its sightings load through the carp store)", () => {
    expect(warmUrls(CARP_ID, NOW)).toEqual([]);
  });

  test("a species app warms two years of hourly frame chunks at the app's frames path, newest first", () => {
    const urls = warmUrls(LIONFISH_ID, NOW);
    expect(urls.length).toBeGreaterThanOrEqual(23);
    expect(urls.length).toBeLessThanOrEqual(26);
    expect(urls.every((u) => u.startsWith(`/v1/${LIONFISH_ID}/frames?from=`))).toBe(true);
    const params = urls.map((u) => new URL(u, "http://x").searchParams);
    const froms = params.map((p) => Date.parse(p.get("from")!));
    expect([...froms].sort((a, b) => b - a)).toEqual(froms);
    for (const p of params) {
      const frames = (Date.parse(p.get("to")!) - Date.parse(p.get("from")!)) / 3_600_000 + 1;
      expect(frames).toBeLessThanOrEqual(MAX_CHUNK_FRAMES);
      expect(p.get("step")).toBe("60");
    }
    // The newest chunk reaches the live edge and the oldest starts two years back.
    expect(Date.parse(params[0]!.get("to")!)).toBeLessThanOrEqual(NOW);
    expect(Date.parse(params[0]!.get("to")!)).toBeGreaterThan(NOW - 3_600_000 * 2);
    expect(NOW - Math.min(...froms)).toBeGreaterThan(729 * 86_400_000);
  });

  test("the URLs are the ones the db worker asks for, so its request is a cache hit", () => {
    expect(warmUrls(PYTHON_ID, NOW)).toEqual(warmUrls(PYTHON_ID, NOW));
    expect(warmUrls(PYTHON_ID, NOW)[0]).not.toBe(warmUrls(LIONFISH_ID, NOW)[0]);
  });

  test("interleave takes one URL of each app in turn", () => {
    expect(interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]])).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
    expect(interleave([])).toEqual([]);
  });
});
