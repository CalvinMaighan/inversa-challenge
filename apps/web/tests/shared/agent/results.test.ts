import { describe, expect, test } from "bun:test";

import { isToolResultData } from "shared/agent/results";

describe("isToolResultData", () => {
  test("accepts every view kind and a bare highlight", () => {
    for (const view of ["table", "series", "cells", "explain", "backtest", "feeds"]) {
      expect(isToolResultData({ result: { view } })).toBe(true);
    }
    expect(isToolResultData({ highlight: ["sighting:1"] })).toBe(true);
    expect(isToolResultData({})).toBe(true);
  });

  test("rejects unknown views and non-objects", () => {
    expect(isToolResultData({ result: { view: "pie" } })).toBe(false);
    expect(isToolResultData({ result: null })).toBe(false);
    expect(isToolResultData(null)).toBe(false);
    expect(isToolResultData("table")).toBe(false);
  });
});
