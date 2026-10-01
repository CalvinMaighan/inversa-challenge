/**
 * The carp stage timeline, drawn on one canvas: observed stage (USGS gauge height on its own datum, NWPS stage on
 * the flood-category datum), the forecast in force with the spread of recent issuances, flood thresholds, NWS
 * alert spans, the replay-coverage marker, now and the as-of cursor. Observations after the as-of time are drawn
 * hollow and dashed ("what happened next"). Pure apart from the 2D context it is handed.
 */
import { localDay } from "./format";
import type { SeriesPoint } from "./model";

export type ChartData = {
  fromMs: number;
  toMs: number;
  nowMs: number;
  /** The cursor: the as-of time, or now when live. */
  cursorMs: number;
  live: boolean;
  zone: string;
  usgsStage: readonly SeriesPoint[];
  nwpsObserved: readonly SeriesPoint[];
  forecast: readonly SeriesPoint[];
  spread: readonly { t: number; lo: number; hi: number }[];
  issuedMs: number | null;
  horizonMs: number | null;
  thresholds: readonly { label: string; ft: number }[];
  alerts: readonly { fromMs: number; toMs: number; label: string }[];
  coverageMs: number | null;
  /** Said across the plot when there is nothing (or not yet anything) to draw, so an empty chart never reads as calm. */
  message: string | null;
};

export type ChartColors = { text: string; muted: string; line: string; usgs: string; nwps: string; forecast: string; warn: string; danger: string; cursor: string; bg: string };

export const PAD = { left: 40, right: 92, top: 16, bottom: 18 };

export type Scale = { x: (t: number) => number; y: (v: number) => number; t: (x: number) => number; lo: number; hi: number; x0: number; x1: number; y0: number; y1: number };

/** Thresholds outside the y range: drawn as a note at the top edge instead of stretching the chart flat. */
export type OffChart = { label: string; ft: number; aboveFt: number }[];

/**
 * The y range: every drawn value, padded, plus the lowest threshold when it sits within one data span above the
 * data. Higher thresholds stay off the chart and are listed (`offChart`), so a 4 ft river under a 28 ft action
 * stage is not drawn as a flat line.
 */
