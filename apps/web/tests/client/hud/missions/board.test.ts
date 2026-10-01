import { describe, expect, test } from "bun:test";
import { SPECIES_IDS, selectPython } from "@/tests/client/python-app";

import { parseHotspotId } from "client/hud/drawer/evidence";
import {
  boardModel,
  bumpCounter,
  counterKey,
  createFieldNoteOps,
  createMissionOps,
  createNoteOps,
  deleteFieldNoteOp,
  deleteMissionOp,
  editFieldNoteOp,
  fieldNotes,
  formFromHotspot,
  MAX_NOTE_CHARS,
  MAX_TITLE_CHARS,
  memoryCounterStore,
  messageOp,
  overlayOps,
  MISSION_WINDOW_MS,
  missionFieldsFromForm,
  readCounter,
  removalOp,
  setStatusOp,
  toFieldNote,
  toMission,
  totals,
  uuidv7,
  validateMissionForm,
  validateNoteText,
  type MissionForm,
  type OpFactory,
} from "client/hud/missions/board";
import { Clock, parse } from "client/threads/crdt/hlc";
import { applyOps, createState, viewBoard } from "client/threads/crdt/merge";
import { validateOp } from "client/threads/crdt/merge";
import type { Op } from "client/threads/crdt/types";

selectPython();

const [PYTHON, TEGU] = SPECIES_IDS;
const AT = Date.parse("2026-09-30T12:00:00Z");
const HOTSPOT = `hotspot:${PYTHON}:120:80:${AT}`;

const form = (over: Partial<MissionForm> = {}): MissionForm => ({ title: "Sweep", species: PYTHON, cell: "120:80", at: new Date(AT).toISOString(), ...over });

function factory(nodeId = "node-a", start = 1_700_000_000_000): OpFactory & { t: number } {
  const f = { t: start, clock: new Clock(nodeId), boardId: "everglades", nodeId, now: () => f.t };
  return f;
}

describe("uuidv7", () => {
  test("is a v7 uuid whose time prefix sorts by creation ms", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(uuidv7(1, () => new Uint8Array(10))).toBe("00000000-0001-7000-8000-000000000000");
    expect(new Set(Array.from({ length: 200 }, () => uuidv7())).size).toBe(200);
  });
});

describe("mission form validation", () => {
  test("prefills from a hotspot selection", () => {
    const ref = parseHotspotId(HOTSPOT)!;
    expect(formFromHotspot(ref)).toEqual({ title: `${PYTHON} sweep · cell 120:80`, species: PYTHON, cell: "120:80", at: "2026-09-30T12:00:00.000Z" });
    expect(validateMissionForm(formFromHotspot(ref))).toEqual({});
  });

  test("rejects an empty or oversized title, an unknown species, a malformed cell and a bad frame time", () => {
    expect(validateMissionForm(form({ title: "   " })).title).toBe("Title is required");
    expect(validateMissionForm(form({ title: "x".repeat(MAX_TITLE_CHARS + 1) })).title).toMatch(/or fewer/);
    expect(validateMissionForm(form({ title: "x".repeat(MAX_TITLE_CHARS) })).title).toBeUndefined();
    expect(validateMissionForm(form({ species: "gator" })).species).toBe("Pick a species");
    expect(validateMissionForm(form({ cell: "12080" })).cell).toMatch(/<col>:<row>/);
    expect(validateMissionForm(form({ cell: "1200:80" })).cell).toBeDefined();
    expect(validateMissionForm(form({ at: "yesterday" })).at).toBeDefined();
    expect(Object.keys(validateMissionForm(form({ title: "", species: "", cell: "", at: "" }))).sort()).toEqual(["at", "cell", "species", "title"]);
  });

  test("fields: cell centre on the 0.01° grid, a one-day window from the frame, planned, creator", () => {
    const fields = missionFieldsFromForm(form({ title: "  Sweep  " }), "node-a");
    expect(fields).toEqual({
      title: "Sweep",
      species: PYTHON,
      cell: "120:80",
      lon: -83.2 + 120.5 * 0.01,
      lat: 24.3 + 80.5 * 0.01,
      window: { from: "2026-09-30T12:00:00.000Z", to: new Date(AT + MISSION_WINDOW_MS).toISOString() },
      status: "planned",
      createdBy: "node-a",
    });
    expect(() => missionFieldsFromForm(form({ title: "" }), "n")).toThrow("Title is required");
  });
});

