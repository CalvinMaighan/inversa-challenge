/**
 * Canvas painter for the timeline track: day ticks, alert bands, the sighting sparkline, and hatched gaps.
 * Runs when its inputs change (window, grid version, counts, alerts, size, theme), never per scrub step: the
 * scrub cursor is the range input's thumb on top of the canvas.
 */
import type { FrameMeta } from "client/threads/api";

import type { AlertBand } from "./alerts";
import { severityToken } from "./alerts";
import { framesSpanMs } from "./frames";
import { gapSegments, type GapKind } from "./gaps";
import { bucketCounts, sparkY } from "./sparkline";

export type TrackColors = Record<"text" | "muted" | "accent" | "warn" | "danger" | "line", string>;

export type TrackData = {
  fromMs: number;
  toMs: number;
  /** Time axis of the grid that `flags` and `counts` index; null without a grid. */
  meta: FrameMeta | null;
  flags: Uint8Array | null;
  counts: ArrayLike<number> | null;
  bands: readonly AlertBand[];
};

/** Vertical layout of the track, CSS px. */
export const TRACK = { height: 56, alertTop: 3, alertLane: 4, sparkTop: 18, sparkHeight: 24, gapTop: 45, gapHeight: 9 } as const;

const DAY_MS = 86_400_000;

function hatchPattern(ctx: CanvasRenderingContext2D, color: string, reverse: boolean, dpr: number): CanvasPattern | null {
  const size = Math.round(6 * dpr);
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.strokeStyle = color;
  t.lineWidth = Math.max(1, dpr * 1.25);
  t.beginPath();
  // Two strokes so the diagonal tiles seamlessly.
  if (reverse) {
    t.moveTo(0, 0);
    t.lineTo(size, size);
    t.moveTo(-size / 2, size / 2);
    t.lineTo(size / 2, size * 1.5);
    t.moveTo(size / 2, -size / 2);
    t.lineTo(size * 1.5, size / 2);
  } else {
    t.moveTo(0, size);
    t.lineTo(size, 0);
    t.moveTo(-size / 2, size / 2);
    t.lineTo(size / 2, -size / 2);
    t.moveTo(size / 2, size * 1.5);
    t.lineTo(size * 1.5, size / 2);
  }
  t.stroke();
  const pattern = ctx.createPattern(tile, "repeat");
  pattern?.setTransform(new DOMMatrix().scale(1 / dpr));
  return pattern;
}

export function drawTrack(ctx: CanvasRenderingContext2D, width: number, dpr: number, data: TrackData, colors: TrackColors): void {
  const h = TRACK.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, h);
  const span = data.toMs - data.fromMs;
  if (!(width > 0) || !(span > 0)) return;
  const x = (ms: number) => ((ms - data.fromMs) / span) * width;

  // Day ticks (UTC midnights) and their labels.
  ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  const firstDay = Math.ceil(data.fromMs / DAY_MS) * DAY_MS;
  const dayPx = (DAY_MS / span) * width;
  const labelEvery = Math.max(1, Math.ceil(44 / dayPx));
  let dayIndex = 0;
  for (let t = firstDay; t <= data.toMs; t += DAY_MS, dayIndex++) {
    const px = Math.round(x(t)) + 0.5;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = colors.line;
    ctx.fillRect(px, TRACK.sparkTop - 2, 1, h - TRACK.sparkTop + 2);
    if (dayIndex % labelEvery === 0 && px + 30 < width) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = colors.muted;
      const d = new Date(t);
      ctx.fillText(`${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`, px + 3, TRACK.sparkTop);
    }
  }
  ctx.globalAlpha = 1;

  // Alert bands, one row per lane.
  for (const band of data.bands) {
    const x0 = Math.max(0, x(band.startMs));
    const x1 = Math.min(width, x(band.endMs));
    const tone = severityToken(band.severity);
    ctx.fillStyle = tone === "danger" ? colors.danger : tone === "warn" ? colors.warn : colors.muted;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x0, TRACK.alertTop + band.lane * (TRACK.alertLane + 1), Math.max(2, x1 - x0), TRACK.alertLane);
  }
  ctx.globalAlpha = 1;

  // Sighting sparkline, over the part of the window the grid covers. Clipped to the window.
  const meta = data.meta;
  if (meta && data.counts && data.counts.length > 0) {
    const n = Math.min(data.counts.length, meta.frameCount);
    const [s0, s1] = framesSpanMs(0, n, meta);
    const gx0 = x(s0);
    const gw = x(s1) - gx0;
    const buckets = bucketCounts(n === data.counts.length ? data.counts : Array.from({ length: n }, (_, i) => data.counts![i]!), Math.min(n, Math.max(1, Math.floor(gw / 2))));
    const b = buckets.values.length;
    const top = TRACK.sparkTop;
    const bottom = top + TRACK.sparkHeight;
    const px = (k: number) => gx0 + ((k + 0.5) / b) * gw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, h);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(gx0, bottom);
    for (let k = 0; k < b; k++) ctx.lineTo(px(k), top + sparkY(buckets.values[k], buckets.max, TRACK.sparkHeight));
    ctx.lineTo(gx0 + gw, bottom);
    ctx.closePath();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = colors.accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let k = 0; k < b; k++) {
      const py = top + sparkY(buckets.values[k], buckets.max, TRACK.sparkHeight);
      if (k === 0) ctx.moveTo(px(k), py);
      else ctx.lineTo(px(k), py);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Gaps: hatched, never interpolated. Env outages hatch the whole track; the rest their own lane.
  if (meta && data.flags && meta.frameCount > 0) {
    /** Pixel span of frames `[start, end)`, or null when it lies outside the window. */
    const segX = (start: number, end: number): [number, number] | null => {
      const [s0, s1] = framesSpanMs(start, end, meta);
      if (s1 <= data.fromMs || s0 >= data.toMs) return null;
      const x0 = Math.max(0, x(s0));
      return [x0, Math.max(x0 + 1, Math.min(width, x(s1)))];
    };
    const patterns: Partial<Record<GapKind, CanvasPattern | null>> = {
      env: hatchPattern(ctx, colors.danger, false, dpr),
      cloud: hatchPattern(ctx, colors.warn, false, dpr),
      quiet: hatchPattern(ctx, colors.muted, true, dpr),
    };
    for (const seg of gapSegments(data.flags)) {
      const range = segX(seg.start, seg.end);
      if (!range) continue;
      const [x0, x1] = range;
      if (seg.kind === "unloaded") {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = colors.muted;
        ctx.fillRect(x0, TRACK.gapTop, x1 - x0, TRACK.gapHeight);
        ctx.globalAlpha = 1;
        continue;
      }
      const pattern = patterns[seg.kind];
      if (!pattern) continue;
      ctx.fillStyle = pattern;
      if (seg.kind === "env") {
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x0, TRACK.sparkTop, x1 - x0, h - TRACK.sparkTop);
      } else if (seg.kind === "cloud") {
        ctx.globalAlpha = 0.3;
        ctx.fillRect(x0, TRACK.sparkTop, x1 - x0, TRACK.sparkHeight);
      }
      ctx.globalAlpha = 1;
      ctx.fillRect(x0, TRACK.gapTop, x1 - x0, TRACK.gapHeight);
    }
  }

  // Baseline under the gap lane.
  ctx.fillStyle = colors.line;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(0, h - 1, width, 1);
  ctx.globalAlpha = 1;
}
