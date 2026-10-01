import { key, set } from "@calvinjs/active-state";

/**
 * Field notes (T43): what people on the team wrote on the map. The notes themselves are `note` entities on the
 * CRDT board (PLAN.md C5, `client/hud/missions/board.ts`); this key carries the live pins the globe draws and
 * the drawer reads, plus the composer's pick-on-map handshake, so the globe never imports the team session.
 */
export type NotePin = {
  id: string;
  text: string;
  lat: number;
  lon: number;
  species: string | null;
  /** `sightings.id` the note is about, when it started from a sighting's evidence card. */
  sightingId: string | null;
  /** Author node id (ME.nodeId at write time). */
  createdBy: string;
  callsign: string;
  /** RFC 3339. */
  createdAt: string;
  /** Author colour, derived from the node id (`colorOfNode`). */
  color: string;
};

/** A peer's unsaved edit of a note as it streams in (PLAN.md C-A7 `note.delta`). */
export type NoteLive = {
  /** The editor's node id (the channel's peer id, set by the rtc worker). */
  from: string;
  text: string;
  /** The editor's caret, in UTF-16 code units of `text`. */
  caret: number;
  /** Last delta, ms since epoch. */
  at: number;
};

export type NotesState = {
  /** Live (non-deleted) notes on the board, newest first. */
  pins: NotePin[];
  /** Notes a peer is editing right now, by note id. */
  live: Record<string, NoteLive>;
  /** "Pick on map" is armed: the next globe click lands in `pick` instead of selecting evidence. */
  picking: boolean;
  /** The last picked globe point, consumed by the composer. */
  pick: { lon: number; lat: number } | null;
  /** A composer prefill from a sighting's evidence card ("Add note about this sighting"). */
  prefill: { lon: number; lat: number; sightingId: string } | null;
};

const defaults: NotesState = { pins: [], live: {}, picking: false, pick: null, prefill: null };

export const NOTES = key("NOTES", defaults);

const same = (a: readonly NotePin[], b: readonly NotePin[]) => a.length === b.length && a.every((p, i) => p === b[i] || JSON.stringify(p) === JSON.stringify(b[i]));

/** Replace the pins; a no-op when nothing changed, so chat traffic does not redraw the globe. */
export function setNotePins(pins: NotePin[]): void {
  set<NotesState>(NOTES, (prev = NOTES.defaults) => (same(prev.pins, pins) ? prev : { ...prev, pins }));
}

/** A peer's live edit of `noteId`, or null once it saved, cancelled or dropped off. */
export function setNoteLive(noteId: string, live: NoteLive | null): void {
  set<NotesState>(NOTES, (prev = NOTES.defaults) => {
    if (live === null) {
      if (!(noteId in prev.live)) return prev;
      const next = { ...prev.live };
      delete next[noteId];
      return { ...prev, live: next };
    }
    return { ...prev, live: { ...prev.live, [noteId]: live } };
  });
}

export function setNotePicking(picking: boolean): void {
  set<NotesState>(NOTES, (prev = NOTES.defaults) => ({ ...prev, picking, ...(picking ? { pick: null } : {}) }));
}

/** The globe's click while picking: records the point and disarms. */
export function setNotePick(pick: { lon: number; lat: number }): void {
  set<NotesState>(NOTES, (prev = NOTES.defaults) => ({ ...prev, picking: false, pick }));
}

export function setNotePrefill(prefill: NotesState["prefill"]): void {
  set<NotesState>(NOTES, (prev = NOTES.defaults) => ({ ...prev, prefill, pick: null, picking: false }));
}

/** After a post: no place, no prefill, not picking. */
export function resetNoteDraft(): void {
  set<NotesState>(NOTES, (prev = NOTES.defaults) => ({ ...prev, picking: false, pick: null, prefill: null }));
}