describe("op builders", () => {
  test("a mission is one valid LWW op per field with increasing HLCs and the same uuidv7 id", () => {
    const f = factory();
    const fields = missionFieldsFromForm(form(), f.nodeId);
    const { id, ops } = createMissionOps(f, fields);
    expect(ops.map((o) => o.field).sort()).toEqual(Object.keys(fields).sort());
    for (const o of ops) {
      expect(validateOp(o, "everglades")).toBeNull();
      expect(o).toMatchObject({ entity: "mission", entityId: id, nodeId: "node-a", boardId: "everglades" });
      expect(parse(o.hlc)!.nodeId).toBe("node-a");
    }
    const counters = ops.map((o) => parse(o.hlc)!.counter);
    expect(counters).toEqual([...counters].sort((a, b) => a - b));
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
    const view = viewBoard(applyOps(createState("everglades"), ops));
    expect(view.missions).toEqual([{ id, fields }]);
  });

  test("status, delete, message, note and removal ops validate and merge as intended", () => {
    const f = factory();
    const { id, ops } = createMissionOps(f, missionFieldsFromForm(form(), f.nodeId));
    const later: Op[] = [setStatusOp(f, id, "in_progress"), messageOp(f, "on my way"), ...createNoteOps(f, id, "bring the long hook"), removalOp(f, id, 2), removalOp(f, id, 3)];
    for (const o of later) expect(validateOp(o, "everglades")).toBeNull();
    const view = viewBoard(applyOps(createState("everglades"), [...ops, ...later]));
    expect(view.missions[0]!.fields.status).toBe("in_progress");
    expect(view.messages.map((m) => m.body)).toEqual(["on my way"]);
    expect(view.notes[0]!.fields).toMatchObject({ missionId: id, body: "bring the long hook", createdBy: "node-a" });
    expect(view.removals).toEqual({ [id]: 3 }); // per-node max, not a sum of this node's own ops
    const gone = viewBoard(applyOps(createState("everglades"), [...ops, ...later, deleteMissionOp(f, id)]));
    expect(gone.missions).toEqual([]);
  });
});

describe("field note ops (T43)", () => {
  const fields = (over: Partial<Parameters<typeof createFieldNoteOps>[1]> = {}) => ({
    text: "Two tegus by the canal gate",
    lat: 25.4687,
    lon: -80.4776,
    createdBy: "node-a",
    callsign: "Ranger-A",
    createdAt: "2026-09-30T12:00:00.000Z",
    ...over,
  });

  test("create: one valid LWW op per set field on the note entity; optional fields are left out, not nulled", () => {
    const f = factory();
    const { id, ops } = createFieldNoteOps(f, fields());
    expect(ops.map((o) => o.field).sort()).toEqual(["callsign", "createdAt", "createdBy", "lat", "lon", "text"]);
    for (const o of ops) {
      expect(validateOp(o, "everglades")).toBeNull();
      expect(o).toMatchObject({ entity: "note", entityId: id, nodeId: "node-a", boardId: "everglades" });
    }
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
    const tagged = createFieldNoteOps(f, fields({ species: TEGU, sightingId: "77" }));
    expect(tagged.ops.map((o) => o.field)).toContain("species");
    expect(tagged.ops.map((o) => o.field)).toContain("sightingId");
    const view = viewBoard(applyOps(createState("everglades"), [...ops, ...tagged.ops]));
    expect(view.notes).toHaveLength(2);
    expect(toFieldNote(view.notes.find((n) => n.id === id)!)).toEqual({ id, text: "Two tegus by the canal gate", lat: 25.4687, lon: -80.4776, species: null, sightingId: null, createdBy: "node-a", callsign: "Ranger-A", createdAt: "2026-09-30T12:00:00.000Z" });
    expect(toFieldNote(view.notes.find((n) => n.id === tagged.id)!)).toMatchObject({ species: TEGU, sightingId: "77" });
  });

  test("validation: empty text, the 500-character cap, and a missing place are refused before any op exists", () => {
    expect(validateNoteText("   ").error).toBe("Write something first");
    expect(validateNoteText("x".repeat(MAX_NOTE_CHARS)).error).toBeNull();
    expect(validateNoteText("x".repeat(MAX_NOTE_CHARS + 1)).error).toMatch(/500 characters/);
    expect(validateNoteText("  trims  ").text).toBe("trims");
    const f = factory();
    expect(() => createFieldNoteOps(f, fields({ text: "" }))).toThrow("Write something first");
    expect(() => createFieldNoteOps(f, fields({ text: "x".repeat(MAX_NOTE_CHARS + 1) }))).toThrow(/500/);
    expect(() => createFieldNoteOps(f, fields({ lat: Number.NaN }))).toThrow(/Pick a place/);
    expect(() => createFieldNoteOps(f, fields({ lon: 181 }))).toThrow(/Pick a place/);
    expect(() => editFieldNoteOp(f, "n", " ")).toThrow("Write something first");
  });

  test("edit: a later text op wins; an older one that arrives late does not; the view caps a stored overlong text", () => {
    const f = factory();
    const { id, ops } = createFieldNoteOps(f, fields());
    f.t += 10;
    const edit = editFieldNoteOp(f, id, "Three tegus by the canal gate");
    const stale: Op = { ...edit, id: "stale-op", hlc: "1600000000000:0:node-z", value: "older text" };
    const view = viewBoard(applyOps(createState("everglades"), [...ops, edit, stale]));
    expect(toFieldNote(view.notes[0]!)!.text).toBe("Three tegus by the canal gate");
    const long = viewBoard(applyOps(createState("everglades"), [...ops, { ...edit, id: "long-op", value: "y".repeat(900) }]));
    expect(toFieldNote(long.notes[0]!)!.text).toHaveLength(MAX_NOTE_CHARS);
  });

  test("delete: the tombstone hides the note; an edit that arrives after it does not resurrect it", () => {
    const f = factory();
    const { id, ops } = createFieldNoteOps(f, fields());
    f.t += 10;
    const gone = deleteFieldNoteOp(f, id);
    expect(gone).toMatchObject({ entity: "note", entityId: id, field: "_deleted", value: true });
    f.t += 10;
    const late = editFieldNoteOp(f, id, "edited after delete");
    expect(viewBoard(applyOps(createState("everglades"), [...ops, gone])).notes).toEqual([]);
    expect(viewBoard(applyOps(createState("everglades"), [...ops, late, gone])).notes).toEqual([]);
    expect(viewBoard(applyOps(createState("everglades"), [...ops, gone, late])).notes).toEqual([]);
  });

  test("ordering and separation: field notes newest first by createdAt; mission notes and placeless rows are not field notes", () => {
    const f = factory();
    const first = createFieldNoteOps(f, fields({ createdAt: "2026-09-30T10:00:00.000Z", text: "first" }));
    const second = createFieldNoteOps(f, fields({ createdAt: "2026-09-30T11:00:00.000Z", text: "second" }));
    const { id: missionId, ops: missionOps } = createMissionOps(f, missionFieldsFromForm(form(), f.nodeId));
    const state = applyOps(createState("everglades"), [...second.ops, ...first.ops, ...missionOps, ...createNoteOps(f, missionId, "bring the long hook")]);
    const model = boardModel(viewBoard(state));
    expect(model.fieldNotes.map((n) => n.text)).toEqual(["second", "first"]);
    expect(model.notes.map((n) => n.body)).toEqual(["bring the long hook"]);
    expect(fieldNotes([{ id: "x", fields: { text: "no place" } }])).toEqual([]);
    expect(fieldNotes([{ id: "x", fields: { text: "bad place", lat: 99, lon: 0 } }])).toEqual([]);
    expect(fieldNotes([{ id: "x", fields: { text: 7, lat: 25, lon: -80 } }])).toEqual([]);
  });
});

