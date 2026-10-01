"use client";

/**
 * The Notes tab's own section (T43): a composer ("Add a note": pick a spot on the globe, or start from a
 * sighting's evidence card) and the live list of field notes, newest first. Note text is plain text everywhere:
 * React text nodes, never HTML or markdown. Only the author's row offers Edit and Delete; that is a UI rule, not
 * an enforced one (no auth, PRD §3; docs/security.md).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { activeApp } from "client/state/app";
import { speciesIds } from "shared/apps";

import { getGlobe } from "client/globe/api";
import { colorOfNode, type MeState } from "client/state/me";
import { NOTES, resetNoteDraft, setNotePicking, type NoteLive, type NotesState } from "client/state/notes";
import { PEERS, type Peer } from "client/state/peers";
import { SELECTION, type SelectionState } from "client/state/selection";
import styled from "client/styled";

import { createFieldNoteOps, deleteFieldNoteOp, editFieldNoteOp, isSpecies, MAX_NOTE_CHARS, validateNoteText, type FieldNote } from "../missions/board";
import type { NoteEditor } from "../messages/live";
import { callsignOf, type Team } from "../missions/team";
import { Dot, IconButton, Mono, Pill, SectionTitle } from "../primitives";
import { clearSelection } from "../selection";
import { ago, speciesNames } from "../tooltip/model";
import { canEditNote, NOTE_RATE_LIMIT, noteEvidenceId, placeName, RateLimiter } from "./model";

/** Camera height when a note is opened from the list: the spot and a few hundred metres around it. */
const NOTE_ALTITUDE_M = 4_000;
/** How often relative times in the list refresh. */
const CLOCK_MS = 30_000;

/** ponytail: one cap per tab, in memory; two tabs of one node get twice the cap (documented in model.ts). */
const limiter = new RateLimiter();

const Section = styled.section`
  display: flex;
  flex-direction: column;
  gap: var(--gap-s);
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  flex-wrap: wrap;
`;

const control = `
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: color-mix(in oklch, var(--surface) 60%, transparent);
  color: var(--text);
  font: 13px / 1.4 var(--font-ui);
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
`;

const TextArea = styled.textarea`
  ${control}
  width: 100%;
  min-height: 56px;
  resize: vertical;
  box-sizing: border-box;
`;

const Select = styled.select`
  ${control}
  height: 30px;
  padding: 0 8px;
`;

const Hint = styled.p`
  margin: 0;
  color: var(--muted);
  font-size: 12px;
`;

const ErrorText = styled.p`
  margin: 0;
  color: var(--danger);
  font: 12px var(--font-ui);
`;

const Counter = styled.span<{ $over: boolean }>`
  margin-left: auto;
  color: ${(p) => (p.$over ? "var(--danger)" : "var(--muted)")};
  font: 11px var(--font-mono);
`;

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const NoteRow = styled.li<{ $selected: boolean }>`
  border: 1px solid ${(p) => (p.$selected ? "var(--accent)" : "var(--border)")};
  border-radius: var(--radius-s);
  background: ${(p) => (p.$selected ? "color-mix(in oklch, var(--accent) 10%, transparent)" : "transparent")};
`;

const NoteButton = styled.button`
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 4px;
  padding: 8px;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font: inherit;
  cursor: pointer;
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
`;

const Head = styled.span`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--muted);
`;

const Callsign = styled.span<{ $color: string }>`
  color: ${(p) => p.$color};
  font: 600 11px var(--font-mono);
`;

/** The note body: a text node, wrapped as written. */
const Text = styled.p`
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const Actions = styled.div`
  display: flex;
  gap: var(--gap-s);
  padding: 0 8px 8px;
`;

/** A peer's unsaved edit, shown in place of the saved text while they type (PLAN.md C-A7). */
const LiveText = styled.p`
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-style: italic;
  color: var(--muted);
`;

const Caret = styled.span<{ $color: string }>`
  display: inline-block;
  width: 2px;
  height: 1em;
  margin: 0 1px;
  vertical-align: text-bottom;
  background: ${(p) => p.$color};
  box-shadow: 0 0 4px ${(p) => p.$color};
`;

const Editing = styled.span<{ $color: string }>`
  color: ${(p) => p.$color};
  font: 600 11px var(--font-mono);
