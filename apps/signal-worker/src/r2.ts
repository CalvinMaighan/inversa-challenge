// The subset of the Workers R2Bucket binding this worker uses. Declared here instead of
// pulling in @cloudflare/workers-types, whose ambient globals clash with bun's in tests.
// Semantics follow the runtime: a put whose onlyIf fails resolves to null, get of a
// missing key resolves to null, and etag is the unquoted form accepted by onlyIf.

export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

export interface R2PutOptions {
  onlyIf?: R2Conditional;
  httpMetadata?: { contentType?: string };
}

export interface R2Object {
  key: string;
  etag: string;
}

export interface R2ObjectBody extends R2Object {
  text(): Promise<string>;
}

export interface R2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string, options?: R2PutOptions): Promise<R2Object | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  delete(keys: string | string[]): Promise<void>;
}
