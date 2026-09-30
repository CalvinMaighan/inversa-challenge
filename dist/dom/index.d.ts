/**
 * Path + verb DOM bindings (no expression JS, no components).
 *
 * | Attr | Role |
 * | --- | --- |
 * | `active-text` | textContent ← path |
 * | `active-show` | display ← truthy path |
 * | `active-model` | two-way input/checkbox/select |
 * | `active-click` | `toggle:path` / `set:path:value` / … |
 * | `active-toggle` | shorthand for `toggle:path` |
 * | `active-submit` | form → `push:path` (FormData as object) |
 * | `active-each` + `active-as` | `<template>` list |
 * | `active-drag` | drag payload ← path (e.g. `card.id`) |
 * | `active-drop` | `move→arrayPath` on drop |
 */
declare function bind(root?: ParentNode): () => void;

/** One `active-each` alias binding, e.g. col → BOARD.columns.0 */
type ScopeFrame = {
    name: string;
    key: string;
    fields: string[];
};
type Scope = ScopeFrame[];
/**
 * Resolve `KEY.field` or relative `alias.field` against the each-scope stack.
 * Innermost alias wins.
 */
declare function resolvePath(spec: string, scope?: Scope): {
    key: string;
    fields: string[];
};

type Command = {
    verb: "toggle";
    path: string;
} | {
    verb: "set";
    path: string;
    payload: unknown;
} | {
    verb: "push";
    path: string;
    payload: unknown;
} | {
    verb: "remove";
    path: string;
} | {
    verb: "move";
    path: string;
};
/**
 * Parse `verb:path` or `verb:path:payload`.
 * Payload is JSON if it parses, otherwise a raw string / number.
 * No arbitrary JS — paths + JSON only.
 */
declare function parseCommand(spec: string): Command;
declare function runCommand(command: Command, scope: Scope, extras?: {
    dragId?: string;
    formRecord?: Record<string, string>;
}): void;
/**
 * Find `{ id }` anywhere under value, remove it, push onto array at fields.
 * Uses structural sharing so untouched siblings keep the same references
 * (lets `active-each` skip remounting unchanged columns/cards).
 */
declare function moveIdToArray(value: unknown, id: string, destFields: string[]): unknown;

declare function parsePath(spec: string): {
    key: string;
    fields: string[];
};
declare function readPath(value: unknown, fields: string[]): unknown;
/** Immutable set at a dotted path (object keys or array indexes). */
declare function writePath(value: unknown, fields: string[], nextFieldValue: unknown): unknown;

export { type Scope, type ScopeFrame, bind, moveIdToArray, parseCommand, parsePath, readPath, resolvePath, runCommand, writePath };
