import type { AgentToolRow, AgentTurn, ToolRowState } from "./thread";

/**
 * Tool timeline labels and grouping, ported from deedee `DeedeeChatPanel` (`groupTools`, `groupLabel`,
 * `formatWorkDuration`). Capability names are T13's registry (server/agent/tools/capabilities.ts).
 */

const DONE_LABELS: Record<string, string> = {
  geocode: "Found the place",
  sightings: "Searched sightings",
  conditions: "Read conditions",
  alerts: "Checked NWS alerts",
  hotspots: "Ranked hotspots",
  explain_cell: "Explained a hotspot cell",
  backtest: "Backtested hotspot scores",
  feed_state: "Checked feed health",
  set_view: "Moved the view",
};

const RUNNING_LABELS: Record<string, string> = {
  geocode: "Finding the place",
  sightings: "Searching sightings",
  conditions: "Reading conditions",
  alerts: "Checking NWS alerts",
  hotspots: "Ranking hotspots",
  explain_cell: "Explaining the cell",
  backtest: "Backtesting scores",
  feed_state: "Checking feed health",
  set_view: "Moving the view",
};

/** "Searched sightings 3 times"-style labels for collapsed repeat calls. */
const PLURAL_LABELS: Record<string, (n: number) => string> = {
  geocode: (n) => `Found ${n} places`,
  sightings: (n) => `Searched sightings ${n} times`,
  conditions: (n) => `Read conditions ${n} times`,
  hotspots: (n) => `Ranked hotspots ${n} times`,
  explain_cell: (n) => `Explained ${n} hotspot cells`,
};

export function toolLabel(tool: Pick<AgentToolRow, "capabilityName" | "state">): string {
  if (tool.state === "running") return `${RUNNING_LABELS[tool.capabilityName] ?? tool.capabilityName}…`;
  return DONE_LABELS[tool.capabilityName] ?? tool.capabilityName;
}

export type ToolGroup = { capabilityName: string; items: AgentToolRow[] };

/** Completed calls collapse into one row per capability (first-seen order); running calls stay separate. */
export function groupTools(tools: readonly AgentToolRow[]): { groups: ToolGroup[]; running: AgentToolRow[] } {
  const groups: ToolGroup[] = [];
  const byCap = new Map<string, ToolGroup>();
  const running: AgentToolRow[] = [];
  for (const tool of tools) {
    if (tool.state === "running") {
      running.push(tool);
      continue;
    }
    let group = byCap.get(tool.capabilityName);
    if (!group) {
      group = { capabilityName: tool.capabilityName, items: [] };
      byCap.set(tool.capabilityName, group);
      groups.push(group);
    }
    group.items.push(tool);
  }
  return { groups, running };
}

export function groupLabel(group: ToolGroup): string {
  const n = group.items.length;
  if (n === 1) return toolLabel(group.items[0]!);
  return PLURAL_LABELS[group.capabilityName]?.(n) ?? `${DONE_LABELS[group.capabilityName] ?? group.capabilityName} ×${n}`;
}

export function groupState(group: ToolGroup): ToolRowState {
  return group.items.some((t) => t.state === "error") ? "error" : "ok";
}

/** Muted detail under a row: rows returned, or the failure. */
export function groupDetail(group: ToolGroup): string | undefined {
  const parts = group.items.flatMap((t) => {
    if (t.state === "error") return [t.error ?? "failed"];
    if (t.count === undefined) return [];
    return [`${t.count} ${t.count === 1 ? "row" : "rows"}${t.evidence ? `, ${t.evidence} evidence` : ""}`];
  });
  return parts.length ? parts.join(" · ") : undefined;
}

/** "12s", "1m04s". Live clocks floor; finished ones round, with a 1 s floor so "Worked for 0s" never shows. */
export function formatWorkDuration(ms: number, active: boolean): string {
  const sec = Math.max(0, ms / 1000);
  const total = active ? Math.floor(sec) : Math.max(1, Math.round(sec));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/** Elapsed turn time: to `nowMs` while streaming, to `endedAtMs` after. */
export function turnWorkMs(turn: Pick<AgentTurn, "startedAtMs" | "endedAtMs">, nowMs: number): number {
  if (turn.startedAtMs === undefined) return 0;
  return Math.max(0, (turn.endedAtMs ?? nowMs) - turn.startedAtMs);
}
