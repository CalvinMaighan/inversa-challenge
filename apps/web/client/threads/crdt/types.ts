// Team op wire shape (PLAN.md C5). Mirrors api/src/crdt.rs; held to spec/crdt/*.json.

export const ENTITIES = ["mission", "note", "message", "removal"] as const;
export type Entity = (typeof ENTITIES)[number];

export interface Op {
  /** uuidv7 */
  id: string;
  /** "<wallMs>:<counter>:<nodeId>" */
  hlc: string;
  boardId: string;
  entity: Entity;
  entityId: string;
  /** Mission/note register name; "body" for messages; "_deleted" for tombstones. */
  field: string;
  /** JSON. A string for messages, a non-negative integer for removals, a boolean for _deleted. */
  value: unknown;
  nodeId: string;
}

/** Persisted op as the API returns it (GraphQL `Op`). */
export interface StoredOp extends Op {
  seq: number;
}

/** Largest serialized `value`, in UTF-8 bytes. */
export const MAX_VALUE_BYTES = 16 * 1024;
export const MAX_ID_BYTES = 256;
export const DELETED_FIELD = "_deleted";

export function isEntity(x: unknown): x is Entity {
  return typeof x === "string" && (ENTITIES as readonly string[]).includes(x);
}
