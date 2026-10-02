/**
 * Data panel model (PLAN.md C17): pure helpers behind the chat card's result panels and the globe highlight.
 * `tool_end.data` → panels; table sorting and paging; series domains, ticks and gap-aware paths; the turn's
 * highlight targets and camera box; the TIME a panel should show; where the expanded panel goes.
 */

import type { AgentHighlightTarget } from "client/state/agent";
import { retime, TIME_STEP_MINUTES, type TimeState } from "client/state/time";
import type { BBox } from "shared/agent/events";
import {
  isToolResultData,
  type Cell,
  type SeriesView,
  type TableColumn,
  type ToolResultView,
} from "shared/agent/results";

/** Brackets one answer may put on the globe. */
export const MAX_HIGHLIGHT = 50;
/** Table rows shown before "Show all". */
export const TABLE_PAGE_ROWS = 50;

export type Panel = {
  /** `<toolCallId>:<index>`, stable across re-renders. */
  key: string;
  toolCallId: string;
  capabilityName: string;
  view: ToolResultView;
  /** Evidence ids the tool asked the globe to bracket. */
  highlight: string[];
  /** Area the tool covered; opening the panel frames it. */
  bbox?: BBox;
};

const VIEW_KINDS = new Set<ToolResultView["view"]>(["table", "series", "cells", "explain", "backtest", "feeds"]);

function isView(value: unknown): value is ToolResultView {
  return !!value && typeof value === "object" && VIEW_KINDS.has((value as { view: ToolResultView["view"] }).view);
}

function isBBox(value: unknown): value is BBox {
  if (!value || typeof value !== "object") return false;
  const b = value as BBox;
  return [b.west, b.south, b.east, b.north].every(Number.isFinite) && b.west < b.east && b.south < b.north;
}

/**
 * Panels of one `tool_end`: `result` first, then any `more` views (conditions sends one series per parameter
 * plus a latest-values table). Anything that is not a C17 payload yields no panels.
 */
export function panelsFromToolEnd(toolCallId: string, capabilityName: string, data: unknown): Panel[] {
  if (!isToolResultData(data) || !data.result) return [];
  const more = (data as { more?: unknown }).more;
  const views = [data.result, ...(Array.isArray(more) ? more.filter(isView) : [])];
  const highlight = Array.isArray(data.highlight) ? data.highlight.filter((id): id is string => typeof id === "string") : [];
  const bbox = isBBox(data.bbox) ? data.bbox : undefined;
  return views.map((view, index) => ({ key: `${toolCallId}:${index}`, toolCallId, capabilityName, view, highlight, ...(bbox ? { bbox } : {}) }));
}

/** How relevant a tool's panel is to the answer: things on the map first, context after. */
const RANK: Record<string, number> = {
  hotspots: 6,
  sightings: 5,
  explain_cell: 4,
  alerts: 3,
  conditions: 2,
  backtest: 1,
  feed_state: 0,
};

/** Index of the most relevant panel: highest-ranked tool, its latest call, that call's first view. -1 if none. */
export function primaryPanelIndex(panels: readonly Panel[]): number {
  let best = -1;
  let bestRank = -Infinity;
  panels.forEach((panel, index) => {
    const rank = RANK[panel.capabilityName] ?? -1;
    const first = panel.key.endsWith(":0");
    if (first && rank >= bestRank) {
      best = index;
      bestRank = rank;
    }
  });
  return best;
}

// ---------------------------------------------------------------- table

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;

const cellTime = (value: Cell) => (typeof value === "string" ? Date.parse(value) : NaN);