describe("removal counters", () => {
  test("bump persists this node's running total; a second node's counter is separate; totals sum across nodes", () => {
    const store = memoryCounterStore();
    expect(readCounter(store, "b", "A", "m")).toBe(0);
    expect(bumpCounter(store, "b", "A", "m")).toBe(1);
    expect(bumpCounter(store, "b", "A", "m")).toBe(2);
    expect(bumpCounter(store, "b", "A", "m", 3)).toBe(5);
    expect(bumpCounter(store, "b", "B", "m")).toBe(1);
    expect(store.map.get(counterKey("b", "A", "m"))).toBe("5");
    store.map.set(counterKey("b", "A", "x"), "junk");
    expect(readCounter(store, "b", "A", "x")).toBe(0);
    store.map.set(counterKey("b", "A", "y"), "-4");
    expect(readCounter(store, "b", "A", "y")).toBe(0);

    // Two tabs of the same node share the store, so they never reuse a total.
    const fa = factory("A");
    const fb = factory("B");
    const opsA = [removalOp(fa, "m", bumpCounter(store, "b", "A", "m")), removalOp(fa, "m", bumpCounter(store, "b", "A", "m"))];
    const opsB = [removalOp(fb, "m", bumpCounter(store, "b", "B", "m"))];
    const merged = viewBoard(applyOps(createState("everglades"), [...opsB, ...opsA, ...opsA]));
    expect(merged.removals).toEqual({ m: 7 + 2 });
  });

  test("totals per species and overall over live missions only", () => {
    const missions = [
      toMission({ id: "1", fields: { title: "a", species: PYTHON, cell: "1:1" } })!,
      toMission({ id: "2", fields: { title: "b", species: TEGU, lon: -81, lat: 25.5 } })!,
      toMission({ id: "3", fields: { title: "c", species: PYTHON, lon: -81.2, lat: 25.1 } })!,
    ];
    const t = totals(missions, { "1": 4, "2": 2, "3": 1, ghost: 99 });
    expect(t.overall).toBe(7);
    expect(t.bySpecies[PYTHON]).toBe(5);
    expect(t.bySpecies[TEGU]).toBe(2);
    expect(t.bySpecies[SPECIES_IDS[2]]).toBe(0);
  });
});

