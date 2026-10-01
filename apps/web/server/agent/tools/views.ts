/**
 * C17 result views (PLAN.md C17) for the agent's data tools. Pure: each builder takes the rows a tool already
 * fetched and returns the `ToolResultData` the chat card renders and the globe highlights. The views go to the
 * UI only, in `tool_end.data`; the model keeps reading the compact summary in `CapabilityOutput.data`.
 *
 * A tool with more than one panel (conditions: one series per parameter plus a latest-values table) puts the
 * most relevant view in `result` and the rest in `more`, an extension of `ToolResultData` the client reads.
 */

import type { CapabilityOutput } from "@/server/agent/runtime/registry";
import type { BBox } from "@/shared/agent/events";
import type {
  BacktestView,
  CellsView,
  ExplainView,
  FeedsView,
  SeriesView,
  TableView,
  ToolResultData,
  ToolResultView,
} from "@/shared/agent/results";
import type { FeedState } from "@/shared/feed-state";

/** `ToolResultData` plus any further panels of the same tool call. */
export type ToolViewData = ToolResultData & { more?: ToolResultView[] };

/** Rows a table view carries before it truncates (the model sees far fewer). */
export const MAX_VIEW_ROWS = 500;
/** Ids one tool asks the globe to bracket; the client caps a whole turn at 50. */
export const MAX_HIGHLIGHT = 50;
/** Lines per series chart, and points per line (longer lines are thinned evenly, keeping both ends). */
export const MAX_SERIES_LINES = 8;
export const MAX_SERIES_POINTS = 400;
/** A sampling gap longer than this many median steps breaks the line. */
export const GAP_FACTOR = 3;
/** Smallest box the camera frames around a point result, degrees. */
const MIN_FRAME_DEG = 0.1;

// ---------------------------------------------------------------- attachment

const views = new WeakMap<CapabilityOutput, ToolViewData>();

/** Attach a tool's views to its output. The stream bridge spreads them into `tool_end.data`. */
export function withView(output: CapabilityOutput, view: ToolViewData): CapabilityOutput {
  views.set(output, view);
  return output;
}

/** The views attached to an output, if any (geocode and set_view have none). */
export function viewOf(output: CapabilityOutput): ToolViewData | undefined {
  return views.get(output);
}

// ---------------------------------------------------------------- geometry

/** Bounding box around points, padded, at least MIN_FRAME_DEG on a side. Null for no points. */
export function extentOf(points: readonly { lat: number; lon: number }[], padDeg = 0.02): BBox | null {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (valid.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of valid) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  const grow = (lo: number, hi: number) => {
    const extra = Math.max(0, MIN_FRAME_DEG - (hi - lo)) / 2 + padDeg;
    return [lo - extra, hi + extra] as const;
  };
  [west, east] = grow(west, east);
  [south, north] = grow(south, north);
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return { west: r(west), south: r(south), east: r(east), north: r(north) };
}

// ---------------------------------------------------------------- sightings

export type SightingRow = {
  evidenceId: string;
  species: string;
  source: string;
  quality: string;
  observedAt: string;
  lat: number;
  lon: number;
  duplicateOf: string | null;
  idConflict: boolean;
  /** Publisher page (PLAN.md C19). A hidden column: the panel draws it as a ↗ link; the model never sees it. */
  sourcePageUrl?: string | null;
};

export function sightingsView(rows: readonly SightingRow[], bbox: BBox, title: string): ToolViewData {
  const shown = rows.slice(0, MAX_VIEW_ROWS);
  const table: TableView = {
    view: "table",
    title,
    columns: [
      { key: "time", label: "Observed", kind: "time" },
      { key: "species", label: "Species", kind: "text" },
      { key: "quality", label: "Quality", kind: "quality" },
      { key: "source", label: "Source", kind: "text" },
      { key: "lat", label: "Lat", unit: "°", kind: "number" },
      { key: "lon", label: "Lon", unit: "°", kind: "number" },
      { key: "dup", label: "Duplicate of", kind: "text" },
      { key: "conflict", label: "ID conflict", kind: "text" },
    ],
    rows: shown.map((row) => ({
      evidenceId: row.evidenceId,
      time: row.observedAt,
      species: row.species,
      quality: row.quality,
      source: row.source,
      lat: row.lat,
      lon: row.lon,
      dup: row.duplicateOf,
      conflict: row.idConflict ? "conflict" : null,
      sourcePageUrl: row.sourcePageUrl ?? null,
    })),
    ...(rows.length > shown.length ? { total: rows.length } : {}),
  };
  // Duplicates are drawn once, at their canonical record; bracket the canonical rows first.
  const ordered = [...shown.filter((row) => !row.duplicateOf), ...shown.filter((row) => row.duplicateOf)];
  return {
    result: table,
    highlight: ordered.slice(0, MAX_HIGHLIGHT).map((row) => row.evidenceId),
    bbox,
  };
}

