import { describe, expect, test } from "bun:test";

import { pct, pool, pooledBarsUnmet, type RunTally } from "@/eval/check";
import { evalRuns } from "@/eval/args";

/**
 * gates/leaf-J1.md G4: `--runs N` pools the runs. The pooled rate is the statistic (overall at least 95%, every
 * non-boundary category at least 90% over the pooled questions); boundary 100% and ungrounded 0 stay strict in every
 * single run; views must all be valid.
 */

const by = (rows: Record<string, [number, number]>) => new Map(Object.entries(rows).map(([c, [p, t]]) => [c, { passed: p, total: t }]));

function run(passed: number, total: number, cats: Record<string, [number, number]>, extra: Partial<RunTally> = {}): RunTally {
  return { passed, total, byCategory: by(cats), ungrounded: 0, checked: 40, viewsValid: 10, viewsTotal: 10, failedIds: [], ...extra };
}

describe("eval pooled", () => {
  test("eval pooled: sums passed, totals and categories over the runs; pct rounds down", () => {
    const p = pool([run(67, 69, { lookup: [6, 7], boundary: [9, 9] }, { failedIds: ["a", "b"] }), run(69, 69, { lookup: [7, 7], boundary: [9, 9] }), run(65, 69, { lookup: [6, 7], boundary: [9, 9] }, { failedIds: ["a", "c", "d", "e"] })]);
    expect(p.runs).toBe(3);
    expect([p.passed, p.total]).toEqual([201, 207]);
    expect(pct(p.passed, p.total)).toBe(97);
    expect(p.byCategory.get("lookup")).toEqual({ passed: 19, total: 21 });
    expect(p.boundaryMissRuns).toEqual([]);
    expect(p.ungroundedRuns).toEqual([]);
    expect(p.repeatFailures).toEqual([{ id: "a", runs: 2 }]);
    expect(pooledBarsUnmet(p, { overall: 95, category: 90 })).toEqual([]);
  });

  test("eval pooled: a category under 90% pooled is unmet even when the overall rate clears 95%", () => {
    const p = pool([run(68, 69, { explain: [5, 6] }), run(68, 69, { explain: [5, 6] }), run(68, 69, { explain: [5, 6] })]);
    expect(pct(p.passed, p.total)).toBe(98);
    expect(pooledBarsUnmet(p, { overall: 95, category: 90 })).toEqual(["category explain 83% < 90%"]);
    // The holdout applies no category bar.
    expect(pooledBarsUnmet(p, { overall: 90, category: null })).toEqual([]);
  });

  test("eval pooled: one boundary miss or one ungrounded number in any single run is unmet, whatever the pooled rate", () => {
    const boundary = pool([run(69, 69, { boundary: [9, 9] }), run(68, 69, { boundary: [8, 9] }), run(69, 69, { boundary: [9, 9] })]);
    expect(pooledBarsUnmet(boundary, { overall: 95, category: 90 })).toEqual(["boundary below 100% in run 2"]);
    const ungrounded = pool([run(69, 69, {}), run(69, 69, {}), run(69, 69, {}, { ungrounded: 1 })]);
    expect(pooledBarsUnmet(ungrounded, { overall: 95, category: 90 })).toEqual(["ungrounded number in run 3"]);
    const views = pool([run(69, 69, {}, { viewsValid: 9 })]);
    expect(pooledBarsUnmet(views, { overall: 95, category: 90 })).toEqual(["views valid 9/10"]);
  });

  test("eval pooled: the overall bar is on the pooled count, so 65/69 + 69/69 + 67/69 (97%) passes where 65/69 alone (94%) would not", () => {
    const single = pool([run(65, 69, {})]);
    expect(pooledBarsUnmet(single, { overall: 95, category: 90 })).toEqual(["overall 94% < 95%"]);
    const three = pool([run(65, 69, {}), run(69, 69, {}), run(67, 69, {})]);
    expect(pooledBarsUnmet(three, { overall: 95, category: 90 })).toEqual([]);
    expect(three.repeatFailures).toEqual([]);
  });

  test("eval pooled: --runs parses both spellings and rejects nonsense", () => {
    expect(evalRuns([])).toBe(1);
    expect(evalRuns(["--app", "carp", "--runs", "3"])).toBe(3);
    expect(evalRuns(["--runs=2", "--holdout"])).toBe(2);
    expect(() => evalRuns(["--runs", "0"])).toThrow();
    expect(() => evalRuns(["--runs", "x"])).toThrow();
  });
});
