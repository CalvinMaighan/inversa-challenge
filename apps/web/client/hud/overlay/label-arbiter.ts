/**
 * Label arbiter for detection brackets (after God's Eye View `labelArbiter.js`).
 *
 * Each candidate is an anchor on screen (a projected entity) with a label size and a priority. A label may
 * sit at one of four corners of its bracket. Candidates are placed in order: labels that were shown last
 * solve first (so a steady scene does not flicker), then by priority, then by key. Each tries the corner it
 * used last, then NE, NW, SE, SW, and takes the first that stays on screen and overlaps nothing placed so
 * far, including the brackets themselves. A candidate with no free corner is hidden this solve.
 *
 * Collision tests go through a uniform grid of `cellPx` buckets, so a solve is O(n) for a sparse scene
 * instead of O(n²).
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Corner = "ne" | "nw" | "se" | "sw";
export const CORNERS: readonly Corner[] = ["ne", "nw", "se", "sw"];

export type LabelCandidate = {
  key: string;
  /** Anchor, CSS px. */
  x: number;
  y: number;
  /** Label size, CSS px. */
  w: number;
  h: number;
  /** Half-size of the bracket around the anchor; the label sits just outside it. */
  bracket: number;
  /** Higher wins. */
  priority: number;
};

export type LabelPlacement = { key: string; corner: Corner; rect: Rect };

export type ArbiterOptions = {
  cellPx?: number;
  /** Minimum clear space between two rects. */
  padding?: number;
  /** Gap between bracket and label; raised to `padding` if smaller. */
  gap?: number;
};

/** Overlap test with `padding` px of required clearance. */
export function overlaps(a: Rect, b: Rect, padding: number): boolean {
  return a.x < b.x + b.w + padding && a.x + a.w + padding > b.x && a.y < b.y + b.h + padding && a.y + a.h + padding > b.y;
}

/** Label rect for a candidate at a corner. */
export function cornerRect(c: LabelCandidate, corner: Corner, gap: number): Rect {
  const east = corner === "ne" || corner === "se";
  const north = corner === "ne" || corner === "nw";
  return {
    x: east ? c.x + c.bracket + gap : c.x - c.bracket - gap - c.w,
    y: north ? c.y - c.bracket - c.h : c.y + c.bracket,
    w: c.w,
    h: c.h,
  };
}

/** Uniform grid over rects. Rebuilt per solve; buckets are cleared, not reallocated. */
export class SpatialGrid {
  private readonly cells = new Map<number, Rect[]>();

  constructor(
    private readonly cellPx: number,
    private readonly padding: number,
  ) {}

  clear(): void {
    for (const bucket of this.cells.values()) bucket.length = 0;
  }

  private span(r: Rect): [number, number, number, number] {
    const p = this.padding;
    return [
      Math.floor((r.x - p) / this.cellPx),
      Math.floor((r.y - p) / this.cellPx),
      Math.floor((r.x + r.w + p) / this.cellPx),
      Math.floor((r.y + r.h + p) / this.cellPx),
    ];
  }

  /** Cell coordinates packed into one integer; ±32k cells covers any screen. */
  private static key(cx: number, cy: number): number {
    return ((cx + 32768) << 16) | ((cy + 32768) & 0xffff);
  }

  collides(r: Rect): boolean {
    const [x0, y0, x1, y1] = this.span(r);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.cells.get(SpatialGrid.key(cx, cy));
        if (!bucket) continue;
        for (const other of bucket) if (overlaps(r, other, this.padding)) return true;
      }
    }
    return false;
  }

  add(r: Rect): void {
    const [x0, y0, x1, y1] = this.span(r);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = SpatialGrid.key(cx, cy);
        let bucket = this.cells.get(k);
        if (!bucket) this.cells.set(k, (bucket = []));
        bucket.push(r);
      }
    }
  }
}

export class LabelArbiter {
  private readonly padding: number;
  private readonly gap: number;
  private readonly grid: SpatialGrid;
  /** Corner each key used when last shown. */
  private readonly sticky = new Map<string, Corner>();

  constructor(options: ArbiterOptions = {}) {
    this.padding = options.padding ?? 4;
    // A gap under the padding would make every label collide with its own bracket.
    this.gap = Math.max(this.padding, options.gap ?? 4);
    this.grid = new SpatialGrid(options.cellPx ?? 32, this.padding);
  }

  /**
   * Place labels inside a `width × height` viewport, clear of `obstacles` (HUD panels and bars). Returns the
   * shown labels; the rest are hidden.
   */
  solve(candidates: readonly LabelCandidate[], width: number, height: number, obstacles: readonly Rect[] = []): LabelPlacement[] {
    this.grid.clear();
    for (const o of obstacles) if (o.w > 0 && o.h > 0) this.grid.add(o);
    const live = candidates.filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && c.w > 0 && c.h > 0);
    // Brackets are obstacles: a label must not cover another entity's bracket.
    for (const c of live) this.grid.add({ x: c.x - c.bracket, y: c.y - c.bracket, w: c.bracket * 2, h: c.bracket * 2 });

    const order = [...live].sort((a, b) => {
      const ia = this.sticky.has(a.key) ? 1 : 0;
      const ib = this.sticky.has(b.key) ? 1 : 0;
      if (ia !== ib) return ib - ia;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    const placed: LabelPlacement[] = [];
    const shown = new Set<string>();
    for (const c of order) {
      const last = this.sticky.get(c.key);
      const tries = last ? [last, ...CORNERS.filter((k) => k !== last)] : CORNERS;
      for (const corner of tries) {
        const rect = cornerRect(c, corner, this.gap);
        if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) continue;
        if (this.grid.collides(rect)) continue;
        this.grid.add(rect);
        placed.push({ key: c.key, corner, rect });
        shown.add(c.key);
        this.sticky.set(c.key, corner);
        break;
      }
    }
    for (const key of [...this.sticky.keys()]) if (!shown.has(key)) this.sticky.delete(key);
    return placed;
  }
}
