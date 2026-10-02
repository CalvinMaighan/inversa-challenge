/**
 * Hover tooltip text (T40): the marker's name first, then its key value and age, e.g.
 *
 *   USGS gauge · Shark River · stage 1.21 m · 12 min ago
 *   Burmese python · research · iNat · 2 h ago
 *   Freeze Warning until 09:00
 *
 * Pure over the layer's `HoverFacts`, the time cursor and, for sightings, the record the evidence cache may
 * already hold (source and exact time).
 */
import type { AlertFacts, HoverFacts, HotspotFacts, NoteFacts, SightingFacts, StationFacts } from "client/globe/hover";
import { speciesIndexOfTaxon } from "client/globe/species";
import { activeApp } from "client/state/app";
import { QUALITY_CODES } from "shared/frames";

import { feedLabel } from "../topbar/feed-chips";
import { regionTimeZone, zoneFormatter } from "../topbar/clock";

export type TooltipText = {
  /** Bold lead: what the marker is. */
  title: string;
  /** The rest, joined with " · ". */
  parts: string[];
};

/** The marker as one line. */
export function tooltipLine(t: TooltipText): string {
  return [t.title, ...t.parts].join(" · ");
}

/** Station networks as an analyst names them. */
export const NETWORK_LABELS: Record<string, string> = {
  usgs: "USGS gauge",
  ndbc: "NDBC buoy",
  coops: "NOAA tide gauge",
};

/** Display names of the active app's focus species, in config order. */
export function speciesNames(): string[] {
  return activeApp().taxa.map((t) => t.name);
}
/** A taxon that is not the app's (never drawn; a stale record at most). */
const UNNAMED_SPECIES = "Unnamed species";

/** Quality codes as the tooltip shows them, indexed like QUALITY_CODES (`needs_id` reads "needs ID"). */
const QUALITY_LABELS: readonly string[] = QUALITY_CODES.map((code) => code.replace(/_id$/, " ID").replace(/_/g, " "));

/** In-situ params (GraphQL `Param`) → label and unit. */
const PARAMS: Record<string, { label: string; unit: string; digits: number }> = {
  STAGE_M: { label: "stage", unit: "m", digits: 2 },
  WATER_C: { label: "water", unit: "°C", digits: 1 },
  AIR_C: { label: "air", unit: "°C", digits: 1 },
  WAVE_M: { label: "waves", unit: "m", digits: 1 },
  RAIN_MM: { label: "rain", unit: "mm", digits: 1 },
  WIND_MS: { label: "wind", unit: "m/s", digits: 1 },
};

const tooltipFmt = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Times in the active app's zone. */
const timeFmt = { format: (d: Date) => zoneFormatter("tooltip", regionTimeZone(), tooltipFmt).format(d) };

/** `12 min ago`, `2 h ago`, `3 d ago`; `just now` under a minute; `in 5 min` for times after `atMs`. */
export function ago(ms: number, atMs: number): string {
  if (!Number.isFinite(ms) || !Number.isFinite(atMs)) return "time unknown";
  const d = atMs - ms;
  const future = d < 0;
  const s = Math.abs(d) / 1000;
  let text: string;
  if (s < 60) return "just now";
  if (s < 3600) text = `${Math.round(s / 60)} min`;
  else if (s < 48 * 3600) text = `${Math.round(s / 3600)} h`;
  else text = `${Math.round(s / 86_400)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

/** The species name for a taxon id: the app's species name, else a plain placeholder. */
export function speciesName(taxon: number): string {
  const s = speciesIndexOfTaxon(taxon);
  return s >= 0 ? speciesNames()[s]! : UNNAMED_SPECIES;
}

export function formatReading(param: string, value: number | null): string | null {
  const p = PARAMS[param.toUpperCase()];
  if (value === null || !Number.isFinite(value)) return p ? `${p.label} —` : null;
  if (!p) return `${param.toLowerCase()} ${value}`;
  return `${p.label} ${value.toFixed(p.digits)} ${p.unit}`;
}

function station(f: StationFacts, atMs: number): TooltipText {
  const network = NETWORK_LABELS[f.source.toLowerCase()] ?? `${feedLabel(f.source)} station`;
  const reading = formatReading(f.param, f.value);
  return { title: network, parts: [f.name, ...(reading ? [reading] : []), ago(f.observedAtMs, atMs)] };
}

/** The bits of a sighting's evidence record the tooltip uses, when the drawer cache already has it. */
export type SightingRecordHint = { source?: unknown; observedAt?: unknown };

function sighting(f: SightingFacts, atMs: number, record: SightingRecordHint | null): TooltipText {
  const quality = QUALITY_LABELS[f.quality] ?? QUALITY_CODES[f.quality] ?? "unknown grade";
  const source = typeof record?.source === "string" && record.source ? feedLabel(record.source) : null;
  const observed = typeof record?.observedAt === "string" ? Date.parse(record.observedAt) : NaN;
  const when = Number.isFinite(observed) ? ago(observed, atMs) : f.ageMs < 60 * 60_000 ? "this hour" : `${ago(atMs - f.ageMs, atMs)}`;
  return {
    title: speciesName(f.taxon),
    parts: [quality, ...(source ? [source] : []), when, ...(f.conflict ? ["IDs conflict"] : [])],
  };
}

function alert(f: AlertFacts): TooltipText {
  const until = f.expiresMs !== null ? `until ${timeFmt.format(new Date(f.expiresMs))}` : null;
  return { title: until ? `${f.event} ${until}` : f.event, parts: [f.severity.toLowerCase()].filter((s) => s && s !== "unknown") };
}

function hotspot(f: HotspotFacts): TooltipText {
  const name = speciesNames()[f.species] ?? "Species";
  return { title: `${name} hotspot`, parts: [`score ${f.score.toFixed(2)}`, "heuristic"] };
}

/** Note text is shown as written, as a text node (never HTML); the first 80 characters here. */
const NOTE_PREVIEW_CHARS = 80;

function note(f: NoteFacts): TooltipText {
  const flat = f.text.replace(/\s+/g, " ").trim();
  return { title: f.callsign || "Note", parts: [flat.length > NOTE_PREVIEW_CHARS ? `${flat.slice(0, NOTE_PREVIEW_CHARS)}…` : flat] };
}

/** Tooltip text for a marker. `atMs` is the time cursor (ages read against it, so replay reads right). */
export function tooltipText(facts: HoverFacts, atMs: number, record: SightingRecordHint | null = null): TooltipText {
  switch (facts.kind) {
    case "note":
      return note(facts);
    case "station":
      return station(facts, atMs);
    case "sighting":
      return sighting(facts, atMs, record);
    case "alert":
      return alert(facts);
    case "hotspot":
      return hotspot(facts);
  }
}

/** Tooltip box placement: right of and below the anchor, flipped to stay inside the pane. */
export function placeTooltip(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  pane: { width: number; height: number },
  offset = 14,
): { x: number; y: number } {
  let x = anchor.x + offset;
  let y = anchor.y + offset;
  if (x + size.width > pane.width - 4) x = anchor.x - offset - size.width;
  if (y + size.height > pane.height - 4) y = anchor.y - offset - size.height;
  return { x: Math.max(4, Math.round(x)), y: Math.max(4, Math.round(y)) };
}
