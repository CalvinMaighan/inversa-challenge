/**
 * Live text streams (PLAN.md C-A7, M1): the delta algebra behind `dm.delta` and `note.delta`, the sender that
 * turns keystrokes into at most one delta per frame, the receiver that applies them in `seq` order, and the
 * inbound token bucket the rtc worker holds per peer. Pure: no DOM, no workers; `tests/client/threads/rtc`
 * runs it under bun.
 *
 * A delta is `{del:{pos,len}, ins}`: delete `len` UTF-16 code units at `pos`, insert `ins` there. Positions are
 * code units because that is what a textarea's `selectionStart` speaks; `diffText` never splits a surrogate
 * pair, so an emoji is always deleted or inserted whole and a peer's caret never lands inside one.
 */
import type { StreamDel, StreamMessage } from "./protocol";

export type Delta = { seq: number; del: StreamDel; ins: string };

/** Deltas further ahead than this are a gap the receiver cannot wait out: it asks for the full text. */
export const REORDER_WINDOW = 64;
/** Sender: at most one delta per animation frame, and under the receiver's cap even on a 120 Hz display. */
export const MIN_DELTA_INTERVAL_MS = 17;
/** Receiver: inbound stream messages accepted per peer per second; the rest are dropped and a seq gap triggers a resync. */
export const MAX_DELTAS_PER_SECOND = 60;
/** The typing indicator clears this long after the last delta. */
export const TYPING_TTL_MS = 3_000;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** `text` with `del` removed and `ins` put in its place; positions past the end are clamped, never thrown. */
export function applyDelta(text: string, del: StreamDel, ins: string): string {
  const pos = Math.max(0, Math.min(del.pos, text.length));
  const end = Math.max(pos, Math.min(pos + del.len, text.length));
  return text.slice(0, pos) + ins + text.slice(end);
}

/** Where the author's caret sits after a delta: right after what was inserted. */
export function caretAfter(del: StreamDel, ins: string): number {
  return del.pos + ins.length;
}

/**
 * The smallest single edit turning `before` into `after` (common prefix and suffix stripped), or null when
 * equal. Boundaries back off a surrogate pair so neither half travels alone.
 */
export function diffText(before: string, after: string): { del: StreamDel; ins: string } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && start < max && isHigh(before.charCodeAt(start - 1))) start--;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  if (endB < before.length && endB > start && isLow(before.charCodeAt(endB))) {
    endB++;
    endA++;
  }
  return { del: { pos: start, len: endB - start }, ins: after.slice(start, endA) };
}

/**
 * The author's side: `update` with the whole textarea value on every input, `flush` once per frame. Each flush
 * is one delta from the last flushed text to the current one, numbered from 1.
 */
export class StreamSender {
  seq = 0;
  private sent = "";
  private pending = "";
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly minIntervalMs = MIN_DELTA_INTERVAL_MS) {}

  get text(): string {
    return this.pending;
  }

  update(text: string): void {
    this.pending = text;
  }

  /** True when a flush would send something. */
  dirty(): boolean {
    return this.pending !== this.sent;
  }

  /** Ms until the frame interval since the last delta has elapsed; 0 when a flush may go now. */
  wait(now: number): number {
    return Math.max(0, this.minIntervalMs - (now - this.lastAt));
  }

  /** The next delta, or null when nothing changed or the frame interval has not elapsed. */
  flush(now: number): Delta | null {
    if (now - this.lastAt < this.minIntervalMs) return null;
    const diff = diffText(this.sent, this.pending);
    if (!diff) return null;
    this.lastAt = now;
    this.sent = this.pending;
    this.seq += 1;
    return { seq: this.seq, ...diff };
  }

  /** The whole text as last flushed, with its seq, for a `stream.sync`. */
  snapshot(): { seq: number; text: string } {
    return { seq: this.seq, text: this.sent };
  }

  /** Start over (a new message): seq back to 0. */
  reset(text = ""): void {
    this.seq = 0;
    this.sent = text;
    this.pending = text;
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}

export type ReceiveOutcome = "applied" | "duplicate" | "buffered" | "gap";

/**
 * A peer's view of one stream: applies deltas in seq order, keeps the ones that arrive early (up to
 * `REORDER_WINDOW` ahead), ignores repeats, and reports a gap when a delta is too far ahead so the caller can
 * ask for a `stream.sync`. Idempotent: delivering the same delta twice, or the same batch in any order within
 * the window, converges on the same text.
 */
export class StreamReceiver {
  text = "";
  /** Seq of the last applied delta; 0 before any. */
  seq = 0;
  /** The author's caret after the last applied delta. */
  caret = 0;
  private readonly early = new Map<number, Delta>();

  constructor(private readonly window = REORDER_WINDOW) {}

  receive(d: Delta): ReceiveOutcome {
    if (d.seq <= this.seq) return "duplicate";
    // Too far ahead to wait out: the caller asks for a sync, which carries this delta's effect anyway.
    if (d.seq > this.seq + this.window) return "gap";
    if (d.seq !== this.seq + 1) {
      this.early.set(d.seq, d);
      return "buffered";
    }
    this.apply(d);
    while (this.early.has(this.seq + 1)) {
      const next = this.early.get(this.seq + 1)!;
      this.early.delete(next.seq);
      this.apply(next);
    }
    return "applied";
  }

  /** The author's full text after delta `seq`: replaces everything older, keeps buffered newer deltas. */
  sync(seq: number, text: string): void {
    this.text = text;
    this.seq = seq;
    this.caret = text.length;
    for (const k of [...this.early.keys()]) if (k <= seq) this.early.delete(k);
    while (this.early.has(this.seq + 1)) {
      const next = this.early.get(this.seq + 1)!;
      this.early.delete(next.seq);
      this.apply(next);
    }
  }

  /** Buffered deltas that cannot apply yet. */
  pending(): number {
    return this.early.size;
  }

  private apply(d: Delta): void {
    this.text = applyDelta(this.text, d.del, d.ins);
    this.caret = Math.min(caretAfter(d.del, d.ins), this.text.length);
    this.seq = d.seq;
  }
}

/**
 * What the rtc worker lets through from a peer's channel: `from` becomes the channel's peer id (a peer cannot
 * speak as another), a `to` must name this node, and the message passes the per-peer rate limit (every stream
 * type counts: a flood of syncs or typing flags costs main-thread work too). Null drops it.
 */
export function admitInbound(msg: StreamMessage, peerId: string, me: string, limit: RateLimit, now: number): StreamMessage | null {
  if ("to" in msg && msg.to !== me) return null;
  if (!limit.take(now)) return null;
  return { ...msg, from: peerId };
}

/** Sliding window: at most `limit` passes in any `windowMs`. `take` records one and answers whether it may pass. */
export class RateLimit {
  private readonly stamps: number[] = [];

  constructor(
    private readonly limit = MAX_DELTAS_PER_SECOND,
    private readonly windowMs = 1_000,
  ) {}

  take(now: number): boolean {
    while (this.stamps.length > 0 && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }
}
