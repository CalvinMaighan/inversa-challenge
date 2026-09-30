/**
 * Pure board logic for the Missions panel (PRD §3 flow 4, PLAN.md C5): op builders over the HLC clock,
 * mission form validation, removal counters and totals. No DOM, no workers; `tests/client/hud/missions`
 * runs it under bun.
 */
import { SPECIES_IDS } from "shared/voice/ui-tools";

import { cellCenter, type HotspotRef } from "client/hud/drawer/evidence";
import { type Clock, format } from "client/threads/crdt/hlc";
import type { BoardView, EntityView, MessageView } from "client/threads/crdt/merge";
import { DELETED_FIELD, type Op } from "client/threads/crdt/types";

export const MISSION_STATUSES = ["planned", "in_progress", "done"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];
export type Species = (typeof SPECIES_IDS)[number];

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 2_000;
/** A mission planned from a hotspot frame covers the day that follows it. */
export const MISSION_WINDOW_MS = 24 * 60 * 60_000;

export type MissionFields = {
  title: string;
  species: Species;
  cell: string | null;
  lon: number;
  lat: number;
  window: { from: string; to: string };
  status: MissionStatus;
  createdBy: string;
};

export type Mission = { id: string } & MissionFields;

export type Note = { id: string; missionId: string; body: string; createdBy: string; at: string };

export type MissionForm = { title: string; species: string; cell: string; at: string };

export type FormErrors = Partial<Record<keyof MissionForm, string>>;

const CELL_RE = /^(\d{1,3}):(\d{1,3})$/;

export function isMissionStatus(v: unknown): v is MissionStatus {
  return typeof v === "string" && (MISSION_STATUSES as readonly string[]).includes(v);
}

export function isSpecies(v: unknown): v is Species {
  return typeof v === "string" && (SPECIES_IDS as readonly string[]).includes(v);
}

