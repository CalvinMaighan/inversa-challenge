// In-memory R2 stand-in with the runtime's conditional-write semantics:
// - put with a failing onlyIf resolves to null and leaves the object untouched;
// - etagMatches on a missing object fails, etagDoesNotMatch "*" fails on an existing one;
// - every call yields to the event loop first, so concurrent requests interleave the way
//   they do against the real bucket, and the check-and-set itself is atomic.

import type { R2Bucket, R2Conditional, R2ListOptions, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from "../src/r2";

interface Stored {
  value: string;
  etag: string;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function matches(condition: string, etag: string): boolean {
  return condition
    .split(",")
    .map((c) => c.trim().replace(/^W\//, "").replace(/^"|"$/g, ""))
    .some((c) => c === "*" || c === etag);
}

function passes(cond: R2Conditional | undefined, existing: Stored | undefined): boolean {
  if (!cond) return true;
  if (cond.etagMatches !== undefined && (!existing || !matches(cond.etagMatches, existing.etag))) return false;
  if (cond.etagDoesNotMatch !== undefined && existing && matches(cond.etagDoesNotMatch, existing.etag)) return false;
  return true;
}

export class MemR2 implements R2Bucket {
  readonly objects = new Map<string, Stored>();
  readonly calls = { get: 0, put: 0, putRejected: 0, list: 0, delete: 0 };
  private version = 0;

  async get(key: string): Promise<R2ObjectBody | null> {
    this.calls.get++;
    await tick();
    const obj = this.objects.get(key);
    if (!obj) return null;
    const { value, etag } = obj;
    return { key, etag, text: async () => value };
  }

  async put(key: string, value: string, options?: R2PutOptions): Promise<R2Object | null> {
    this.calls.put++;
    await tick();
    if (!passes(options?.onlyIf, this.objects.get(key))) {
      this.calls.putRejected++;
      return null;
    }
    const etag = (++this.version).toString(16).padStart(32, "0");
    this.objects.set(key, { value, etag });
    return { key, etag };
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    this.calls.list++;
    await tick();
    const prefix = options.prefix ?? "";
    const limit = Math.min(options.limit ?? 1000, 1000);
    const start = options.cursor ? Number(options.cursor) : 0;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((key) => ({ key, etag: this.objects.get(key)!.etag })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    this.calls.delete++;
    await tick();
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}