/** Compare two cells by column kind. Nulls and unparseable values sort last whatever the direction. */
export function compareCells(a: Cell, b: Cell, kind: TableColumn["kind"], dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  if (kind === "time") {
    const ta = cellTime(a);
    const tb = cellTime(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.isNaN(ta) === Number.isNaN(tb) ? 0 : Number.isNaN(ta) ? 1 : -1;
    return sign * (ta - tb);
  }
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "" ? 0 : 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return sign * (a - b);
  return sign * String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Rows sorted by `sort` (stable), or in server order when unsorted. */
export function sortRows<R extends Record<string, Cell>>(rows: readonly R[], columns: readonly TableColumn[], sort: SortState): R[] {
  if (!sort) return [...rows];
  const kind = columns.find((column) => column.key === sort.key)?.kind;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compareCells(a.row[sort.key] ?? null, b.row[sort.key] ?? null, kind, sort.dir) || a.index - b.index)
    .map(({ row }) => row);
}

/** Header click: a new column starts descending for times and numbers, ascending for text; the same column flips. */
export function nextSort(prev: SortState, column: TableColumn): SortState {
  if (prev?.key === column.key) return { key: column.key, dir: prev.dir === "asc" ? "desc" : "asc" };
  return { key: column.key, dir: column.kind === "time" || column.kind === "number" ? "desc" : "asc" };
}

/** The first `limit` rows unless `showAll`; `hidden` counts what the toggle would add. */
export function visibleRows<R>(rows: readonly R[], showAll: boolean, limit = TABLE_PAGE_ROWS): { rows: R[]; hidden: number } {
  if (showAll || rows.length <= limit) return { rows: [...rows], hidden: 0 };
  return { rows: rows.slice(0, limit), hidden: rows.length - limit };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `09-02 18:09Z`: month-day and UTC minute, enough to read a field record. */
export function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}Z`;
}

/** Numbers at a precision that suits their size; coordinates to 3 decimals (about 100 m). */
export function formatNumber(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "°") return value.toFixed(3);
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits);
}

export function formatCell(value: Cell | undefined, column: TableColumn): string {
  if (value === null || value === undefined || value === "") return "—";
  if (column.kind === "time" && typeof value === "string") return formatTime(value);
  if (typeof value === "number") return formatNumber(value, column.unit);
  return String(value);
}

// ---------------------------------------------------------------- series

export type SeriesDomain = { t0: number; t1: number; v0: number; v1: number };

/** Time and value extent over every non-null point, padded so a flat line sits mid-chart. Null when empty. */
export function seriesDomain(view: Pick<SeriesView, "series">): SeriesDomain | null {
  let t0 = Infinity;
  let t1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const line of view.series) {
    for (const [t, v] of line.points) {
      if (v === null || !Number.isFinite(v) || !Number.isFinite(t)) continue;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
  }
  if (!Number.isFinite(t0)) return null;
  if (t0 === t1) {
    t0 -= 30 * 60_000;
    t1 += 30 * 60_000;
  }
  const span = v1 - v0;
  const padV = span > 0 ? span * 0.08 : Math.max(Math.abs(v0) * 0.05, 0.5);
  return { t0, t1, v0: v0 - padV, v1: v1 + padV };
}

/** Round tick values ("nice" 1/2/5 × 10^n steps) covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return Number.isFinite(min) ? [min] : [];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const TIME_STEPS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * 60_000);

/** Time ticks on whole UTC steps (15 min … 1 week) covering [t0, t1], about `count` of them. */
export function timeTicks(t0: number, t1: number, count = 4): number[] {
  if (!(t1 > t0)) return [t0];
  const raw = (t1 - t0) / Math.max(1, count);
  const step = TIME_STEPS.find((s) => s >= raw) ?? TIME_STEPS.at(-1)!;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}

/** `18:00` within a day, `09-02` across days. */
export function formatTick(t: number, spanMs: number): string {
  const d = new Date(t);
  return spanMs > 36 * 3_600_000 ? `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export type Plot = { width: number; height: number; left: number; right: number; top: number; bottom: number };

export function scaleX(t: number, d: SeriesDomain, p: Plot): number {
  return p.left + ((t - d.t0) / (d.t1 - d.t0)) * (p.width - p.left - p.right);
}

export function scaleY(v: number, d: SeriesDomain, p: Plot): number {
  return p.top + (1 - (v - d.v0) / (d.v1 - d.v0)) * (p.height - p.top - p.bottom);
}

/**
 * SVG path for one line: a null point lifts the pen, so gaps show as breaks. Points with no neighbour on
 * either side (a lone sample between gaps) come back in `dots`, since a one-point subpath draws nothing.
 */
export function linePath(points: readonly [number, number | null][], d: SeriesDomain, p: Plot): { d: string; dots: [number, number][] } {
  const parts: string[] = [];
  const dots: [number, number][] = [];
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length === 1) dots.push(run[0]!);
    else if (run.length > 1) parts.push(run.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(""));
    run = [];
  };
  for (const [t, v] of points) {
    if (v === null || !Number.isFinite(v)) {
      flush();
      continue;
    }
    run.push([scaleX(t, d, p), scaleY(v, d, p)]);
  }
  flush();
  return { d: parts.join(""), dots };
}

