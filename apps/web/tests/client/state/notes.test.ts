import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { NOTES, resetNoteDraft, setNotePick, setNotePicking, setNotePins, setNotePrefill, type NotePin, type NotesState } from "client/state/notes";

init(state);

const pin = (id: string, text = "two tegus"): NotePin => ({
  id,
  text,
  lat: 25.47,
  lon: -80.48,
  species: "tegu",
  sightingId: null,
  createdBy: "node-a",
  callsign: "Ranger-A",
  createdAt: "2026-09-30T12:00:00Z",
  color: "#4fb3ff",
});

describe("NOTES", () => {
  test("starts with no pins, not picking, nothing picked or prefilled", () => {
    expect(NOTES.defaults).toEqual({ pins: [], picking: false, pick: null, prefill: null });
  });

  test("setNotePins keeps the same value when nothing changed, so chat traffic does not redraw the globe", () => {
    set(NOTES, NOTES.defaults);
    setNotePins([pin("a")]);
    const first = get<NotesState>(NOTES);
    setNotePins([pin("a")]);
    expect(get<NotesState>(NOTES)).toBe(first);
    setNotePins([pin("a", "three tegus")]);
    expect(get<NotesState>(NOTES)).not.toBe(first);
    expect(get<NotesState>(NOTES)!.pins[0]!.text).toBe("three tegus");
    setNotePins([]);
    expect(get<NotesState>(NOTES)!.pins).toEqual([]);
  });

  test("pick on map: arming clears the last pick; the globe's click records the point and disarms", () => {
    set(NOTES, NOTES.defaults);
    setNotePick({ lon: -80.5, lat: 25.4 });
    expect(get<NotesState>(NOTES)).toMatchObject({ picking: false, pick: { lon: -80.5, lat: 25.4 } });
    setNotePicking(true);
    expect(get<NotesState>(NOTES)).toMatchObject({ picking: true, pick: null });
    setNotePick({ lon: -80.6, lat: 25.3 });
    expect(get<NotesState>(NOTES)).toMatchObject({ picking: false, pick: { lon: -80.6, lat: 25.3 } });
    setNotePicking(false);
    expect(get<NotesState>(NOTES)!.pick).toEqual({ lon: -80.6, lat: 25.3 });
  });

  test("a prefill from a sighting card replaces any pick and disarms picking", () => {
    set(NOTES, { ...NOTES.defaults, picking: true, pick: { lon: 0, lat: 0 } });
    setNotePrefill({ lon: -80.4, lat: 25.5, sightingId: "77" });
    expect(get<NotesState>(NOTES)).toMatchObject({ picking: false, pick: null, prefill: { lon: -80.4, lat: 25.5, sightingId: "77" } });
    setNotePrefill(null);
    expect(get<NotesState>(NOTES)!.prefill).toBeNull();
    setNotePins([pin("a")]);
    setNotePick({ lon: -80.5, lat: 25.4 });
    setNotePrefill({ lon: -80.4, lat: 25.5, sightingId: "77" });
    resetNoteDraft();
    // A post clears the draft's place and prefill, never the pins.
    expect(get<NotesState>(NOTES)).toEqual({ pins: [pin("a")], picking: false, pick: null, prefill: null });
    set(NOTES, NOTES.defaults);
  });
});
