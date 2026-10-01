"use client";

/**
 * The evidence drawer's card for `note:<id>` (T43). Notes are not Axum evidence: the card reads the live board
 * through NOTES.pins (published from `readBoard`), so it needs no request and shows offline notes too. Plain
 * text only.
 */
import { useState } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { colorOfNode } from "client/state/me";
import { MISSIONS, type MissionsState } from "client/state/missions";
import { NOTES, setNotePrefill, type NotePin, type NotesState } from "client/state/notes";
import styled from "client/styled";

import { openEvidence } from "../selection";
import { Dot, IconButton, Mono, Pill, SectionTitle } from "../primitives";
import { ago, SPECIES_NAMES } from "../tooltip/model";
import { placeName } from "./model";
import { SPECIES_IDS } from "shared/voice/ui-tools";

const Card = styled.section`
  display: flex;
  flex-direction: column;
  gap: var(--gap-s);
  margin-bottom: var(--gap-l);
`;

const Head = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--muted);
`;

const Text = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const Muted = styled.p`
  margin: 0;
  color: var(--muted);
  font-size: 12px;
`;

const utc = (iso: string) => (Number.isFinite(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")}Z` : "—");

export function noteById(pins: readonly NotePin[] | undefined, id: string): NotePin | null {
  return pins?.find((p) => p.id === id) ?? null;
}

export default function NoteCard({ id }: { id: string }) {
  const [notes] = useActiveState<NotesState>(NOTES);
  // The card mounts per open, so its clock is the moment it opened.
  const [now] = useState(() => Date.now());
  const note = noteById(notes?.pins, id);
  if (!note) return <Muted data-testid="note-card-missing">This note was deleted, or has not reached this browser yet.</Muted>;
  const color = colorOfNode(note.createdBy);
  const at = Date.parse(note.createdAt);
  const speciesIndex = note.species ? (SPECIES_IDS as readonly string[]).indexOf(note.species) : -1;
  return (
    <Card aria-label="Field note" data-testid="note-card" data-note-id={note.id}>
      <SectionTitle>Field note</SectionTitle>
      <Head>
        <Dot $tone="ok" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
        <Mono style={{ color }}>{note.callsign || note.createdBy.slice(0, 8)}</Mono>
        <span title={utc(note.createdAt)}>{Number.isFinite(at) ? ago(at, now) : "time unknown"}</span>
        <span>· {placeName(note.lon, note.lat)}</span>
        {note.species && <Pill $tone="muted">{speciesIndex >= 0 ? SPECIES_NAMES[speciesIndex] : note.species}</Pill>}
      </Head>
      <Text data-testid="note-card-text">{note.text}</Text>
      <Mono style={{ fontSize: 11, color: "var(--muted)" }}>
        {note.lat.toFixed(5)}, {note.lon.toFixed(5)}
      </Mono>
      <Head>
        {note.sightingId && (
          <IconButton type="button" onClick={() => openEvidence(`sighting:${note.sightingId}`)} data-testid="note-card-sighting">
            Related sighting
          </IconButton>
        )}
        <IconButton
          type="button"
          onClick={() => set<MissionsState>(MISSIONS, (prev) => ({ ...MISSIONS.defaults, ...prev, panelOpen: true }))}
          data-testid="note-card-open-tab"
        >
          Open Notes tab
        </IconButton>
      </Head>
    </Card>
  );
}

/**
 * "Add note about this sighting" on a sighting's evidence card: prefills the composer with the sighting's place
 * and id, and opens the Notes tab.
 */
export function AddNoteButton({ sightingId, lon, lat }: { sightingId: string; lon: number; lat: number }) {
  return (
    <IconButton
      type="button"
      onClick={() => {
        setNotePrefill({ lon, lat, sightingId });
        set<MissionsState>(MISSIONS, (prev) => ({ ...MISSIONS.defaults, ...prev, panelOpen: true }));
      }}
      title="Write a field note pinned to this sighting"
      data-testid="add-note-about-sighting"
    >
      Add note about this sighting
    </IconButton>
  );
}
