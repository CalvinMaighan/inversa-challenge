import { describe, expect, test } from "bun:test";

import { bracketSegments, acquireAlpha, monoWidth } from "client/hud/overlay/brackets";
import { cornerRect, LabelArbiter, overlaps, SpatialGrid, type LabelCandidate, type Rect } from "client/hud/overlay/label-arbiter";

const cand = (key: string, x: number, y: number, priority = 0, w = 80, h = 18, bracket = 12): LabelCandidate => ({ key, x, y, w, h, bracket, priority });

function assertNoOverlap(rects: Rect[], padding: number) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!, padding)).toBe(false);
  }
}

describe("label arbiter", () => {
  test("a lone label takes the NE corner, just outside its bracket", () => {
    const arbiter = new LabelArbiter({ padding: 4, gap: 5 });
    const [p] = arbiter.solve([cand("a", 400, 300)], 800, 600);
    expect(p!.corner).toBe("ne");
    expect(p!.rect).toEqual({ x: 400 + 12 + 5, y: 300 - 12 - 18, w: 80, h: 18 });
  });

  test("collisions: two entities at the same point get different corners", () => {
    const arbiter = new LabelArbiter();
    const placed = arbiter.solve([cand("a", 400, 300, 2), cand("b", 400, 300, 1)], 800, 600);
    expect(placed.map((p) => p.key)).toEqual(["a", "b"]);
    expect(placed[0]!.corner).not.toBe(placed[1]!.corner);
    assertNoOverlap(
      placed.map((p) => p.rect),
      4,
    );
  });

  test("collisions: a crowd at one point shows four labels, highest priority first, and hides the rest", () => {
    const arbiter = new LabelArbiter();
    const crowd = Array.from({ length: 7 }, (_, i) => cand(`e${i}`, 400, 300, i));
    const placed = arbiter.solve(crowd, 800, 600);
    expect(placed.length).toBe(4);
    expect(placed.map((p) => p.key)).toEqual(["e6", "e5", "e4", "e3"]);
    expect(new Set(placed.map((p) => p.corner)).size).toBe(4);
  });

  test("collisions: a label never covers another entity's bracket", () => {
    const arbiter = new LabelArbiter({ padding: 4, gap: 5 });
    // b sits exactly where a's NE label would go.
    const a = cand("a", 300, 300, 5);
    const ne = cornerRect(a, "ne", 5);
    const b = cand("b", ne.x + 20, ne.y + 9, 1, 40, 18, 10);
    const placed = arbiter.solve([a, b], 800, 600);
    const aRect = placed.find((p) => p.key === "a")!;
    expect(aRect.corner).not.toBe("ne");
    const bBracket = { x: b.x - 10, y: b.y - 10, w: 20, h: 20 };
    expect(overlaps(aRect.rect, bBracket, 4)).toBe(false);
  });

  test("collisions: HUD panels passed as obstacles push labels to a free corner, or hide them", () => {
    const arbiter = new LabelArbiter({ padding: 4, gap: 5 });
    // A drawer covering everything right of x = 440.
    const drawer = { x: 440, y: 0, w: 360, h: 600 };
    const [p] = arbiter.solve([cand("a", 400, 300)], 800, 600, [drawer]);
    expect(p!.corner).toBe("nw");
    expect(overlaps(p!.rect, drawer, 4)).toBe(false);
    // Fully covered: no label.
    expect(arbiter.solve([cand("b", 600, 300)], 800, 600, [{ x: 0, y: 0, w: 800, h: 600 }])).toEqual([]);
  });

  test("labels stay inside the viewport: an anchor at the top-right edge flips to SW", () => {
    const arbiter = new LabelArbiter();
    const [p] = arbiter.solve([cand("edge", 790, 10)], 800, 600);
    expect(p!.corner).toBe("sw");
    expect(p!.rect.x).toBeGreaterThanOrEqual(0);
    expect(p!.rect.x + p!.rect.w).toBeLessThanOrEqual(800);
  });

  test("sticky corners: a label keeps its corner when a newcomer would prefer it", () => {
    const arbiter = new LabelArbiter();
    // First solve: a is forced to NW by the right edge.
    let placed = arbiter.solve([cand("a", 700, 300, 1)], 790, 600);
    expect(placed[0]!.corner).toBe("nw");
    // The viewport widens so NE is free again; the incumbent keeps NW instead of jumping.
    placed = arbiter.solve([cand("a", 700, 300, 1)], 1200, 600);
    expect(placed[0]!.corner).toBe("nw");
    // An incumbent also wins its slot over a higher-priority newcomer at the same point.
    placed = arbiter.solve([cand("a", 700, 300, 1), cand("b", 700, 300, 9)], 1200, 600);
    expect(placed.map((p) => [p.key, p.corner])).toEqual([
      ["a", "nw"],
      ["b", "ne"],
    ]);
  });

  test("hidden labels lose their sticky corner", () => {
    const arbiter = new LabelArbiter();
    arbiter.solve([cand("a", 700, 300, 1)], 790, 600);
    arbiter.solve([], 790, 600);
    const [p] = arbiter.solve([cand("a", 700, 300, 1)], 1200, 600);
    expect(p!.corner).toBe("ne");
  });

  test("non-finite anchors are skipped", () => {
    const arbiter = new LabelArbiter();
    expect(arbiter.solve([cand("nan", Number.NaN, 5)], 800, 600)).toEqual([]);
  });

  test("collisions: a random scene never produces overlapping labels, and the grid agrees with brute force", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 20; round++) {
      const arbiter = new LabelArbiter({ padding: 3, gap: 4, cellPx: 24 });
      const scene = Array.from({ length: 60 }, (_, i) => cand(`k${i}`, rand() * 1000, rand() * 700, Math.floor(rand() * 5), 40 + rand() * 80, 18, 8 + rand() * 8));
      const placed = arbiter.solve(scene, 1000, 700);
      expect(placed.length).toBeGreaterThan(0);
      assertNoOverlap(
        placed.map((p) => p.rect),
        3,
      );

      const grid = new SpatialGrid(24, 3);
      const rects: Rect[] = [];
      for (let i = 0; i < 80; i++) {
        const r = { x: rand() * 900, y: rand() * 600, w: 5 + rand() * 90, h: 5 + rand() * 40 };
        const brute = rects.some((o) => overlaps(r, o, 3));
        expect(grid.collides(r)).toBe(brute);
        grid.add(r);
        rects.push(r);
      }
    }
  });
});

describe("brackets", () => {
  test("eight corner segments, arms clamped to the half-size", () => {
    const segs = bracketSegments(100, 100, 10, 4);
    expect(segs.length).toBe(8);
    expect(segs[0]).toEqual([90, 94, 90, 90]);
    expect(bracketSegments(0, 0, 3, 10)[1]).toEqual([-3, -3, 0, -3]);
  });

  test("acquire ramp and mono width", () => {
    expect(acquireAlpha(1000, 1090, 180)).toBeCloseTo(0.5);
    expect(acquireAlpha(1000, 5000, 180)).toBe(1);
    expect(acquireAlpha(Number.NaN, 0, 180)).toBe(1);
    expect(monoWidth("HOTSPOT", 6.6, 6)).toBe(59);
  });
});
