/**
 * Canvas drawing for the lionfish globe overlay: CRW heat pixels (fill = DHW, accumulated; outline = BAA, today's
 * alert, so both read at once), hatching for stale and missing products, and field-window glyphs. Pure apart
 * from the 2D context; `project` maps lon/lat to CSS px (null behind the globe).
 */
import { baaWord, heatAt, type HeatPixel, type MarinePoint } from "./model";

export type Project = (lon: number, lat: number) => { x: number; y: number } | null;

/** DHW fill stops (°C-weeks), low to high. Blue-violet to magenta: not the red/amber of alerts in the HUD. */
export const DHW_STOPS: readonly { at: number; color: string; label: string }[] = [
  { at: 0, color: "#3b6fb6", label: "< 1" },
  { at: 1, color: "#3fa7b3", label: "1–4" },
  { at: 4, color: "#e3b23c", label: "4–8" },
  { at: 8, color: "#e0663a", label: "8–12" },
  { at: 12, color: "#b8327a", label: "12+" },
];

export function dhwColor(dhw: number): string {
  let c = DHW_STOPS[0]!.color;
  for (const s of DHW_STOPS) if (dhw >= s.at) c = s.color;
  return c;
}

/** BAA outline: none for no stress, thicker and lighter as the alert rises. */
export function baaStroke(baa: number | null): { width: number; color: string } {
  if (baa === null) return { width: 1, color: "rgba(200,200,200,0.6)" };
  if (baa < 1) return { width: 0, color: "transparent" };
  if (baa < 2) return { width: 1.5, color: "#f4f1de" };
  if (baa < 3) return { width: 2, color: "#ffd166" };
  return { width: 3, color: "#ff5d8f" };
}

const HALF_PIXEL_DEG = 0.025;

function hatch(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 8;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.strokeStyle = color;
  t.lineWidth = 1.5;
  t.beginPath();
  t.moveTo(0, 8);
  t.lineTo(8, 0);
  t.moveTo(-2, 2);
  t.lineTo(2, -2);
  t.moveTo(6, 10);
  t.lineTo(10, 6);
  t.stroke();
  return ctx.createPattern(tile, "repeat");
}

export type HeatDrawStats = { ok: number; stale: number; missing: number; disagree: number };

/** Draw every pixel at `atMs`. Returns what was drawn per state (the e2e reads it from the canvas dataset). */
export function drawHeat(ctx: CanvasRenderingContext2D, pixels: readonly HeatPixel[], atMs: number, project: Project): HeatDrawStats {
  const stats: HeatDrawStats = { ok: 0, stale: 0, missing: 0, disagree: 0 };
  const staleHatch = hatch(ctx, "rgba(255,255,255,0.75)");
  const missingHatch = hatch(ctx, "rgba(190,190,200,0.85)");
  for (const px of pixels) {
    const a = project(px.lon - HALF_PIXEL_DEG, px.lat + HALF_PIXEL_DEG);
    const b = project(px.lon + HALF_PIXEL_DEG, px.lat - HALF_PIXEL_DEG);
    if (!a || !b) continue;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.max(2, Math.abs(b.x - a.x));
    const h = Math.max(2, Math.abs(b.y - a.y));
    const at = heatAt(px, atMs);
    stats[at.state] += 1;
    if (at.state === "missing" || !at.day) {
      ctx.fillStyle = "rgba(60,60,70,0.35)";
      ctx.fillRect(x, y, w, h);
      if (missingHatch) {
        ctx.fillStyle = missingHatch;
        ctx.fillRect(x, y, w, h);
      }
      continue;
    }
    const d = at.day;
    ctx.globalAlpha = at.state === "stale" ? 0.45 : 0.78;
    ctx.fillStyle = d.dhw === null ? "rgba(120,120,130,0.6)" : dhwColor(d.dhw);
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    if (at.state === "stale" && staleHatch) {
      ctx.fillStyle = staleHatch;
      ctx.fillRect(x, y, w, h);
    }
    const s = baaStroke(d.baa);
    if (s.width > 0 && w > 4) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.strokeRect(x + s.width / 2, y + s.width / 2, w - s.width, h - s.width);
    }
  }
  return stats;
}

/** A heat label's box: 18 px tall, centred on its point. */
export const HEAT_LABEL_H = 18;
/** A ranked-cell marker's box (Overlay.tsx `[data-kind="cell"]`: 26 px square, centred), plus a 2 px gap. */
const MARKER_HALF = 15;
/** One step clears a marker centred on the label's point: half the label, half the marker and its gap. */
export const HEAT_LABEL_STEP = HEAT_LABEL_H / 2 + MARKER_HALF + 2;
const LABEL_STEPS = 4;

/**
 * Where a label of width `w` centred at (x, y) goes so that it covers none of the marker points: it steps up,
 * then down, until its box is clear of every 26 px marker square (the numbered priority markers draw above the
 * canvas, so a label under one is unreadable). The original place when nothing clear is found within reach.
 */
export function placeLabel(x: number, y: number, w: number, avoid: readonly { x: number; y: number }[]): { x: number; y: number } {
  const clear = (cy: number) => avoid.every((m) => x + w / 2 <= m.x - MARKER_HALF || x - w / 2 >= m.x + MARKER_HALF || cy + HEAT_LABEL_H / 2 <= m.y - MARKER_HALF || cy - HEAT_LABEL_H / 2 >= m.y + MARKER_HALF);
  if (clear(y)) return { x, y };
  for (let i = 1; i <= LABEL_STEPS; i++) {
    for (const cy of [y - i * HEAT_LABEL_STEP, y + i * HEAT_LABEL_STEP]) if (clear(cy)) return { x, y: cy };
  }
  return { x, y };
}

/**
 * Word labels at each area's pixel patch when its product is missing or stale ("never zero": say it), moved off
 * the ranked-cell markers (`avoid`, in CSS px) that would otherwise sit on top of them.
 */
export function drawHeatLabels(ctx: CanvasRenderingContext2D, groups: readonly { lat: number; lon: number; text: string }[], project: Project, avoid: readonly { x: number; y: number }[] = []): void {
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const g of groups) {
    const p = project(g.lon, g.lat);
    if (!p) continue;
    const w = ctx.measureText(g.text).width + 10;
    const at = placeLabel(p.x, p.y, w, avoid);
    ctx.fillStyle = "rgba(11,13,18,0.82)";
    ctx.fillRect(at.x - w / 2, at.y - HEAT_LABEL_H / 2, w, HEAT_LABEL_H);
    ctx.fillStyle = "#f0f0f4";
    ctx.fillText(g.text, at.x, at.y);
  }
}

/** Calm share of the forecast hours, as a teal glyph: a ring with a wave mark, filled by calm hours. */
export function drawField(ctx: CanvasRenderingContext2D, points: readonly MarinePoint[], project: Project): number {
  let n = 0;
  for (const p of points) {
    const s = project(p.lon, p.lat);
    if (!s) continue;
    n += 1;
    const calm = p.hours ? p.calmHours / p.hours : 0;
    const r = 6;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(11,13,18,0.55)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + calm * Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(94,234,212,0.85)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(94,234,212,0.95)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  return n;
}

export const heatTitle = (dhw: number | null, baa: number | null) => `DHW ${dhw === null ? "unknown" : dhw.toFixed(1)} °C-weeks · BAA ${baaWord(baa)}`;
