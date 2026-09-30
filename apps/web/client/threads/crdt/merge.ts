// Pure merge over an in-memory board (PLAN.md C5). The rule functions below are the whole
// CRDT; `applyOps` and `viewBoard` only route rows through them, so the db worker (T19) can run
// the same rules against sqlite-wasm rows. Held to spec/crdt/*.json with api/src/crdt.rs.
//
// Rules:
// - Mission and note: last-writer-wins by HLC per (entity, entityId, field). `_deleted` is a
//   register like any other, so a later `_deleted=false` undeletes. Writes after a delete are
//   stored but the entity reads as deleted while `_deleted` is true.
// - Message: defined by its lowest-HLC op (its creation); any later op for the same id is ignored.
// - Removal: grow-only counter; `value` is the node's running total; merged total is the
//   per-node max summed over nodes.
// - Apply is idempotent on op id.

import { compare, parse } from "./hlc";
import { DELETED_FIELD, isEntity, MAX_ID_BYTES, MAX_VALUE_BYTES, type Op } from "./types";

export interface FieldRegister {
  value: unknown;
  hlc: string;
}

export interface MessageRow {
  body: string;
  hlc: string;
  nodeId: string;
}

export interface BoardState {
  readonly boardId: string;
  /** fieldKey(entity, entityId, field) -> register */
  readonly fields: ReadonlyMap<string, FieldRegister>;
  /** message id -> row */
  readonly messages: ReadonlyMap<string, MessageRow>;
  /** entityId -> nodeId -> running total */
  readonly removals: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** op ids already applied */
  readonly seen: ReadonlySet<string>;
}

export interface EntityView {
  id: string;
  fields: Record<string, unknown>;
}

export interface MessageView {
  id: string;
  body: string;
  hlc: string;
  nodeId: string;
}

export interface BoardView {
  missions: EntityView[];
  notes: EntityView[];
  messages: MessageView[];
  removals: Record<string, number>;
}

export class InvalidOpError extends Error {
  constructor(public readonly opId: string, reason: string) {
    super(`invalid op ${opId}: ${reason}`);
    this.name = "InvalidOpError";
  }
}

const SEP = "\u0001";

export function createState(boardId: string): BoardState {
  return { boardId, fields: new Map(), messages: new Map(), removals: new Map(), seen: new Set() };
}

export function fieldKey(entity: string, entityId: string, field: string): string {
  return `${entity}${SEP}${entityId}${SEP}${field}`;
}

export function splitFieldKey(key: string): [entity: string, entityId: string, field: string] {
  const a = key.indexOf(SEP);
  const b = key.indexOf(SEP, a + 1);
  return [key.slice(0, a), key.slice(a + 1, b), key.slice(b + 1)];
}

// ---- rules -------------------------------------------------------------------------------

/** LWW register: the incoming write wins only when strictly newer. */
export function registerWins(existingHlc: string | undefined, incomingHlc: string): boolean {
  return existingHlc === undefined || compare(incomingHlc, existingHlc) > 0;
}

/** Message: the lowest-HLC op defines it; an incoming op wins only when strictly older. */
export function messageWins(existingHlc: string | undefined, incomingHlc: string): boolean {
  return existingHlc === undefined || compare(incomingHlc, existingHlc) < 0;
}

/** Grow-only counter, per node. */
export function mergeCounter(existing: number | undefined, incoming: number): number {
  return existing === undefined ? incoming : Math.max(existing, incoming);
}

/** Entity reads as deleted while its `_deleted` register is true. */
export function isDeleted(fields: Record<string, unknown>): boolean {
  return fields[DELETED_FIELD] === true;
}