/** uuidv7: 48-bit unix ms, version nibble, 74 random bits. Sorts by creation time, like the server's. */
export function uuidv7(nowMs: number = Date.now(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = new Uint8Array(16);
  const ms = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b.set(random(10), 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- form ---------------------------------------------------------------------------------------------

/** Prefill from a `hotspot:` selection (PLAN.md C14): species, cell and the frame time. */
export function formFromHotspot(ref: HotspotRef): MissionForm {
  return { title: `${ref.species} sweep · cell ${ref.cell}`, species: ref.species, cell: ref.cell, at: ref.at };
}

export function validateMissionForm(form: MissionForm): FormErrors {
  const errors: FormErrors = {};
  const title = form.title.trim();
  if (!title) errors.title = "Title is required";
  else if (title.length > MAX_TITLE_CHARS) errors.title = `Title must be ${MAX_TITLE_CHARS} characters or fewer`;
  if (!isSpecies(form.species)) errors.species = "Pick a species";
  if (!CELL_RE.test(form.cell.trim())) errors.cell = "Cell must be <col>:<row> on the 0.01° grid";
  if (!Number.isFinite(Date.parse(form.at))) errors.at = "Frame time must be a date";
  return errors;
}

export function missionFieldsFromForm(form: MissionForm, createdBy: string): MissionFields {
  const errors = validateMissionForm(form);
  const firstError = Object.values(errors)[0];
  if (firstError) throw new Error(firstError);
  const m = CELL_RE.exec(form.cell.trim())!;
  const { lon, lat } = cellCenter(Number(m[1]), Number(m[2]));
  const fromMs = Date.parse(form.at);
  return {
    title: form.title.trim(),
    species: form.species as Species,
    cell: form.cell.trim(),
    lon,
    lat,
    window: { from: new Date(fromMs).toISOString(), to: new Date(fromMs + MISSION_WINDOW_MS).toISOString() },
    status: "planned",
    createdBy,
  };
}

// ---- ops ----------------------------------------------------------------------------------------------

export type OpFactory = { clock: Clock; boardId: string; nodeId: string; now?: () => number };

function stamp(f: OpFactory, entity: Op["entity"], entityId: string, field: string, value: unknown): Op {
  const now = f.now ?? (() => Date.now());
  return { id: uuidv7(now()), hlc: format(f.clock.tick(now())), boardId: f.boardId, entity, entityId, field, value, nodeId: f.nodeId };
}

/** One LWW register op per field; the mission id is a fresh uuidv7. */
export function createMissionOps(f: OpFactory, fields: MissionFields, id: string = uuidv7((f.now ?? Date.now)())): { id: string; ops: Op[] } {
  const ops = (Object.keys(fields) as (keyof MissionFields)[]).map((field) => stamp(f, "mission", id, field, fields[field]));
  return { id, ops };
}

export function setStatusOp(f: OpFactory, missionId: string, status: MissionStatus): Op {
  return stamp(f, "mission", missionId, "status", status);
}

export function deleteMissionOp(f: OpFactory, missionId: string): Op {
  return stamp(f, "mission", missionId, DELETED_FIELD, true);
}

export function messageOp(f: OpFactory, body: string): Op {
  return stamp(f, "message", uuidv7((f.now ?? Date.now)()), "body", body);
}

export function createNoteOps(f: OpFactory, missionId: string, body: string): Op[] {
  const id = uuidv7((f.now ?? Date.now)());
  const at = new Date((f.now ?? Date.now)()).toISOString();
  return [stamp(f, "note", id, "missionId", missionId), stamp(f, "note", id, "body", body), stamp(f, "note", id, "createdBy", f.nodeId), stamp(f, "note", id, "at", at)];
}

/** Grow-only counter: `value` is this node's running total for the mission (PLAN.md C5). */
export function removalOp(f: OpFactory, missionId: string, runningTotal: number): Op {
  return stamp(f, "removal", missionId, "count", runningTotal);
}

// ---- removal counters (this node's running totals) ---------------------------------------------------

export type CounterStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export const counterKey = (boardId: string, nodeId: string, missionId: string) => `inversa:removals:${boardId}:${nodeId}:${missionId}`;

/** This node's running total for a mission, read from its own persistent counter. */
export function readCounter(store: CounterStore, boardId: string, nodeId: string, missionId: string): number {
  const raw = store.getItem(counterKey(boardId, nodeId, missionId));
  const n = raw === null ? 0 : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Bump this node's total by `by` and persist it; returns the new running total to put in the op. A
 * read-modify-write on the store keeps two tabs of the same node from reusing a total.
 */
export function bumpCounter(store: CounterStore, boardId: string, nodeId: string, missionId: string, by = 1): number {
  const next = readCounter(store, boardId, nodeId, missionId) + Math.max(0, Math.floor(by));
  store.setItem(counterKey(boardId, nodeId, missionId), String(next));
  return next;
}

export function memoryCounterStore(): CounterStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

// ---- views --------------------------------------------------------------------------------------------

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A mission row from its merged registers; null when it lacks a position (PLAN.md C16: `lon`/`lat` or `cell`). */
export function toMission(e: EntityView): Mission | null {
  const f = e.fields;
  let lon = num(f.lon);
  let lat = num(f.lat);
  const cell = typeof f.cell === "string" && CELL_RE.test(f.cell) ? f.cell : null;
  if ((lon === null || lat === null) && cell) {
    const m = CELL_RE.exec(cell)!;
    ({ lon, lat } = cellCenter(Number(m[1]), Number(m[2])));
  }
  if (lon === null || lat === null) return null;
  const w = (f.window ?? {}) as { from?: unknown; to?: unknown };
  return {
    id: e.id,
    title: str(f.title, e.id),
    species: isSpecies(f.species) ? f.species : SPECIES_IDS[0],
    cell,
    lon,
    lat,
    window: { from: str(w.from), to: str(w.to) },
    status: isMissionStatus(f.status) ? f.status : "planned",
    createdBy: str(f.createdBy),
  };
}

export function toNote(e: EntityView): Note | null {
  const f = e.fields;
  if (typeof f.missionId !== "string" || typeof f.body !== "string") return null;
  return { id: e.id, missionId: f.missionId, body: f.body, createdBy: str(f.createdBy), at: str(f.at) };
}

export type Totals = { overall: number; bySpecies: Record<Species, number> };

/** Merged removal totals per species and overall, over live missions. */
export function totals(missions: readonly Mission[], removals: Readonly<Record<string, number>>): Totals {
  const bySpecies = Object.fromEntries(SPECIES_IDS.map((s) => [s, 0])) as Record<Species, number>;
  let overall = 0;
  for (const m of missions) {
    const n = removals[m.id] ?? 0;
    bySpecies[m.species] += n;
    overall += n;
  }
  return { overall, bySpecies };
}

export type BoardModel = { missions: Mission[]; notes: Note[]; messages: MessageView[]; removals: Record<string, number>; totals: Totals };

/** Everything the panel renders, derived once per board change. Missions newest first (uuidv7 sorts by time). */
export function boardModel(view: BoardView): BoardModel {
  const missions = view.missions.map(toMission).filter((m): m is Mission => m !== null).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const notes = view.notes.map(toNote).filter((n): n is Note => n !== null);
  return { missions, notes, messages: view.messages, removals: view.removals, totals: totals(missions, view.removals) };
}
