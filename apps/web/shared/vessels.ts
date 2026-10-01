/**
 * Vessels (GE4, docs/GODS_EYE.md GC4): the categories `vessels` reports (`api/src/vessels.rs`), their colours and
 * names, the evidence card text, and the pure track maths the globe layer animates with: where a ship is at a
 * time (linear between fixes, held briefly after the last one, never across a long silence) and the trail behind
 * it. Pure: no Cesium, no DOM.
 */

export const VESSEL_CATEGORIES = ["cargo", "tanker", "passenger", "fishing", "tug", "pleasure", "highspeed", "service", "other", "unknown"] as const;
export type VesselCategory = (typeof VESSEL_CATEGORIES)[number];

export function isVesselCategory(v: unknown): v is VesselCategory {
  return typeof v === "string" && (VESSEL_CATEGORIES as readonly string[]).includes(v);
}

/** Marker colours, close to the usual AIS map conventions (cargo green, tanker red, passenger blue). */
export const VESSEL_COLORS: Record<VesselCategory, string> = {
  cargo: "#5fbf6a",
  tanker: "#e5534b",
  passenger: "#4c8dff",
  fishing: "#f0a35e",
  tug: "#3fc1c9",
  pleasure: "#d16ba5",
  highspeed: "#f5d547",
  service: "#9b8cff",
  other: "#a0a8b3",
  unknown: "#d0d4da",
};

export const VESSEL_LABELS: Record<VesselCategory, string> = {
  cargo: "Cargo",
  tanker: "Tanker",
  passenger: "Passenger",
  fishing: "Fishing",
  tug: "Tug or tow",
  pleasure: "Sailing or pleasure",
  highspeed: "High-speed craft",
  service: "Pilot, rescue, law enforcement",
  other: "Other",
  unknown: "Type not reported",
};

/** The credit AISStream asks for, shown on the globe while the layer is on (and in the evidence card). */
export const VESSEL_CREDIT = "Vessel positions: AISStream.io";

/** A ship that has not reported for this long is not drawn. */
export const VESSEL_HOLD_MS = 30 * 60_000;
/** Fixes further apart than this are not joined (the ship was out of range in between). */
export const VESSEL_MAX_GAP_MS = 2 * 3_600_000;
/** Trail length behind the ship: long enough to read at regional zoom (8 kn is 24 nm in 3 h). */
export const VESSEL_TRAIL_MS = 3 * 3_600_000;
/** Below this speed (knots) a ship is drawn as stopped (a dot, no heading). */
export const VESSEL_STOPPED_KN = 0.5;

export type VesselPoint = { at: number; lat: number; lon: number; sog: number | null; cog: number | null; heading: number | null };
export type VesselTrack = { mmsi: string; name: string | null; type: VesselCategory; points: VesselPoint[] };

/** GraphQL `VesselTrack` as received. */
export type GqlVesselTrack = {
  mmsi: string;
  name?: string | null;
  type: string;
  points: { at: string; lat: number; lon: number; sog?: number | null; cog?: number | null; heading?: number | null }[];
};

export function vesselEvidenceId(mmsi: string | number): string {
  return `vessel:${mmsi}`;
}

/** The VesselFinder page of a vessel (the API's `sourcePageUrl` for `vessel:<mmsi>`). */
export function vesselPageUrl(mmsi: string | number): string {
  return `https://www.vesselfinder.com/vessels/details/${mmsi}`;
}

/** Tracks from GraphQL: times parsed, bad points dropped, points in time order. */
export function parseTracks(tracks: readonly GqlVesselTrack[]): VesselTrack[] {
  return tracks.map((t) => ({
    mmsi: String(t.mmsi),
    name: t.name?.trim() || null,
    type: isVesselCategory(t.type) ? t.type : "unknown",
    points: t.points
      .map((p) => ({ at: Date.parse(p.at), lat: p.lat, lon: p.lon, sog: p.sog ?? null, cog: p.cog ?? null, heading: p.heading ?? null }))
      .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .sort((a, b) => a.at - b.at),
  }));
}

