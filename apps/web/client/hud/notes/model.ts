/**
 * Pure helpers behind the Notes tab and the note pins (T43): evidence ids, the per-node posting rate cap, place
 * names for the list, and the pins the globe draws. No DOM; `tests/client/hud/notes` runs it under bun.
 */
import { PLACES } from "client/voice/gazetteer";
import { colorOfNode } from "client/state/me";
import type { NotePin } from "client/state/notes";
import { parseEvidenceId } from "client/state/selection";

import type { FieldNote } from "../missions/board";

/** At most this many notes per minute from one node, checked in the browser before an op is built. */
export const NOTE_RATE_LIMIT = 20;
export const NOTE_RATE_WINDOW_MS = 60_000;
/** Tooltip and list preview length. */
export const NOTE_PREVIEW_CHARS = 80;

export const noteEvidenceId = (id: string) => `note:${id}`;

/** `note:<id>` → id, or null for any other evidence id. */
export function parseNoteId(evidenceId: string): string | null {
  const parsed = parseEvidenceId(evidenceId);
  return parsed?.kind === "note" ? parsed.key : null;
}

/** The author, and nobody else, edits or deletes a note. Client-side only (no auth, PRD §3); see docs/security.md. */
export function canEditNote(note: Pick<FieldNote, "createdBy">, nodeId: string): boolean {
  return note.createdBy !== "" && note.createdBy === nodeId;
}

/** First `max` characters, on a word boundary where there is one, with an ellipsis when cut. */
export function preview(text: string, max = NOTE_PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * Sliding-window rate cap: `allow(now)` records a post and answers whether it may go. ponytail: per tab, in memory;
 * two tabs of one node get twice the cap, and the server has no cap at all (prototype, no auth).
 */
export class RateLimiter {
  private readonly stamps: number[] = [];
  constructor(
    private readonly limit = NOTE_RATE_LIMIT,
    private readonly windowMs = NOTE_RATE_WINDOW_MS,
  ) {}

  allow(now = Date.now()): boolean {
    while (this.stamps.length > 0 && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }

  /** Ms until the next post may go; 0 when it may go now. */
  retryInMs(now = Date.now()): number {
    if (this.stamps.length < this.limit) return 0;
    return Math.max(0, this.stamps[0]! + this.windowMs - now);
  }
}

const KM_PER_DEG = 111.32;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
/** Towns, park units and reefs; the regional entries (the park, Florida Bay, the Keys) are too wide to name a spot. */
const NAMED = PLACES.filter((p) => p.altitudeM <= 40_000);
/** Within this distance the spot just takes the place's name. */
const AT_PLACE_KM = 2;

/** `Homestead`, or `4 km NE of Homestead`: the nearest named place in the gazetteer, for a reader without a map. */
export function placeName(lon: number, lat: number): string {
  let best: { name: string; km: number; bearing: number } | null = null;
  for (const p of NAMED) {
    const dx = (lon - p.lon) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const dy = (lat - p.lat) * KM_PER_DEG;
    const km = Math.hypot(dx, dy);
    if (!best || km < best.km) best = { name: p.name, km, bearing: (Math.atan2(dx, dy) * 180) / Math.PI };
  }
  if (!best) return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  if (best.km < AT_PLACE_KM) return best.name;
  const dir = COMPASS[Math.round(((best.bearing + 360) % 360) / 45) % 8]!;
  return `${Math.round(best.km)} km ${dir} of ${best.name}`;
}

/** The globe's pins from the board's field notes: the note plus its author's colour. */
export function pinsOf(notes: readonly FieldNote[]): NotePin[] {
  return notes.map((n) => ({ ...n, color: colorOfNode(n.createdBy) }));
}
