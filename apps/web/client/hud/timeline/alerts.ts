/**
 * Alert bands on the timeline, from each alert's onset and expires.
 *
 * The API answers `alerts(bbox, at)`: alerts in force at one instant. The timeline needs every alert that
 * touched the 30-day window, so the HUD samples the window every `ALERT_SAMPLE_MS` and sends all samples as
 * aliased fields of one GraphQL document: one HTTP request, deduplicated by id, fetched when the window
 * changes and never while scrubbing. An alert shorter than the sample spacing that falls between two samples
 * is missed; NWS freeze, heat, marine and flood products run for hours, so 3 h spacing catches them.
 */
import type { BBox } from "shared/agent/events";

export const ALERT_SAMPLE_MS = 3 * 60 * 60_000;
/** Bands are packed into at most this many lanes; the rest share the last lane. */
export const ALERT_LANES = 3;

export type AlertRow = {
  id: string;
  event: string;
  severity: string;
  headline: string | null;
  onset: string | null;
  expires: string | null;
};

export type AlertBand = AlertRow & { startMs: number; endMs: number; lane: number };

/** Sample instants across `[from, to]`, always including both ends. */
export function alertSampleTimes(fromMs: number, toMs: number, stepMs = ALERT_SAMPLE_MS): number[] {
  if (!(toMs >= fromMs) || !(stepMs > 0)) return [];
  const out: number[] = [];
  for (let t = fromMs; t < toMs; t += stepMs) out.push(t);
  out.push(toMs);
  return out;
}

const ALERT_FIELDS = "id event severity headline onset expires";

/** One document, one aliased `alerts` field per sample: `a0: alerts(bbox: $bbox, at: $t0) { … }`. */
export function alertsQuery(sampleCount: number): string {
  const vars = ["$bbox: BBox!"];
  const fields: string[] = [];
  for (let i = 0; i < sampleCount; i++) {
    vars.push(`$t${i}: Time!`);
    fields.push(`a${i}: alerts(bbox: $bbox, at: $t${i}) { ${ALERT_FIELDS} }`);
  }
  return `query HudAlertBands(${vars.join(", ")}) {\n  ${fields.join("\n  ")}\n}`;
}

export function alertsVariables(bbox: BBox, samples: readonly number[]): Record<string, unknown> {
  const vars: Record<string, unknown> = { bbox };
  samples.forEach((ms, i) => {
    vars[`t${i}`] = new Date(ms).toISOString();
  });
  return vars;
}

/** Response `{a0: [...], a1: [...]}` → unique alerts. */
export function collectAlerts(data: Record<string, AlertRow[] | null | undefined>): AlertRow[] {
  const byId = new Map<string, AlertRow>();
  for (const rows of Object.values(data)) for (const row of rows ?? []) if (row?.id) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * Alerts → bands clipped to the window, packed into lanes so overlapping alerts stack instead of hiding each
 * other. A missing onset starts at the window start; a missing expires runs to the window end.
 */
export function alertBands(alerts: readonly AlertRow[], fromMs: number, toMs: number): AlertBand[] {
  const bands = alerts
    .map((a) => {
      const onset = a.onset ? Date.parse(a.onset) : fromMs;
      const expires = a.expires ? Date.parse(a.expires) : toMs;
      return {
        ...a,
        startMs: Math.max(fromMs, Number.isFinite(onset) ? onset : fromMs),
        endMs: Math.min(toMs, Number.isFinite(expires) ? expires : toMs),
        lane: 0,
      };
    })
    .filter((b) => b.endMs > b.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  for (const band of bands) {
    let lane = laneEnds.findIndex((end) => end <= band.startMs);
    if (lane < 0) lane = laneEnds.length < ALERT_LANES ? laneEnds.length : ALERT_LANES - 1;
    laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, band.endMs);
    band.lane = lane;
  }
  return bands;
}

/** CSS colour token for a CAP severity. */
export function severityToken(severity: string): "danger" | "warn" | "muted" {
  const s = severity.toLowerCase();
  if (s === "extreme" || s === "severe") return "danger";
  if (s === "moderate") return "warn";
  return "muted";
}
