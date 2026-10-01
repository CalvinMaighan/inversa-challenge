import { describe, expect, test } from "bun:test";

import { SPECIES_IDS } from "shared/voice/ui-tools";

import { parseHotspotId } from "client/hud/drawer/evidence";
import {
  boardModel,
  bumpCounter,
  counterKey,
  createMissionOps,
  createNoteOps,
  deleteMissionOp,
  formFromHotspot,
  MAX_TITLE_CHARS,
  memoryCounterStore,
  messageOp,
  overlayOps,
  MISSION_WINDOW_MS,
  missionFieldsFromForm,
  readCounter,
  removalOp,
  setStatusOp,
  toMission,
  totals,
  uuidv7,
  validateMissionForm,
  type MissionForm,
  type OpFactory,
} from "client/hud/missions/board";
import { Clock, parse } from "client/threads/crdt/hlc";
import { applyOps, createState, viewBoard } from "client/threads/crdt/merge";
import { validateOp } from "client/threads/crdt/merge";
import type { Op } from "client/threads/crdt/types";

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
});
