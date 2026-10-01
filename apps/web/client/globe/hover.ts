/**
 * What a globe marker stands for, as the layer that drew it knows it (T40 hover tooltips). Layers answer
 * `describe(id)` from their own draw state, so hovering costs no request; `client/hud/tooltip/model.ts` turns
 * these facts into tooltip text.
 */

export type StationFacts = {
  kind: "station";
  /** Network: usgs, ndbc, coops. */
  source: string;
  name: string;
  /** GraphQL `Param`, e.g. STAGE_M. */
  param: string;
  value: number | null;
  observedAtMs: number;
  lon: number;
  lat: number;
};

export type SightingFacts = {
  kind: "sighting";
  /** `sightings.id`. */
  id: number;
  /** EVF taxon id; 1-4 are the focus species. */
  taxon: number;
  /** Index into QUALITY_CODES. */
  quality: number;
  /** Age at the time cursor, whole frames. */
  ageMs: number;
  conflict: boolean;
  lon: number;
  lat: number;
};

export type AlertFacts = {
  kind: "alert";
  event: string;
  severity: string;
  headline: string | null;
  expiresMs: number | null;
};

export type HotspotFacts = {
  kind: "hotspot";
  /** Index into the active app's focus species (config order). */
  species: number;
  /** Heuristic score, 0..1. */
  score: number;
};

export type NoteFacts = {
  kind: "note";
  /** The note's board entity id. */
  id: string;
  callsign: string;
  /** Plain text, as written. */
  text: string;
  lon: number;
  lat: number;
};

export type HoverFacts = StationFacts | SightingFacts | AlertFacts | HotspotFacts | NoteFacts;

/** Facts with a fixed place, so the tooltip can anchor to the marker instead of the pointer. */
export function anchorOf(facts: HoverFacts): { lon: number; lat: number } | null {
  return facts.kind === "station" || facts.kind === "sighting" || facts.kind === "note" ? { lon: facts.lon, lat: facts.lat } : null;
}