/** Initial bearing from a to b, degrees true. */
export function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
}

export type VesselPosition = {
  lat: number;
  lon: number;
  /** Direction of travel, degrees true, or null when stopped or unknown. */
  course: number | null;
  sog: number | null;
  /** Time of the fix at or before `t` the position comes from. */
  fixAt: number;
};

/** Index of the last point at or before `t`, or -1. */
function indexAt(points: readonly VesselPoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.at <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const courseOf = (p: VesselPoint, next?: VesselPoint): number | null => {
  if (p.sog !== null && p.sog < VESSEL_STOPPED_KN) return null;
  if (next && (next.lat !== p.lat || next.lon !== p.lon)) return bearing(p, next);
  return p.cog ?? p.heading ?? null;
};

/**
 * Where the ship is at `t`: on the straight line between the fixes around it, the last fix for up to
 * VESSEL_HOLD_MS after it (or after a gap longer than VESSEL_MAX_GAP_MS), and nowhere before the first fix or
 * after that.
 */
export function positionAt(track: VesselTrack, t: number): VesselPosition | null {
  const pts = track.points;
  const i = indexAt(pts, t);
  if (i < 0) return null;
  const a = pts[i]!;
  const b = pts[i + 1];
  if (b && b.at - a.at <= VESSEL_MAX_GAP_MS && b.at > a.at) {
    const f = (t - a.at) / (b.at - a.at);
    const sog = a.sog !== null && b.sog !== null ? a.sog + (b.sog - a.sog) * f : (a.sog ?? b.sog);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, course: courseOf(a, b), sog, fixAt: a.at };
  }
  if (t - a.at > VESSEL_HOLD_MS) return null;
  return { lat: a.lat, lon: a.lon, course: courseOf(a), sog: a.sog, fixAt: a.at };
}

/**
 * The trail behind the ship at `t`: the fixes in (t - trailMs, t] that are joined to the current position (no
 * long gap in between), oldest first, ending at the position itself. Empty when the ship is not drawn.
 */
export function trailAt(track: VesselTrack, t: number, trailMs = VESSEL_TRAIL_MS): { lat: number; lon: number; at: number }[] {
  const here = positionAt(track, t);
  if (!here) return [];
  const pts = track.points;
  const out: { lat: number; lon: number; at: number }[] = [{ lat: here.lat, lon: here.lon, at: t }];
  let next = { at: t };
  for (let i = indexAt(pts, t); i >= 0; i -= 1) {
    const p = pts[i]!;
    if (p.at <= t - trailMs || next.at - p.at > VESSEL_MAX_GAP_MS) break;
    if (p.lat !== out[0]!.lat || p.lon !== out[0]!.lon) out.unshift({ lat: p.lat, lon: p.lon, at: p.at });
    next = p;
  }
  return out;
}

/** Evidence card text of a `vessel:<mmsi>` record (`api/src/vessels.rs` `evidence_record`). */
export function vesselCard(record: Record<string, unknown>): { title: string; parts: string[] } {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const name = str(record.name) ?? `MMSI ${str(record.mmsi) ?? "unknown"}`;
  const label = str(record.typeLabel) ?? VESSEL_LABELS[isVesselCategory(record.type) ? record.type : "unknown"];
  const last = (record.lastPosition ?? {}) as Record<string, unknown>;
  const sog = num(last.sogKnots);
  const cog = num(last.cogDeg) ?? num(last.headingDeg);
  const parts = [
    label,
    sog === null ? "speed not reported" : sog < VESSEL_STOPPED_KN ? "stopped" : `${sog.toFixed(1)} kn`,
    cog === null || (sog !== null && sog < VESSEL_STOPPED_KN) ? null : `course ${Math.round(cog)}°`,
    str(record.destination) ? `bound for ${str(record.destination)}` : null,
  ].filter((p): p is string => p !== null);
  return { title: name, parts };
}