export function yRange(d: Pick<ChartData, "usgsStage" | "nwpsObserved" | "forecast" | "spread" | "thresholds">): { lo: number; hi: number; offChart: OffChart } {
  const vals: number[] = [];
  for (const s of [d.usgsStage, d.nwpsObserved, d.forecast]) for (const p of s) vals.push(p.v);
  for (const p of d.spread) vals.push(p.lo, p.hi);
  if (vals.length === 0) {
    const t = d.thresholds.map((x) => x.ft);
    return t.length ? { lo: Math.min(...t) - 2, hi: Math.max(...t) + 1, offChart: [] } : { lo: 0, hi: 10, offChart: [] };
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = Math.max(1, hi - lo);
  const sorted = [...d.thresholds].sort((a, b) => a.ft - b.ft);
  for (const th of sorted) {
    if (th.ft >= lo - span && th.ft <= hi + span) {
      lo = Math.min(lo, th.ft);
      hi = Math.max(hi, th.ft);
    }
  }
  const pad = Math.max(0.3, (hi - lo) * 0.12);
  lo -= pad;
  hi += pad;
  const offChart = sorted.filter((th) => th.ft > hi || th.ft < lo).map((th) => ({ label: th.label, ft: th.ft, aboveFt: th.ft - hi }));
  return { lo, hi, offChart };
}

export function scale(width: number, height: number, d: Pick<ChartData, "fromMs" | "toMs">, lo: number, hi: number): Scale {
  const x0 = PAD.left;
  const x1 = Math.max(x0 + 10, width - PAD.right);
  const y0 = PAD.top;
  const y1 = Math.max(y0 + 10, height - PAD.bottom);
  const span = Math.max(1, d.toMs - d.fromMs);
  return {
    x: (t) => x0 + ((t - d.fromMs) / span) * (x1 - x0),
    t: (x) => d.fromMs + ((x - x0) / (x1 - x0)) * span,
    y: (v) => y1 - ((v - lo) / (hi - lo || 1)) * (y1 - y0),
    lo,
    hi,
    x0,
    x1,
    y0,
    y1,
  };
}

const THRESHOLD_COLOR: Record<string, keyof ChartColors> = { Action: "warn", "Minor flood": "warn", "Moderate flood": "danger", "Major flood": "danger" };

function polyline(ctx: CanvasRenderingContext2D, s: Scale, pts: readonly SeriesPoint[], gapMs: number) {
  ctx.beginPath();
  let prev: SeriesPoint | null = null;
  for (const p of pts) {
    const x = s.x(p.t);
    const y = s.y(p.v);
    if (!prev || p.t - prev.t > gapMs) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    prev = p;
  }
  ctx.stroke();
}

/** Draw the whole chart; returns the scale (for pointer → time) and the thresholds left off the chart. */
export function drawChart(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number, d: ChartData, c: ChartColors): { scale: Scale; offChart: OffChart; drawn: Drawn } {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const { lo, hi, offChart } = yRange(d);
  const s = scale(width, height, d, lo, hi);
  const font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.font = font;
  ctx.lineWidth = 1;

  // Before replay coverage: no forecast can be replayed; hatched.
  if (d.coverageMs !== null && d.coverageMs > d.fromMs) {
    const xc = Math.min(s.x1, s.x(d.coverageMs));
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x0, s.y0, xc - s.x0, s.y1 - s.y0);
    ctx.clip();
    ctx.strokeStyle = c.line;
    ctx.globalAlpha = 0.35;
    for (let x = s.x0 - (s.y1 - s.y0); x < xc; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, s.y1);
      ctx.lineTo(x + (s.y1 - s.y0), s.y0);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Alert spans along the top.
  for (const a of d.alerts) {
    const xa = Math.max(s.x0, s.x(a.fromMs));
    const xb = Math.min(s.x1, s.x(a.toMs));
    if (xb <= xa) continue;
    ctx.fillStyle = c.warn;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(xa, s.y0, xb - xa, s.y1 - s.y0);
    ctx.globalAlpha = 1;
    ctx.fillRect(xa, s.y0, xb - xa, 3);
    ctx.fillStyle = c.text;
    ctx.fillText(a.label.slice(0, 40), xa + 3, s.y0 + 12);
  }

  // Axes: day ticks (local days), stage ticks.
  ctx.strokeStyle = c.line;
  ctx.fillStyle = c.muted;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(s.x0, s.y1 + 0.5);
  ctx.lineTo(s.x1, s.y1 + 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const dayMs = 86_400_000;
  const pxPerDay = ((s.x1 - s.x0) / (d.toMs - d.fromMs)) * dayMs;
  const every = pxPerDay < 34 ? 3 : pxPerDay < 60 ? 2 : 1;
  let i = 0;
  for (let t = Math.ceil(d.fromMs / dayMs) * dayMs; t <= d.toMs; t += dayMs, i++) {
    const x = s.x(t);
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, s.y0);
    ctx.lineTo(x + 0.5, s.y1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (i % every === 0) ctx.fillText(localDay(t + 12 * 3_600_000, d.zone), x + 2, height - 5);
  }
  const empty = d.usgsStage.length + d.nwpsObserved.length + d.forecast.length === 0;
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; !empty && v <= hi; v += step) {
    const y = s.y(v);
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.moveTo(s.x0, y + 0.5);
    ctx.lineTo(s.x1, y + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(`${trim(v)} ft`, 2, y + 3);
  }

  // Flood thresholds (NWPS datum); labels in the right margin, nudged apart so none overprints another.
  let labelY = Infinity;
  const shown = d.thresholds.filter((th) => th.ft >= lo && th.ft <= hi).sort((a, b) => a.ft - b.ft);
  for (const th of shown) {
    const y = s.y(th.ft);
    ctx.strokeStyle = c[THRESHOLD_COLOR[th.label] ?? "warn"];
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(s.x0, y + 0.5);
    ctx.lineTo(s.x1, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    labelY = Math.min(y + 3, labelY - 11);
    ctx.fillStyle = c.text;
    ctx.fillText(`${th.label.replace(" flood", "")} ${trim(th.ft)} ft`, s.x1 + 4, labelY);
  }
  const above = offChart.find((o) => o.aboveFt > 0);
  if (above && labelY - 11 > s.y0 - 4) {
    ctx.fillStyle = c.muted;
    ctx.fillText(`${above.label.replace(" flood", "")} ${trim(above.ft)} ft ↑`, s.x1 + 4, Math.min(s.y0 + 3, labelY - 11));
  }

  // Series stay inside the plot (the threshold labels own the right margin).
  ctx.save();
  ctx.beginPath();
  ctx.rect(s.x0, s.y0 - 2, s.x1 - s.x0, s.y1 - s.y0 + 4);
  ctx.clip();

  // Forecast: spread band, then the line from issuance to horizon.
  if (d.spread.length > 1) {
    ctx.fillStyle = c.forecast;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    d.spread.forEach((p, k) => (k ? ctx.lineTo(s.x(p.t), s.y(p.hi)) : ctx.moveTo(s.x(p.t), s.y(p.hi))));
    for (let k = d.spread.length - 1; k >= 0; k--) ctx.lineTo(s.x(d.spread[k]!.t), s.y(d.spread[k]!.lo));
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (d.forecast.length) {
    ctx.strokeStyle = c.forecast;
    ctx.lineWidth = 2;
    polyline(ctx, s, d.forecast, 13 * 3_600_000);
    ctx.lineWidth = 1;
  }
  // Observations: known (solid) up to the cursor; after it, what happened next (dashed, hollow).
  const split = (pts: readonly SeriesPoint[]) => (d.live ? [pts, [] as SeriesPoint[]] : [pts.filter((p) => p.t <= d.cursorMs), pts.filter((p) => p.t > d.cursorMs)]);
  const [usgsKnown, usgsLater] = split(d.usgsStage);
  ctx.strokeStyle = c.usgs;
  ctx.lineWidth = 1.6;
  polyline(ctx, s, usgsKnown!, 2 * 3_600_000);
  ctx.setLineDash([3, 3]);
  ctx.globalAlpha = 0.75;
  polyline(ctx, s, usgsLater!, 2 * 3_600_000);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  const [nwpsKnown, nwpsLater] = split(d.nwpsObserved);
  for (const p of nwpsKnown!) {
    ctx.fillStyle = c.nwps;
    ctx.beginPath();
    ctx.arc(s.x(p.t), s.y(p.v), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = c.nwps;
  ctx.lineWidth = 1.4;
  for (const p of nwpsLater!) {
    ctx.beginPath();
    ctx.arc(s.x(p.t), s.y(p.v), 2.8, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.restore();

  if (d.horizonMs !== null) {
    const xh = s.x(d.horizonMs);
    ctx.fillStyle = c.forecast;
    if (xh <= s.x1) {
      ctx.fillRect(xh - 1, s.y0, 2, s.y1 - s.y0);
      ctx.fillText("horizon", Math.min(xh + 3, s.x1 - 44), s.y1 - 4);
    } else {
      ctx.fillText("horizon", s.x1 + 4, s.y1 - 16);
      ctx.fillText(`${localDay(d.horizonMs, d.zone)} →`, s.x1 + 4, s.y1 - 4);
    }
  }

  // Markers: replay coverage, now, cursor.
  const vline = (t: number, color: string, dash: number[], label: string | null, top: boolean) => {
    if (t < d.fromMs || t > d.toMs) return;
    const x = Math.round(s.x(t)) + 0.5;
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x, s.y0 - 4);
    ctx.lineTo(x, s.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = color;
      const w = ctx.measureText(label).width;
      const lx = Math.min(Math.max(s.x0, x + 3), s.x1 - w);
      ctx.fillText(label, lx, top ? s.y0 - 5 : s.y1 - 14);
    }
  };
  if (d.coverageMs !== null) {
    if (d.coverageMs >= d.fromMs) vline(d.coverageMs, c.text, [2, 2], "◂ replay coverage begins", true);
    else {
      ctx.fillStyle = c.muted;
      ctx.fillText(`◂ replay coverage began ${localDay(d.coverageMs, d.zone)}`, s.x0 + 2, s.y0 - 5);
    }
  }
  vline(d.nowMs, c.muted, [4, 3], d.live ? null : "now", false);
  if (!d.live) {
    ctx.lineWidth = 2;
    vline(d.cursorMs, c.cursor, [], null, true);
    ctx.lineWidth = 1;
  } else vline(d.nowMs, c.cursor, [], null, true);

  if (d.message) {
    ctx.font = "12px system-ui, sans-serif";
    const w = ctx.measureText(d.message).width + 16;
    const cx = (s.x0 + s.x1) / 2;
    const cy = (s.y0 + s.y1) / 2;
    ctx.fillStyle = c.bg;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(cx - w / 2, cy - 12, w, 24);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.line;
    ctx.strokeRect(cx - w / 2 + 0.5, cy - 11.5, w - 1, 23);
    ctx.fillStyle = c.text;
    ctx.textAlign = "center";
    ctx.fillText(d.message, cx, cy + 4);
    ctx.textAlign = "start";
    ctx.font = font;
  }
  const coverage = d.coverageMs === null ? "none" : d.coverageMs >= d.fromMs && d.coverageMs <= d.toMs ? "marker" : "note";
  return { scale: s, offChart, drawn: { thresholds: shown.length, later: usgsLater!.length + nwpsLater!.length, coverage } };
}

/** What one draw put on the canvas, for tests and the e2e (`data-*` on the canvas). */
export type Drawn = { thresholds: number; later: number; coverage: "marker" | "note" | "none" };

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

const trim = (v: number) => String(Math.round(v * 100) / 100);
