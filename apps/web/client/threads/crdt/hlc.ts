// Hybrid logical clock (PLAN.md C5). Format "<wallMs>:<counter>:<nodeId>"; ordering is
// wallMs, then counter, then nodeId compared as strings. Same rules as api/src/crdt.rs.

export interface Hlc {
  wallMs: number;
  counter: number;
  nodeId: string;
}

/** A remote or logical clock this far ahead of the local wall clock is refused. */
export const MAX_DRIFT_MS = 60_000;

export class HlcDriftError extends Error {
  constructor(public readonly aheadMs: number) {
    super(`HLC drift ${aheadMs} ms exceeds ${MAX_DRIFT_MS} ms`);
    this.name = "HlcDriftError";
  }
}

const DIGITS = /^\d{1,15}$/;

/** Parse an HLC string; null when malformed. nodeId may itself contain ":". */
export function parse(s: string): Hlc | null {
  const first = s.indexOf(":");
  if (first < 0) return null;
  const second = s.indexOf(":", first + 1);
  if (second < 0) return null;
  const wall = s.slice(0, first);
  const counter = s.slice(first + 1, second);
  const nodeId = s.slice(second + 1);
  if (!DIGITS.test(wall) || !DIGITS.test(counter) || nodeId.length === 0) return null;
  return { wallMs: Number(wall), counter: Number(counter), nodeId };
}

export function format(h: Hlc): string {
  return `${h.wallMs}:${h.counter}:${h.nodeId}`;
}

function toHlc(x: Hlc | string): Hlc {
  if (typeof x !== "string") return x;
  const h = parse(x);
  if (!h) throw new Error(`bad hlc ${JSON.stringify(x)}`);
  return h;
}

/** Total order: negative when a < b. Accepts parsed or string form. */
export function compare(a: Hlc | string, b: Hlc | string): number {
  const x = toHlc(a);
  const y = toHlc(b);
  if (x.wallMs !== y.wallMs) return x.wallMs < y.wallMs ? -1 : 1;
  if (x.counter !== y.counter) return x.counter < y.counter ? -1 : 1;
  return x.nodeId < y.nodeId ? -1 : x.nodeId > y.nodeId ? 1 : 0;
}

/**
 * One node's clock. `tick` stamps a local event; `receive` folds in a remote stamp so the next
 * local stamp sorts after it. Both refuse to run the logical clock more than MAX_DRIFT_MS
 * ahead of the physical one.
 */
export class Clock {
  private last: Hlc;

  constructor(public readonly nodeId: string, start: Hlc | string | null = null) {
    if (nodeId.length === 0) throw new Error("nodeId must be non-empty");
    this.last = start ? toHlc(start) : { wallMs: 0, counter: 0, nodeId };
  }

  /** Last stamp issued or received. */
  get current(): Hlc {
    return this.last;
  }

  tick(now: number = Date.now()): Hlc {
    const wallMs = Math.max(now, this.last.wallMs);
    guard(wallMs, now);
    const counter = wallMs === this.last.wallMs ? this.last.counter + 1 : 0;
    this.last = { wallMs, counter, nodeId: this.nodeId };
    return this.last;
  }

  receive(remote: Hlc | string, now: number = Date.now()): Hlc {
    const r = toHlc(remote);
    const wallMs = Math.max(now, this.last.wallMs, r.wallMs);
    guard(wallMs, now);
    let counter: number;
    if (wallMs === this.last.wallMs && wallMs === r.wallMs) counter = Math.max(this.last.counter, r.counter) + 1;
    else if (wallMs === this.last.wallMs) counter = this.last.counter + 1;
    else if (wallMs === r.wallMs) counter = r.counter + 1;
    else counter = 0;
    this.last = { wallMs, counter, nodeId: this.nodeId };
    return this.last;
  }
}

function guard(wallMs: number, now: number): void {
  const ahead = wallMs - now;
  if (ahead > MAX_DRIFT_MS) throw new HlcDriftError(ahead);
}

/** Functional entry points over a shared clock, for callers that prefer not to hold the class. */
export function tick(clock: Clock, now?: number): string {
  return format(clock.tick(now));
}

export function receive(clock: Clock, remote: Hlc | string, now?: number): string {
  return format(clock.receive(remote, now));
}