describe("board model", () => {
  test("derives positions from lon/lat or the cell, drops unplaceable rows, orders missions newest first", () => {
    expect(toMission({ id: "x", fields: { title: "no place" } })).toBeNull();
    expect(toMission({ id: "x", fields: { cell: "5:7" } })).toMatchObject({ lon: -83.2 + 5.5 * 0.01, lat: 24.3 + 7.5 * 0.01, status: "planned", species: PYTHON, title: "x" });
    const f = factory();
    const first = createMissionOps(f, missionFieldsFromForm(form({ title: "first" }), "n"));
    f.t += 10;
    const second = createMissionOps(f, missionFieldsFromForm(form({ title: "second", cell: "3:3" }), "n"));
    const state = applyOps(createState("everglades"), [...first.ops, ...second.ops, removalOp(f, first.id, 4), messageOp(f, "hi")]);
    const model = boardModel(viewBoard(state));
    expect(model.missions.map((m) => m.title)).toEqual(["second", "first"]);
    expect(model.totals).toEqual({ overall: 4, bySpecies: { python: 4, tegu: 0, iguana: 0, lionfish: 0 } });
    expect(model.messages.map((m) => m.body)).toEqual(["hi"]);
    expect(model.notes).toEqual([]);
  });

  test("overlayOps: pending local ops over the worker's view read the same as the worker's view after them", () => {
    const f = factory();
    const store = memoryCounterStore();
    const keep = createMissionOps(f, missionFieldsFromForm(form({ title: "keep" }), "n"));
    f.t += 10;
    const gone = createMissionOps(f, missionFieldsFromForm(form({ title: "gone", cell: "3:3" }), "n"));
    const base = [...keep.ops, ...gone.ops, messageOp(f, "first"), removalOp(f, keep.id, bumpCounter(store, "everglades", "node-a", keep.id))];
    const committed = applyOps(createState("everglades"), base);
    f.t += 10;
    const fresh = createMissionOps(f, missionFieldsFromForm(form({ title: "fresh", cell: "9:9" }), "n"));
    const pending = [
      setStatusOp(f, keep.id, "in_progress"),
      messageOp(f, "second"),
      removalOp(f, keep.id, bumpCounter(store, "everglades", "node-a", keep.id)),
      removalOp(f, keep.id, bumpCounter(store, "everglades", "node-a", keep.id)),
      ...createNoteOps(f, keep.id, "a note"),
      deleteMissionOp(f, gone.id),
      ...fresh.ops,
    ];
    const optimistic = boardModel(overlayOps(viewBoard(committed), pending));
    const truth = boardModel(viewBoard(applyOps(committed, pending)));
    expect(optimistic).toEqual(truth);
    expect(optimistic.missions.map((m) => [m.title, m.status])).toEqual([
      ["fresh", "planned"],
      ["keep", "in_progress"],
    ]);
    expect(optimistic.removals[keep.id]).toBe(3);
    expect(optimistic.messages.map((m) => m.body)).toEqual(["first", "second"]);
    // Nothing pending: the worker's view as it is.
    const view = viewBoard(committed);
    expect(overlayOps(view, [])).toBe(view);
  });

  test("overlayOps with field notes (T43): create, edit, delete, and an edit after a delete stays deleted", () => {
    const f = factory();
    const note = (text: string, lat: number) =>
      createFieldNoteOps(f, { text, lat, lon: -80.9, createdBy: "node-a", callsign: "Ranger-A", createdAt: new Date(f.t).toISOString() });
    const kept = note("Boat ramp closed", 25.14);
    const doomed = note("Carcass on the levee", 25.45);
    const committed = applyOps(createState("everglades"), [...kept.ops, ...doomed.ops]);
    f.t += 10;
    const fresh = note("Tegu burrow by the canal", 25.3);
    const pending = [
      editFieldNoteOp(f, kept.id, "Boat ramp open again"),
      deleteFieldNoteOp(f, doomed.id),
      editFieldNoteOp(f, doomed.id, "edit that lands after the delete"),
      ...fresh.ops,
    ];
    const optimistic = boardModel(overlayOps(viewBoard(committed), pending));
    expect(optimistic).toEqual(boardModel(viewBoard(applyOps(committed, pending))));
    expect(optimistic.fieldNotes.map((n) => n.text).sort()).toEqual(["Boat ramp open again", "Tegu burrow by the canal"]);
  });
});
