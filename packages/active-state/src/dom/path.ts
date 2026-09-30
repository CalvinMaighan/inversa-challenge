export function parsePath(spec: string): { key: string; fields: string[] } {
  const [key, ...fields] = spec.split(".").filter(Boolean);
  if (!key) {
    throw new Error(`[active-state] Invalid path "${spec}".`);
  }
  return { key, fields };
}

export function readPath(value: unknown, fields: string[]): unknown {
  let current: unknown = value;
  for (const field of fields) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[field];
  }
  return current;
}

function isIndex(field: string): boolean {
  return /^\d+$/.test(field);
}

/** Immutable set at a dotted path (object keys or array indexes). */
export function writePath(
  value: unknown,
  fields: string[],
  nextFieldValue: unknown,
): unknown {
  if (fields.length === 0) return nextFieldValue;

  const [head, ...rest] = fields;
  if (head == null) return nextFieldValue;

  if (isIndex(head) || Array.isArray(value)) {
    const list = Array.isArray(value) ? value.slice() : [];
    const idx = Number(head);
    list[idx] =
      rest.length === 0
        ? nextFieldValue
        : writePath(list[idx], rest, nextFieldValue);
    return list;
  }

  const base =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};

  base[head] =
    rest.length === 0
      ? nextFieldValue
      : writePath(base[head], rest, nextFieldValue);
  return base;
}
