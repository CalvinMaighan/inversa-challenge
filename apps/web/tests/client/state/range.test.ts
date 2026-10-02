import { describe, expect, test } from "bun:test";

import { DEFAULT_RANGE_DAYS, RANGE_DAYS, RANGE_OPTIONS, rangeLabel } from "client/state/range";

describe("RANGE_DAYS", () => {
  test("defaults to one year", () => {
    expect(DEFAULT_RANGE_DAYS).toBe(730);
    expect(RANGE_DAYS.defaults).toBe(730);
  });

  test("offers 30, 90, 180 days, 1 year and 2 years, shortest first", () => {
    expect(RANGE_OPTIONS.map((o) => o.days)).toEqual([30, 90, 180, 365, 730]);
    expect(RANGE_OPTIONS.map((o) => o.label)).toEqual(["30 days", "90 days", "180 days", "1 year", "2 years"]);
    expect(RANGE_OPTIONS.some((o) => o.days === DEFAULT_RANGE_DAYS)).toBe(true);
  });

  test("rangeLabel names a choice and falls back to the day count", () => {
    expect(rangeLabel(365)).toBe("1 year");
    expect(rangeLabel(730)).toBe("2 years");
    expect(rangeLabel(45)).toBe("45 days");
  });
});
