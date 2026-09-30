import { parsePath } from "./path";

/** One `active-each` alias binding, e.g. col → BOARD.columns.0 */
export type ScopeFrame = {
  name: string;
  key: string;
  fields: string[];
};

export type Scope = ScopeFrame[];

/**
 * Resolve `KEY.field` or relative `alias.field` against the each-scope stack.
 * Innermost alias wins.
 */
export function resolvePath(
  spec: string,
  scope: Scope = [],
): { key: string; fields: string[] } {
  const parts = spec.split(".").filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`[active-state] Invalid path "${spec}".`);
  }

  const head = parts[0]!;
  for (let i = scope.length - 1; i >= 0; i--) {
    const frame = scope[i]!;
    if (frame.name === head) {
      return {
        key: frame.key,
        fields: [...frame.fields, ...parts.slice(1)],
      };
    }
  }

  return parsePath(spec);
}
