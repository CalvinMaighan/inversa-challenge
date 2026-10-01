/**
 * Eval check for C17 (PLAN.md): every successful data tool call must put a valid `ToolResultData` with a view in
 * `tool_end.data`, so the chat card has a panel to show. Model-independent: it reads the stream, so it holds in
 * live mode as well as replay.
 */

import type { AgentStreamEvent } from "@/shared/agent/events";
import { isToolResultData } from "@/shared/agent/results";

/** Tools that return data and so owe the UI a panel. geocode and set_view do not. */
export const DATA_TOOLS: ReadonlySet<string> = new Set([
  "sightings",
  "conditions",
  "alerts",
  "hotspots",
  "explain_cell",
  "backtest",
  "feed_state",
  "site_status",
  "river_readings",
  "river_forecast",
  "forecast_verify",
  "review_history",
  "weather_forecast",
  "source_info",
  "team_board",
  "notes",
]);

const isView = (value: unknown) => isToolResultData({ result: value }) && value !== undefined;

export type ViewCheck = { valid: number; total: number; reasons: string[] };

export function checkViews(events: readonly AgentStreamEvent[]): ViewCheck {
  const out: ViewCheck = { valid: 0, total: 0, reasons: [] };
  for (const event of events) {
    if (event.type !== "tool_end" || !event.ok || !DATA_TOOLS.has(event.capabilityName)) continue;
    out.total += 1;
    const data = event.data as { result?: unknown; more?: unknown; highlight?: unknown } | undefined;
    const more = data?.more;
    const ok =
      isToolResultData(data) &&
      data.result !== undefined &&
      (more === undefined || (Array.isArray(more) && more.every(isView))) &&
      (data.highlight === undefined || (Array.isArray(data.highlight) && data.highlight.every((id) => typeof id === "string")));
    if (ok) out.valid += 1;
    else out.reasons.push(`${event.capabilityName} tool_end.data is not a ToolResultData with a view`);
  }
  return out;
}