export function orderMessages<T extends { hlc: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => compare(a.hlc, b.hlc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- validation --------------------------------------------------------------------------

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Reason the op is invalid for this board, or null when it is fine. */
export function validateOp(op: Op, boardId: string): string | null {
  if (typeof op.id !== "string" || op.id.length === 0 || byteLength(op.id) > MAX_ID_BYTES) return "id must be 1..=256 bytes";
  if (op.boardId !== undefined && op.boardId !== boardId) return `boardId ${JSON.stringify(op.boardId)} does not match board ${JSON.stringify(boardId)}`;
  if (!isEntity(op.entity)) return `unknown entity ${JSON.stringify(op.entity)}`;
  if (typeof op.entityId !== "string" || op.entityId.length === 0 || byteLength(op.entityId) > MAX_ID_BYTES) return "entityId must be 1..=256 bytes";
  if (typeof op.field !== "string" || op.field.length === 0) return "field must be non-empty";
  if (typeof op.hlc !== "string" || !parse(op.hlc)) return `bad hlc ${JSON.stringify(op.hlc)}`;
  if (typeof op.nodeId !== "string" || op.nodeId.length === 0) return "nodeId must be non-empty";
  let json: string | undefined;
  try {
    json = JSON.stringify(op.value === undefined ? null : op.value);
  } catch {
    json = undefined;
  }
  if (json === undefined) return "unserializable value";
  const size = byteLength(json);
  if (size > MAX_VALUE_BYTES) return `value is ${size} bytes, max ${MAX_VALUE_BYTES}`;
  switch (op.entity) {
    case "mission":
    case "note":
      if (op.field === DELETED_FIELD && typeof op.value !== "boolean") return "_deleted must be a boolean";
      return null;
    case "message":
      if (op.field !== "body") return 'message field must be "body"';
      if (typeof op.value !== "string") return "message body must be a string";
      return null;
    case "removal":
      if (!Number.isSafeInteger(op.value) || (op.value as number) < 0) return "removal value must be a non-negative integer";
      return null;
  }
}

// ---- apply -------------------------------------------------------------------------------

/**
 * Apply a batch to a board. Pure: returns a new state, never mutates the input. The whole batch
 * is rejected (throws InvalidOpError) when any op is invalid. Ops already seen are skipped.
 */
export function applyOps(state: BoardState, ops: readonly Op[]): BoardState {
  for (const op of ops) {
    const reason = validateOp(op, state.boardId);
    if (reason) throw new InvalidOpError(String(op.id), reason);
  }
  const fields = new Map(state.fields);
  const messages = new Map(state.messages);
  const removals = new Map(state.removals);
  const seen = new Set(state.seen);
  for (const op of ops) {
    if (seen.has(op.id)) continue;
    seen.add(op.id);
    switch (op.entity) {
      case "mission":
      case "note": {
        const key = fieldKey(op.entity, op.entityId, op.field);
        if (registerWins(fields.get(key)?.hlc, op.hlc)) fields.set(key, { value: op.value === undefined ? null : op.value, hlc: op.hlc });
        break;
      }
      case "message": {
        if (messageWins(messages.get(op.entityId)?.hlc, op.hlc)) messages.set(op.entityId, { body: op.value as string, hlc: op.hlc, nodeId: op.nodeId });
        break;
      }
      case "removal": {
        const perNode = new Map(removals.get(op.entityId));
        perNode.set(op.nodeId, mergeCounter(perNode.get(op.nodeId), op.value as number));
        removals.set(op.entityId, perNode);
        break;
      }
    }
  }
  return { boardId: state.boardId, fields, messages, removals, seen };
}

// ---- views -------------------------------------------------------------------------------

function sortedKeys<T>(m: ReadonlyMap<string, T>): string[] {
  return [...m.keys()].sort();
}

/** Live (non-deleted) missions and notes, messages by HLC, removal totals. Ids sorted. */
export function viewBoard(state: BoardState): BoardView {
  const byEntity: Record<"mission" | "note", Map<string, Record<string, unknown>>> = { mission: new Map(), note: new Map() };
  for (const key of sortedKeys(state.fields)) {
    const [entity, entityId, field] = splitFieldKey(key);
    if (entity !== "mission" && entity !== "note") continue;
    const bucket = byEntity[entity];
    const obj = bucket.get(entityId) ?? {};
    obj[field] = state.fields.get(key)!.value;
    bucket.set(entityId, obj);
  }
  const live = (bucket: Map<string, Record<string, unknown>>): EntityView[] =>
    sortedKeys(bucket)
      .filter((id) => !isDeleted(bucket.get(id)!))
      .map((id) => {
        const fields = { ...bucket.get(id)! };
        delete fields[DELETED_FIELD];
        return { id, fields };
      });
  const messages = orderMessages([...state.messages].map(([id, m]) => ({ id, ...m })));
  const removals: Record<string, number> = {};
  for (const id of sortedKeys(state.removals)) {
    let total = 0;
    for (const n of state.removals.get(id)!.values()) total += n;
    removals[id] = total;
  }
  return { missions: live(byEntity.mission), notes: live(byEntity.note), messages, removals };
}

/** Order-independent dump of the whole state (deleted rows included), for convergence checks. */
export function canonical(state: BoardState): string {
  const fields = sortedKeys(state.fields).map((k) => [...splitFieldKey(k), state.fields.get(k)!.hlc, JSON.stringify(state.fields.get(k)!.value)]);
  const messages = sortedKeys(state.messages).map((id) => [id, state.messages.get(id)!.hlc, state.messages.get(id)!.body, state.messages.get(id)!.nodeId]);
  const removals = sortedKeys(state.removals).map((id) => [id, sortedKeys(state.removals.get(id)!).map((n) => [n, state.removals.get(id)!.get(n)!])]);
  return JSON.stringify({ boardId: state.boardId, fields, messages, removals, seen: [...state.seen].sort() });
}
