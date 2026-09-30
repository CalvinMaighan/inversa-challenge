/**
 * Agent tool result views (PLAN.md C17). Every data tool's `tool_end.data` carries one
 * `ToolResultView` so the chat card can render a data panel and the globe can highlight and
 * frame what the answer is about. Rows carry evidence ids (C14) so any cell is one click from
 * the evidence drawer.
 */
import type { BBox } from "shared/agent/events";
import type { FeedState } from "shared/feed-state";

export type Cell = string | number | null;

export type TableColumn = { key: string; label: string; unit?: string; kind?: "time" | "number" | "text" | "quality" };

export type TableView = {
  view: "table";
  title: string;
  columns: TableColumn[];
  /** Each row has an `evidenceId` for click-through; values keyed by column key. */
  rows: ({ evidenceId: string } & Record<string, Cell>)[];
  /** Total before truncation, when the tool capped rows. */
  total?: number;
};

export type SeriesView = {
  view: "series";
  title: string;
  unit: string;
  /** One line per station/param; points are [unix ms, value or null for gaps]. */
  series: { label: string; evidenceId?: string; points: [number, number | null][] }[];
};

export type CellsView = {
  view: "cells";
  title: string;
  species: string;
  at: string;
  cells: { cell: string; lat: number; lon: number; score: number; evidenceId: string }[];
};

export type ExplainView = {
  view: "explain";
  title: string;
  evidenceId: string;
  score: number;
  terms: { name: string; value: number; rationale: string }[];
};

export type BacktestView = {
  view: "backtest";
  title: string;
  evidenceId: string;
  hitRate: number;
  baseline: number;
  perDay: { day: string; sightings: number; hits: number }[];
};

export type FeedsView = { view: "feeds"; title: string; feeds: FeedState[] };

export type ToolResultView = TableView | SeriesView | CellsView | ExplainView | BacktestView | FeedsView;

/** What every data tool puts in `tool_end.data`. */
export type ToolResultData = {
  /** Panel to render; absent for tools with nothing tabular (geocode, set_view). */
  result?: ToolResultView;
  /** Evidence ids the globe should bracket for this answer. */
  highlight?: string[];
  /** Area to frame when the user opens this panel. */
  bbox?: BBox;
};

const VIEWS = new Set(["table", "series", "cells", "explain", "backtest", "feeds"]);

export function isToolResultData(value: unknown): value is ToolResultData {
  if (!value || typeof value !== "object") return false;
  const r = (value as ToolResultData).result;
  return r === undefined || (typeof r === "object" && r !== null && VIEWS.has((r as { view: string }).view));
}