`;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  return now;
}

function speciesLabel(id: string): string {
  const i = speciesIds(activeApp()).indexOf(id);
  return i >= 0 ? speciesNames()[i]! : id;
}

function flyToNote(note: Pick<FieldNote, "id" | "lon" | "lat">): void {
  getGlobe()?.flyTo({ lon: note.lon, lat: note.lat, altitudeM: NOTE_ALTITUDE_M });
  // Select without opening the drawer: the bracket marks it; the pin or the card button opens the text.
  set<SelectionState>(SELECTION, (prev) => ({ ...SELECTION.defaults, ...prev, evidenceId: noteEvidenceId(note.id), drawerOpen: false }));
}

type Location = { lon: number; lat: number; sightingId?: string };

/** The draft's place lives in NOTES: a sighting card's prefill, else the last globe pick while armed. */
function draftLocation(notes: NotesState | undefined): Location | null {
  if (notes?.prefill) return { lon: notes.prefill.lon, lat: notes.prefill.lat, sightingId: notes.prefill.sightingId };
  return notes?.pick ? { lon: notes.pick.lon, lat: notes.pick.lat } : null;
}

function Composer({ team, me }: { team: Team; me: MeState | undefined }) {
  const [notes] = useActiveState<NotesState>(NOTES);
  const picking = notes?.picking ?? false;
  const prefill = notes?.prefill ?? null;
  const location = draftLocation(notes);
  const [text, setText] = useState("");
  const [species, setSpecies] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // "Add note about this sighting" lands here with the place set: put the cursor in the text.
  useEffect(() => {
    if (prefill) textRef.current?.focus();
  }, [prefill]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateNoteText(text);
    if (v.error) return setError(v.error);
    if (!location) return setError("Pick a place on the map first");
    if (!limiter.allow()) return setError(`Slow down: at most ${NOTE_RATE_LIMIT} notes a minute`);
    setBusy(true);
    try {
      const { ops } = createFieldNoteOps(team.factory(), {
        text: v.text,
        lat: location.lat,
        lon: location.lon,
        ...(isSpecies(species) ? { species } : {}),
        ...(location.sightingId ? { sightingId: location.sightingId } : {}),
        createdBy: team.nodeId,
        callsign: me?.callsign ?? "",
        createdAt: new Date().toISOString(),
      });
      await team.edit(ops);
      setText("");
      setSpecies("");
      setError(null);
      resetNoteDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const over = text.length > MAX_NOTE_CHARS;
  return (
    <Section as="form" aria-label="Add a note" onSubmit={submit} data-testid="note-composer">
      <SectionTitle>Add a note</SectionTitle>
      <TextArea
        ref={textRef}
        value={text}
        maxLength={MAX_NOTE_CHARS}
        placeholder="What did you see? Where, how many, what it was doing."
        aria-label="Note text"
        onChange={(e) => setText(e.target.value)}
        data-testid="note-text"
      />
      <Row>
        <Select value={species} aria-label="Species" onChange={(e) => setSpecies(e.target.value)} data-testid="note-species">
          <option value="">Species (optional)</option>
          {speciesIds(activeApp()).map((s) => (
            <option key={s} value={s}>
              {speciesLabel(s)}
            </option>
          ))}
        </Select>
        <Counter $over={over} aria-live="polite">
          {text.length}/{MAX_NOTE_CHARS}
        </Counter>
      </Row>
      <Row>
        <IconButton type="button" $active={picking} aria-pressed={picking} onClick={() => setNotePicking(!picking)} data-testid="note-pick">
          {picking ? "Click the globe…" : location ? "Move pin" : "Pick on map"}
        </IconButton>
        {location ? (
          <Mono data-testid="note-location" title={`${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`}>
            {placeName(location.lon, location.lat)}
          </Mono>
        ) : (
          <Hint>Then click the spot on the globe.</Hint>
        )}
        {location?.sightingId && (
          <Pill $tone="muted" data-testid="note-sighting-link">
            about sighting {location.sightingId}
          </Pill>
        )}
      </Row>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Row>
        <IconButton type="submit" $active disabled={busy || !text.trim() || !location} data-testid="note-post">
          Post note
        </IconButton>
      </Row>
    </Section>
  );
}

function NoteItem({ team, note, mine, selected, now, live, peers, me }: { team: Team; note: FieldNote; mine: boolean; selected: boolean; now: number; live: NoteLive | null; peers: readonly Peer[]; me: MeState | undefined }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [error, setError] = useState<string | null>(null);
  const color = colorOfNode(note.createdBy);
  const at = Date.parse(note.createdAt);
  // The live stream of this edit: every keystroke goes to peers until Save or Cancel (`live.ts`).
  const editor = useRef<NoteEditor | null>(null);
  const composing = useRef(false);
  const startEditing = () => {
    setDraft(note.text);
    editor.current?.done();
    editor.current = team.live.note(note.id, note.text);
    setEditing(true);
  };
  const stopEditing = () => {
    editor.current?.done();
    editor.current = null;
    setEditing(false);
  };
  useEffect(() => () => editor.current?.done(), []);
  // A peer's live edit replaces the saved text on screen; this node's own never shows (it is in the textarea).
  const peerLive = live && live.from !== team.nodeId ? live : null;
  // Once their text matches what is saved (they just saved, or have not typed yet) the saved text shows.
  const liveText = peerLive && peerLive.text !== note.text ? peerLive : null;
  const liveColor = peerLive ? colorOfNode(peerLive.from) : color;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      editor.current?.update(draft, false);
      await team.edit([editFieldNoteOp(team.factory(), note.id, draft)]);
      stopEditing();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const remove = () => {
    if (!window.confirm("Delete this note for everyone?")) return;
    void team.edit([deleteFieldNoteOp(team.factory(), note.id)]);
    // A deleted note has no pin to bracket and no card to show.
    if (selected) clearSelection();
  };

  return (
    <NoteRow $selected={selected} data-testid="note-row" data-note-id={note.id} data-author={note.createdBy} data-live={peerLive ? "1" : "0"}>
      <NoteButton type="button" onClick={() => flyToNote(note)} aria-label={`Note by ${note.callsign || "unknown"}: fly to it`}>
        <Head>
          <Dot $tone="ok" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
          <Callsign $color={color} data-testid="note-author">
            {note.callsign || note.createdBy.slice(0, 8)}
          </Callsign>
          <span>{Number.isFinite(at) ? ago(at, now) : "time unknown"}</span>
          <span>· {placeName(note.lon, note.lat)}</span>
          {note.species && (
            <Pill $tone="muted" data-testid="note-species-tag">
              {speciesLabel(note.species)}
            </Pill>
          )}
          {peerLive && (
            <Editing $color={liveColor} data-testid="note-editing" aria-live="polite">
              {callsignOf(peerLive.from, peers, me)} is editing…
            </Editing>
          )}
        </Head>
        {!editing && !liveText && <Text data-testid="note-body">{note.text}</Text>}
        {!editing && liveText && (
          <LiveText data-testid="note-live" data-from={liveText.from}>
            {liveText.text.slice(0, Math.min(liveText.caret, liveText.text.length))}
            <Caret $color={liveColor} data-testid="note-caret" aria-hidden="true" />
            {liveText.text.slice(Math.min(liveText.caret, liveText.text.length))}
          </LiveText>
        )}
      </NoteButton>
      {editing ? (
        <Section as="form" aria-label="Edit note" onSubmit={save} style={{ padding: "0 8px 8px" }}>
          <TextArea
            value={draft}
            maxLength={MAX_NOTE_CHARS}
            aria-label="Edit note text"
            onChange={(e) => {
              setDraft(e.target.value);
              editor.current?.update(e.target.value, composing.current);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(e) => {
              composing.current = false;
              editor.current?.update(e.currentTarget.value, false);
            }}
            data-testid="note-edit-text"
          />
          {error && <ErrorText role="alert">{error}</ErrorText>}
          <Row>
            <IconButton type="submit" $active disabled={!draft.trim()} data-testid="note-save">
              Save
            </IconButton>
            <IconButton
              type="button"
              onClick={() => {
                editor.current?.update(note.text, false);
                stopEditing();
              }}
            >
              Cancel
            </IconButton>
          </Row>
        </Section>
      ) : (
        mine && (
          <Actions>
            <IconButton type="button" onClick={startEditing} data-testid="note-edit">
              Edit
            </IconButton>
            <IconButton type="button" onClick={remove} aria-label="Delete note" data-testid="note-delete">
              Delete
            </IconButton>
          </Actions>
        )
      )}
    </NoteRow>
  );
}

/** Composer plus the live list. `notes` is the board model's `fieldNotes`, newest first. */
export default function NotesPanel({ team, me, notes }: { team: Team; me: MeState | undefined; notes: readonly FieldNote[] }) {
  const now = useNow();
  const selected = useActiveState<SelectionState, string | null>(SELECTION, (s) => s.evidenceId)[0] ?? null;
  const live = useActiveState<NotesState, NotesState["live"]>(NOTES, (s) => s.live)[0] ?? NOTES.defaults.live;
  const peers = useActiveState<Peer[]>(PEERS)[0] ?? [];
  return (
    <>
      <Composer team={team} me={me} />
      <Section aria-label="Notes">
        <SectionTitle>Notes</SectionTitle>
        {notes.length === 0 && <Hint data-testid="notes-empty">No notes yet. Tap “Pick on map”, click a spot and write what you saw.</Hint>}
        <List data-testid="note-list">
          {notes.map((n) => (
            <NoteItem key={n.id} team={team} note={n} mine={canEditNote(n, team.nodeId)} selected={selected === noteEvidenceId(n.id)} now={now} live={live[n.id] ?? null} peers={peers} me={me} />
          ))}
        </List>
      </Section>
    </>
  );
}
