import { describe, expect, test } from "bun:test";

import {
  ION_COMMUNITY_LIMITS,
  monthKey,
  QUOTA_STORAGE_KEY,
  quotaExhausted,
  quotaUsage,
  readQuota,
  recordQuota,
  type QuotaStore,
} from "client/globe/quota";

function memoryStore(): QuotaStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

const SEPT = Date.parse("2026-09-15T12:00:00Z");
const OCT = Date.parse("2026-10-01T00:00:01Z");

describe("ion quota counter", () => {
  test("monthKey is the UTC calendar month", () => {
    expect(monthKey(SEPT)).toBe("2026-09");
    expect(monthKey(Date.parse("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(monthKey(OCT)).toBe("2026-10");
  });

  test("counts sessions and root tiles separately and persists them", () => {
    const store = memoryStore();
    recordQuota(store, "sessions", SEPT);
    recordQuota(store, "sessions", SEPT);
    recordQuota(store, "rootTiles", SEPT, 3);
    expect(readQuota(store, SEPT)).toEqual({ month: "2026-09", sessions: 2, rootTiles: 3 });
    expect(JSON.parse(store.map.get(QUOTA_STORAGE_KEY)!)).toEqual({ month: "2026-09", sessions: 2, rootTiles: 3 });
  });

  test("a new month starts from zero", () => {
    const store = memoryStore();
    recordQuota(store, "sessions", SEPT, 950);
    expect(readQuota(store, OCT)).toEqual({ month: "2026-10", sessions: 0, rootTiles: 0 });
    expect(recordQuota(store, "sessions", OCT)).toEqual({ month: "2026-10", sessions: 1, rootTiles: 0 });
  });

  test("exhausted at 90 % of either Community limit (1,000)", () => {
    expect(ION_COMMUNITY_LIMITS).toEqual({ sessions: 1000, rootTiles: 1000 });
    const at = (sessions: number, rootTiles: number) => ({ month: "2026-09", sessions, rootTiles });
    expect(quotaExhausted(at(899, 0))).toBe(false);
    expect(quotaExhausted(at(900, 0))).toBe(true);
    expect(quotaExhausted(at(0, 899))).toBe(false);
    expect(quotaExhausted(at(12, 900))).toBe(true);
    expect(quotaUsage(at(450, 100))).toBeCloseTo(0.45);
  });

  test("garbage, a throwing store and no store all read as zero; writes never throw", () => {
    const bad = memoryStore();
    bad.map.set(QUOTA_STORAGE_KEY, "{not json");
    expect(readQuota(bad, SEPT).sessions).toBe(0);
    bad.map.set(QUOTA_STORAGE_KEY, JSON.stringify({ month: "2026-09", sessions: -4, rootTiles: "x" }));
    expect(readQuota(bad, SEPT)).toEqual({ month: "2026-09", sessions: 0, rootTiles: 0 });

    const throwing: QuotaStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readQuota(throwing, SEPT).sessions).toBe(0);
    expect(recordQuota(throwing, "sessions", SEPT).sessions).toBe(1);
    expect(recordQuota(null, "rootTiles", SEPT).rootTiles).toBe(1);
  });
});