// ---------------------------------------------------------------- conditions

export type ReadingRow = {
  evidenceId: string;
  stationId: string;
  station: string;
  source: string;
  lat: number;
  lon: number;
  param: string;
  value: number | null;
  /** Lower case: "ok" is usable; anything else is a gap. */
  flag: string;
  origin: string;
  observedAt: string;
};

export const PARAM_UNITS: Record<string, string> = {
  lst_c: "°C",
  air_c: "°C",
  water_c: "°C",
  sst_c: "°C",
  rain_mm: "mm",
  stage_m: "m",
  wave_m: "m",
  wind_ms: "m/s",
  fire_frp: "MW",
};

export const PARAM_TITLES: Record<string, string> = {
  lst_c: "Land surface temperature",
  air_c: "Air temperature",
  water_c: "Water temperature",
  sst_c: "Sea surface temperature",
  rain_mm: "Rain",
  stage_m: "Water level (stage)",
  wave_m: "Wave height",
  wind_ms: "Wind speed",
  fire_frp: "Fire radiative power",
};

const ORIGIN_ORDER: Record<string, number> = { measured: 0, satellite: 1, modeled: 2 };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * One line's points: time-sorted, flagged or missing values as null, and a null inserted wherever the sampling
 * interval jumps past GAP_FACTOR median steps, so the chart breaks the line instead of drawing across the gap.
 */
export function seriesPoints(samples: readonly { t: number; value: number | null }[]): [number, number | null][] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i]!.t - sorted[i - 1]!.t;
    if (dt > 0) steps.push(dt);
  }
  const step = median(steps);
  const out: [number, number | null][] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1];
    if (prev && step > 0 && cur.t - prev.t > GAP_FACTOR * step) out.push([Math.round((prev.t + cur.t) / 2), null]);
    out.push([cur.t, cur.value]);
  }
  return thin(out, MAX_SERIES_POINTS);
}

/** Keep at most `max` points, evenly, always keeping the first, the last and every gap marker. */
function thin(points: [number, number | null][], max: number): [number, number | null][] {
  if (points.length <= max) return points;
  const stride = points.length / max;
  const keep = new Set<number>([0, points.length - 1]);
  for (let i = 0; i < max; i++) keep.add(Math.floor(i * stride));
  points.forEach((p, i) => {
    if (p[1] === null) keep.add(i);
  });
  return [...keep].sort((a, b) => a - b).map((i) => points[i]!);
}

const usable = (row: ReadingRow) => row.value !== null && row.flag === "ok";

/**
 * Conditions views: one series chart per parameter (a line per station and origin, measured first), then a
 * table of the latest value of each line. `paramOrder` puts the parameters the caller asked for first.
 */
