import { get, set } from "active-state";
import { readPath, writePath } from "./path";
import { resolvePath, type Scope } from "./scope";

export type Command =
  | { verb: "toggle"; path: string }
  | { verb: "set"; path: string; payload: unknown }
  | { verb: "push"; path: string; payload: unknown }
  | { verb: "remove"; path: string }
  | { verb: "move"; path: string };

const VERBS = new Set(["toggle", "set", "push", "remove", "move"]);

/**
 * Parse `verb:path` or `verb:path:payload`.
 * Payload is JSON if it parses, otherwise a raw string / number.
 * No arbitrary JS — paths + JSON only.
 */
export function parseCommand(spec: string): Command {
  const trimmed = spec.trim();

  // move→path (arrow form, no colon)
  const arrow = trimmed.match(/^(move)(?:→|>)(.+)$/);
  if (arrow) {
    const path = arrow[2]!.trim();
    if (!path) {
      throw new Error(`[active-state] move requires a destination path.`);
    }
    return { verb: "move", path };
  }

  const first = trimmed.indexOf(":");
  if (first === -1) {
    throw new Error(
      `[active-state] Invalid command "${spec}". Use verb:path (e.g. toggle:LAYOUT.nav).`,
    );
  }
  const verb = trimmed.slice(0, first);
  let rest = trimmed.slice(first + 1);
  if (!VERBS.has(verb)) {
    throw new Error(
      `[active-state] Unknown verb "${verb}". Use toggle|set|push|remove|move.`,
    );
  }

  if (verb === "toggle" || verb === "remove") {
    if (!rest) throw new Error(`[active-state] ${verb} requires a path.`);
    return { verb, path: rest };
  }

  if (verb === "move") {
    rest = rest.replace(/^\u2192/, "").replace(/^→/, "").replace(/^>/, "");
    if (!rest) {
      throw new Error(`[active-state] move requires a destination path.`);
    }
    return { verb: "move", path: rest };
  }

  const second = rest.indexOf(":");
  if (second === -1) {
    if (verb === "push") {
      return { verb: "push", path: rest, payload: undefined };
    }
    throw new Error(`[active-state] set requires verb:path:value.`);
  }
  const path = rest.slice(0, second);
  const raw = rest.slice(second + 1);
  return { verb: verb as "set" | "push", path, payload: parsePayload(raw) };
}

function parsePayload(raw: string): unknown {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t !== "" && !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export function runCommand(
  command: Command,
  scope: Scope,
  extras?: { dragId?: string; formRecord?: Record<string, string> },
): void {
  const resolved = resolvePath(command.path, scope);

  if (command.verb === "toggle") {
    set(resolved.key, (prev) => {
      if (resolved.fields.length === 0) return !prev;
      const current = readPath(prev, resolved.fields);
      return writePath(prev, resolved.fields, !current);
    });
    return;
  }

  if (command.verb === "set") {
    set(resolved.key, (prev) =>
      resolved.fields.length === 0
        ? command.payload
        : writePath(prev, resolved.fields, command.payload),
    );
    return;
  }

  if (command.verb === "push") {
    const item =
      command.payload !== undefined
        ? command.payload
        : (extras?.formRecord ?? {});
    set(resolved.key, (prev) => {
      const arr = (
        resolved.fields.length === 0 ? prev : readPath(prev, resolved.fields)
      ) as unknown;
      const list = Array.isArray(arr) ? arr.slice() : [];
      list.push(item);
      return resolved.fields.length === 0
        ? list
        : writePath(prev, resolved.fields, list);
    });
    return;
  }

  if (command.verb === "remove") {
    set(resolved.key, (prev) => {
      if (resolved.fields.length === 0) return undefined;
      const parentFields = resolved.fields.slice(0, -1);
      const last = resolved.fields[resolved.fields.length - 1]!;
      const parent = parentFields.length ? readPath(prev, parentFields) : prev;
      if (Array.isArray(parent)) {
        const next = parent.slice();
        const idx = Number(last);
        if (!Number.isNaN(idx)) next.splice(idx, 1);
        return parentFields.length ? writePath(prev, parentFields, next) : next;
      }
      if (parent != null && typeof parent === "object") {
        const next = { ...(parent as Record<string, unknown>) };
        delete next[last];
        return parentFields.length ? writePath(prev, parentFields, next) : next;
      }
      return prev;
    });
    return;
  }

  if (command.verb === "move") {
    const id = extras?.dragId;
    if (id == null || id === "") return;
    set(resolved.key, (prev) =>
      moveIdToArray(prev, String(id), resolved.fields),
    );
  }
}

/**
 * Find `{ id }` anywhere under value, remove it, push onto array at fields.
 * Uses structural sharing so untouched siblings keep the same references
 * (lets `active-each` skip remounting unchanged columns/cards).
 */
export function moveIdToArray(
  value: unknown,
  id: string,
  destFields: string[],
): unknown {
  const removed = removeByIdShared(value, id);
  if (removed.found == null) return value;

  if (destFields.length === 0) {
    const list = Array.isArray(removed.next) ? removed.next.slice() : [];
    list.push(removed.found);
    return list;
  }

  const arr = readPath(removed.next, destFields);
  const list = Array.isArray(arr) ? arr.slice() : [];
  list.push(removed.found);
  return writePath(removed.next, destFields, list);
}

function removeByIdShared(
  node: unknown,
  id: string,
): { next: unknown; found: unknown | null } {
  if (Array.isArray(node)) {
    const idx = node.findIndex(
      (item) =>
        item != null &&
        typeof item === "object" &&
        (item as { id?: unknown }).id === id,
    );
    if (idx !== -1) {
      const found = node[idx];
      return {
        found,
        next: [...node.slice(0, idx), ...node.slice(idx + 1)],
      };
    }

    let found: unknown | null = null;
    let changed = false;
    const next = node.map((item) => {
      if (found != null) return item;
      const nested = removeByIdShared(item, id);
      if (nested.found != null) {
        found = nested.found;
        changed = true;
        return nested.next;
      }
      return item;
    });
    return { next: changed ? next : node, found };
  }

  if (node != null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const nested = removeByIdShared(obj[key], id);
      if (nested.found != null) {
        return {
          found: nested.found,
          next: { ...obj, [key]: nested.next },
        };
      }
    }
  }

  return { next: node, found: null };
}

/** @internal */
export function readAt(scope: Scope, path: string): unknown {
  const { key, fields } = resolvePath(path, scope);
  const value = get(key);
  return fields.length ? readPath(value, fields) : value;
}