/** Each line's non-null value nearest to time `t`, for the hover readout. */
export function readoutAt(view: Pick<SeriesView, "series">, t: number): { label: string; t: number; value: number }[] {
  const out: { label: string; t: number; value: number }[] = [];
  for (const line of view.series) {
    let best: [number, number] | null = null;
    for (const [pt, v] of line.points) {
      if (v === null) continue;
      if (!best || Math.abs(pt - t) < Math.abs(best[0] - t)) best = [pt, v];
    }
    if (best) out.push({ label: line.label, t: best[0], value: best[1] });
  }
  return out;
}

// ---------------------------------------------------------------- highlight, camera, time

type Located = { lon: number; lat: number; label: string };

const num = (value: Cell | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Short bracket label for a table row: species and quality, station and value, or the event. */
function rowLabel(row: Record<string, Cell>, unitOf?: string): string {
  if (row.species) return [row.species, row.quality].filter(Boolean).join(" · ");
  if (row.station) {
    const value = num(row.value);
    return value === undefined ? String(row.station) : `${row.station} ${formatNumber(value)}${unitOf ? ` ${unitOf}` : ""}`;
  }
  if (row.event) return String(row.event);
  return "";
}

/** Where each id of a turn's panels sits, when its row or cell carries coordinates. */
export function locateIds(panels: readonly Panel[]): Map<string, Located> {
  const out = new Map<string, Located>();
  for (const { view } of panels) {
    if (view.view === "table") {
      for (const row of view.rows) {
        const lat = num(row.lat);
        const lon = num(row.lon);
        if (lat === undefined || lon === undefined || out.has(row.evidenceId)) continue;
        out.set(row.evidenceId, { lat, lon, label: rowLabel(row, typeof row.unit === "string" ? row.unit : undefined) });
      }
    } else if (view.view === "cells") {
      for (const cell of view.cells) {
        if (!out.has(cell.evidenceId)) out.set(cell.evidenceId, { lat: cell.lat, lon: cell.lon, label: `${view.species} ${cell.cell} · ${cell.score.toFixed(2)}` });
      }
    }
  }
  return out;
}

/** Target for one id: position and label when the panels carry them, else the bare id (the HUD looks it up). */
export function targetFor(id: string, located: ReadonlyMap<string, Located>): AgentHighlightTarget {
  const at = located.get(id);
  return at ? { id, label: at.label, lon: at.lon, lat: at.lat } : { id, label: "" };
}

/** The turn's highlight: the primary panel's ids first, then every other panel's, unique, capped at 50. */
export function highlightTargets(panels: readonly Panel[], primary: number, cap = MAX_HIGHLIGHT): AgentHighlightTarget[] {
  const located = locateIds(panels);
  const order = primary >= 0 ? [panels[primary]!, ...panels.filter((_, i) => i !== primary)] : [...panels];
  const seen = new Set<string>();
  const out: AgentHighlightTarget[] = [];
  for (const panel of order) {
    for (const id of panel.highlight) {
      if (out.length >= cap) return out;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(targetFor(id, located));
    }
  }
  return out;
}

/**
 * Camera box for an answer: the most relevant result's area, grown to take in every highlighted entity with a
 * known position, so each bracket lands on screen. Null when there is nothing to frame.
 */
export function frameBox(bbox: BBox | undefined, targets: readonly AgentHighlightTarget[], padDeg = 0.02): BBox | null {
  let box = bbox ? { ...bbox } : null;
  for (const t of targets) {
    if (t.lon === undefined || t.lat === undefined) continue;
    box = box
      ? {
          west: Math.min(box.west, t.lon - padDeg),
          south: Math.min(box.south, t.lat - padDeg),
          east: Math.max(box.east, t.lon + padDeg),
          north: Math.max(box.north, t.lat + padDeg),
        }
      : { west: t.lon - padDeg, south: t.lat - padDeg, east: t.lon + padDeg, north: t.lat + padDeg };
  }
  return box;
}

/** Cesium's default field of view; it spans the wider side of the viewport. */
const FOV = Math.PI / 3;
/** Slack around a framed box, so brackets clear the HUD bars and the card. */
export const FRAME_MARGIN = 1.35;

/**
 * Camera height that fits `box` looking straight down in a viewport of this shape. Cesium applies its 60° field
 * of view to the wider side, so on a landscape screen the vertical angle is narrower and usually decides.
 */
export function altitudeForBox(box: BBox, viewport: { width: number; height: number }, margin = FRAME_MARGIN): number {
  const midLat = ((box.south + box.north) / 2) * (Math.PI / 180);
  const widthM = (box.east - box.west) * 111_320 * Math.cos(midLat);
  const heightM = (box.north - box.south) * 111_320;
  const aspect = viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 1;
  const half = FOV / 2;
  const hHalf = aspect >= 1 ? half : Math.atan(Math.tan(half) * aspect);
  const vHalf = aspect >= 1 ? Math.atan(Math.tan(half) / aspect) : half;
  return Math.round(Math.max(widthM / 2 / Math.tan(hHalf), heightM / 2 / Math.tan(vHalf)) * margin);
}

/**
 * The instant a view is about, for TIME: a table's newest `time` column value, a series' newest point, a
 * hotspot grid's `at`, an explained cell's frame. Null for views without one (backtest, feeds, alerts).
 */
export function viewTime(view: ToolResultView): number | null {
  if (view.view === "table") {
    const column = view.columns.find((c) => c.key === "time" && c.kind === "time");
    if (!column) return null;
    const times = view.rows.map((row) => cellTime(row.time ?? null)).filter(Number.isFinite);
    return times.length ? Math.max(...times) : null;
  }
  if (view.view === "series") {
    let newest = -Infinity;
    for (const line of view.series) for (const [t, v] of line.points) if (v !== null && t > newest) newest = t;
    return Number.isFinite(newest) ? newest : null;
  }
  if (view.view === "cells") {
    const at = Date.parse(view.at);
    return Number.isFinite(at) ? at : null;
  }
  if (view.view === "explain") {
    const ms = Number(view.evidenceId.split(":").at(-1));
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

/** The sightings layer draws a 24 h trail ending at TIME.at (client/globe/layers/sightings.ts). */
export const VISIBLE_TRAIL_MS = 24 * 3_600_000;
const STEP_MS = TIME_STEP_MINUTES * 60_000;

/**
 * TIME that shows an instant: unchanged (null) when it already falls inside the trail ending at TIME.at;
 * otherwise the cursor moves to the first frame step at or after it (never past now), and the window follows
 * when the cursor would leave it (`retime`, as a `view` event or a share link does).
 */
export function timeForInstant(time: Pick<TimeState, "at" | "from" | "to">, instantMs: number, nowMs: number): Pick<TimeState, "at" | "from" | "to"> | null {
  const at = Date.parse(time.at);
  if (!Number.isFinite(instantMs)) return null;
  if (Number.isFinite(at) && instantMs <= at && instantMs > at - VISIBLE_TRAIL_MS) return null;
  const nowStep = Math.floor(nowMs / STEP_MS) * STEP_MS;
  const target = Math.min(nowStep, Math.ceil(instantMs / STEP_MS) * STEP_MS);
  if (target === at) return null;
  return retime(time, target, nowMs);
}

// ---------------------------------------------------------------- expanded panel geometry

export type Rect = { top: number; left: number; width: number; height: number };

export const EXPAND_WIDTH = 640;
const MARGIN = 12;
/** Clearance kept around the globe centre. */
const CENTRE_CLEAR = 40;
/** Space the HUD top bar needs. */
const TOP_LIMIT = 64;
const MAX_HEIGHT = 600;
const MIN_HEIGHT = 260;
const MIN_WIDTH = 420;
/** Below this viewport width the expanded panel is a full-screen sheet (the chat column is a bottom sheet there). */
export const EXPAND_SHEET_BREAKPOINT = 768;

/**
 * Where the expanded panel goes (T40): over the left part of the globe pane, docked against the chat column and
 * bottom-aligned with the pane, never over the pane's centre (where the camera frames the answer). The full
 * 640 px beside the centre when the pane is wide enough, else up to 640 px below the centre line, else narrower
 * beside the centre, else a sheet over the whole pane (never over the column). Phones: a full-screen sheet.
 *
 * `pane` is the globe pane's viewport rect; `viewport` the window.
 */
export function expandedPanelRect(pane: Rect, viewport: { width: number; height: number }): Rect & { sheet: boolean } {
  const vw = Math.max(0, viewport.width);
  const vh = Math.max(0, viewport.height);
  if (vw < EXPAND_SHEET_BREAKPOINT) return { top: 0, left: 0, width: vw, height: vh, sheet: true };
  const left = pane.left + MARGIN;
  const bottom = pane.top + pane.height - MARGIN;
  const cx = pane.left + pane.width / 2;
  const cy = pane.top + pane.height / 2;
  const tallTop = Math.max(pane.top + TOP_LIMIT, bottom - MAX_HEIGHT);

  const besideWidth = Math.min(EXPAND_WIDTH, Math.floor(cx - CENTRE_CLEAR - left));
  if (besideWidth >= EXPAND_WIDTH) return { top: tallTop, left, width: besideWidth, height: bottom - tallTop, sheet: false };

  const belowWidth = Math.min(EXPAND_WIDTH, pane.width - 2 * MARGIN);
  const belowTop = Math.max(Math.ceil(cy + CENTRE_CLEAR), tallTop);
  if (belowWidth >= MIN_WIDTH && bottom - belowTop >= MIN_HEIGHT) return { top: belowTop, left, width: belowWidth, height: bottom - belowTop, sheet: false };
  if (besideWidth >= MIN_WIDTH) return { top: tallTop, left, width: besideWidth, height: bottom - tallTop, sheet: false };
  return { top: pane.top, left: pane.left, width: pane.width, height: pane.height, sheet: true };
}

/** True when `rect` covers the point (x, y). */
export function covers(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
}

/** Panel title plus a count, for the collapsed header. */
export function panelSummary(view: ToolResultView): string {
  switch (view.view) {
    case "table": {
      const total = view.total ?? view.rows.length;
      return `${total} ${total === 1 ? "row" : "rows"}`;
    }
    case "series":
      return `${view.series.length} ${view.series.length === 1 ? "line" : "lines"}${view.unit ? ` · ${view.unit}` : ""}`;
    case "cells":
      return `${view.cells.length} ${view.cells.length === 1 ? "cell" : "cells"}`;
    case "explain":
      return `score ${view.score.toFixed(2)}`;
    case "backtest":
      return `${Math.round(view.hitRate * 100)}% vs ${Math.round(view.baseline * 100)}%`;
    case "feeds": {
      const bad = view.feeds.filter((f) => f.state !== "nominal").length;
      return bad ? `${bad} not nominal` : "all nominal";
    }
  }
}

