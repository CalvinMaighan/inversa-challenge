/**
 * Detection bracket geometry (after God's Eye View `detectionDraw.js`): four L-shaped corners around an
 * anchor, no full box, so the entity underneath stays visible. Pure, so the canvas overlay and tests share it.
 */

export type Segment = [x0: number, y0: number, x1: number, y1: number];

/** Eight segments, two per corner, each `arm` px long, around a `2·half` square centred on (x, y). */
export function bracketSegments(x: number, y: number, half: number, arm: number): Segment[] {
  const a = Math.min(arm, half);
  const l = x - half;
  const r = x + half;
  const t = y - half;
  const b = y + half;
  return [
    [l, t + a, l, t],
    [l, t, l + a, t],
    [r - a, t, r, t],
    [r, t, r, t + a],
    [r, b - a, r, b],
    [r, b, r - a, b],
    [l + a, b, l, b],
    [l, b, l, b - a],
  ];
}

/** 0 → 1 over `fadeMs` after an entity first appears: the "acquire" ramp. */
export function acquireAlpha(firstSeenMs: number, nowMs: number, fadeMs: number): number {
  if (!(fadeMs > 0) || !Number.isFinite(firstSeenMs)) return 1;
  return Math.min(1, Math.max(0, (nowMs - firstSeenMs) / fadeMs));
}

/** Monospace label width without `measureText`: glyph count × advance, plus horizontal padding. */
export function monoWidth(text: string, advancePx: number, padPx: number): number {
  return Math.ceil(text.length * advancePx + padPx * 2);
}