export function conditionsViews(
  readings: readonly ReadingRow[],
  latest: readonly ReadingRow[],
  bbox: BBox,
  paramOrder: readonly string[],
  scope: string,
): ToolViewData {
  const byParam = new Map<string, Map<string, ReadingRow[]>>();
  for (const row of readings) {
    const lines = byParam.get(row.param) ?? new Map<string, ReadingRow[]>();
    const key = `${row.stationId}|${row.origin}`;
    const line = lines.get(key) ?? [];
    line.push(row);
    lines.set(key, line);
    byParam.set(row.param, lines);
  }
  const rank = (param: string) => {
    const at = paramOrder.indexOf(param);
    return at < 0 ? paramOrder.length : at;
  };
  const params = [...byParam.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const series: SeriesView[] = params.map((param) => {
    const lines = [...byParam.get(param)!.values()]
      .sort(
        (a, b) =>
          (ORIGIN_ORDER[a[0]!.origin] ?? 9) - (ORIGIN_ORDER[b[0]!.origin] ?? 9) ||
          b.filter(usable).length - a.filter(usable).length ||
          a[0]!.station.localeCompare(b[0]!.station),
      )
      .slice(0, MAX_SERIES_LINES);
    return {
      view: "series",
      title: `${PARAM_TITLES[param] ?? param}${scope ? ` · ${scope}` : ""}`,
      unit: PARAM_UNITS[param] ?? "",
      series: lines.map((line) => {
        const newest = line.reduce((a, b) => (Date.parse(b.observedAt) > Date.parse(a.observedAt) ? b : a));
        const origin = newest.origin === "measured" ? "" : ` (${newest.origin})`;
        return {
          label: `${newest.station}${origin}`,
          evidenceId: newest.evidenceId,
          points: seriesPoints(line.map((row) => ({ t: Date.parse(row.observedAt), value: usable(row) ? row.value : null }))),
        };
      }),
    };
  });
  const table: TableView = {
    view: "table",
    title: `Latest readings${scope ? ` · ${scope}` : ""}`,
    columns: [
      { key: "station", label: "Station", kind: "text" },
      { key: "param", label: "Parameter", kind: "text" },
      { key: "value", label: "Value", kind: "number" },
      { key: "unit", label: "Unit", kind: "text" },
      { key: "origin", label: "Origin", kind: "text" },
      { key: "flag", label: "Flag", kind: "quality" },
      { key: "time", label: "Observed", kind: "time" },
      { key: "lat", label: "Lat", unit: "°", kind: "number" },
      { key: "lon", label: "Lon", unit: "°", kind: "number" },
    ],
    rows: latest.slice(0, MAX_VIEW_ROWS).map((row) => ({
      evidenceId: row.evidenceId,
      station: row.station,
      param: row.param,
      value: row.value,
      unit: PARAM_UNITS[row.param] ?? "",
      origin: row.origin,
      flag: row.flag,
      time: row.observedAt,
      lat: row.lat,
      lon: row.lon,
    })),
    ...(latest.length > MAX_VIEW_ROWS ? { total: latest.length } : {}),
  };
  // One bracket per station: its latest reading of the first parameter it reports.
  const perStation = new Map<string, string>();
  for (const param of params) {
    for (const row of latest) if (row.param === param && !perStation.has(row.stationId)) perStation.set(row.stationId, row.evidenceId);
  }
  const [first, ...rest] = series;
  return {
    result: first ?? table,
    ...(first ? { more: [...rest, table] } : {}),
    highlight: [...perStation.values()].slice(0, MAX_HIGHLIGHT),
    bbox,
  };
}

// ---------------------------------------------------------------- alerts

export type AlertRow = {
  evidenceId: string;
  event: string;
  severity: string;
  headline: string | null;
  onset: string | null;
  expires: string | null;
};

export function alertsView(rows: readonly AlertRow[], bbox: BBox, at: string): ToolViewData {
  const table: TableView = {
    view: "table",
    title: `NWS alerts in effect · ${at.slice(0, 16).replace("T", " ")}Z`,
    columns: [
      { key: "event", label: "Event", kind: "text" },
      { key: "severity", label: "Severity", kind: "quality" },
      { key: "onset", label: "Onset", kind: "time" },
      { key: "expires", label: "Expires", kind: "time" },
      { key: "headline", label: "Headline", kind: "text" },
    ],
    rows: rows.slice(0, MAX_VIEW_ROWS).map((row) => ({
      evidenceId: row.evidenceId,
      event: row.event,
      severity: row.severity.toLowerCase(),
      onset: row.onset,
      expires: row.expires,
      headline: row.headline,
    })),
  };
  return { result: table, highlight: rows.slice(0, MAX_HIGHLIGHT).map((row) => row.evidenceId), bbox };
}

// ---------------------------------------------------------------- hotspots

export function cellsView(
  species: string,
  at: string,
  cells: readonly { cell: string; lat: number; lon: number; score: number; evidenceId: string }[],
  bbox: BBox,
): ToolViewData {
  const view: CellsView = {
    view: "cells",
    title: `Top ${species} cells · heuristic score`,
    species,
    at,
    cells: [...cells].sort((a, b) => b.score - a.score),
  };
  return {
    result: view,
    highlight: view.cells.slice(0, MAX_HIGHLIGHT).map((cell) => cell.evidenceId),
    bbox: extentOf(cells, 0.05) ?? bbox,
  };
}

export function explainView(
  explained: { cell: string; species: string; score: number; terms: { name: string; value: number; rationale: string }[] },
  evidenceId: string,
  center: { lat: number; lon: number } | null,
): ToolViewData {
  const view: ExplainView = {
    view: "explain",
    title: `Why ${explained.species} cell ${explained.cell} scores ${explained.score.toFixed(2)}`,
    evidenceId,
    score: explained.score,
    terms: explained.terms.map((term) => ({ name: term.name, value: term.value, rationale: term.rationale })),
  };
  const bbox = center ? extentOf([center], 0.05) : null;
  return { result: view, highlight: [evidenceId], ...(bbox ? { bbox } : {}) };
}

export function backtestView(
  result: { species: string; days: number; hitRate: number; baseline: number; perDay: { day: string; sightings: number; hits: number }[] },
  evidenceId: string,
): ToolViewData {
  const view: BacktestView = {
    view: "backtest",
    title: `${result.species} hotspot backtest · ${result.days} days`,
    evidenceId,
    hitRate: result.hitRate,
    baseline: result.baseline,
    perDay: result.perDay.map((day) => ({ day: day.day, sightings: day.sightings, hits: day.hits })),
  };
  return { result: view };
}

export function feedsView(feeds: readonly FeedState[]): ToolViewData {
  const order: Record<FeedState["state"], number> = { down: 0, stale: 1, lagging: 2, nominal: 3 };
  const view: FeedsView = {
    view: "feeds",
    title: "Feed health",
    feeds: [...feeds].sort((a, b) => order[a.state] - order[b.state] || a.source.localeCompare(b.source)),
  };
  return { result: view };
}
