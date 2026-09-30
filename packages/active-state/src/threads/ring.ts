/**
 * SPSC byte ring over a SharedArrayBuffer.
 *
 * Layout of one buffer:
 *   ctrl  Int32Array[2 + 256] = [writeCursor, readCursor, keyVersion × 256]
 *   data  Uint8Array[capacity], capacity a power of 2
 *
 * Record: u16 keyIndex, u32 len, then `len` bytes (little-endian header).
 * A record never straddles the wrap. When it does not fit at the tail the
 * writer stores the pad marker `0xFFFF` as a u16 (when 2 bytes remain) and
 * continues at offset 0. Readers treat a tail shorter than 2 bytes as an
 * implicit pad.
 *
 * One writer thread, one reader thread. Cursors are offsets in [0, capacity).
 * The ring is empty when the cursors are equal, so a write never lands the
 * write cursor on the read cursor: that keeps one byte free and makes "full"
 * unambiguous. `tryWrite` returns false instead of overwriting.
 */

export const MAX_KEYS = 256;
export const PAD_MARKER = 0xffff;
export const CTRL_WRITE = 0;
export const CTRL_READ = 1;
export const CTRL_VERSION = 2;
const CTRL_LENGTH = CTRL_VERSION + MAX_KEYS;
/** Bytes of the control block that precedes the data region. */
export const CTRL_BYTES = CTRL_LENGTH * 4;
const HEADER_BYTES = 6;
export const MIN_CAPACITY = 64;
/** 2 MiB per direction: a 1 MB JSON value fits with room to spare. */
export const DEFAULT_CAPACITY = 1 << 21;

export type RingRecord = { keyIndex: number; bytes: Uint8Array };

function isPow2(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function assertCapacity(capacity: number): void {
  if (!isPow2(capacity) || capacity < MIN_CAPACITY) {
    throw new Error(
      `[active-state/threads] ring capacity must be a power of 2 >= ${MIN_CAPACITY}, got ${capacity}`,
    );
  }
}

/** Allocate a SharedArrayBuffer sized for a control block plus `capacity` data bytes. */
export function allocRing(capacity = DEFAULT_CAPACITY): SharedArrayBuffer {
  assertCapacity(capacity);
  return new SharedArrayBuffer(CTRL_BYTES + capacity);
}

export class Ring {
  readonly buffer: SharedArrayBuffer;
  readonly ctrl: Int32Array;
  readonly data: Uint8Array;
  readonly capacity: number;
  /** Largest payload `tryWrite` accepts. */
  readonly maxBytes: number;
  private readonly view: DataView;
  private readonly mask: number;

  constructor(buffer: SharedArrayBuffer) {
    const capacity = buffer.byteLength - CTRL_BYTES;
    assertCapacity(capacity);
    this.buffer = buffer;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.maxBytes = capacity - 1 - HEADER_BYTES;
    this.ctrl = new Int32Array(buffer, 0, CTRL_LENGTH);
    this.data = new Uint8Array(buffer, CTRL_BYTES, capacity);
    this.view = new DataView(buffer, CTRL_BYTES, capacity);
  }

  get writeCursor(): number {
    return Atomics.load(this.ctrl, CTRL_WRITE);
  }

  get readCursor(): number {
    return Atomics.load(this.ctrl, CTRL_READ);
  }

  /** Number of writes seen for `keyIndex` (wraps at 2^31). */
  version(keyIndex: number): number {
    return Atomics.load(this.ctrl, CTRL_VERSION + keyIndex);
  }

  isEmpty(): boolean {
    return this.writeCursor === this.readCursor;
  }

  /**
   * Append one record. Returns false when the ring lacks room; nothing is
   * written in that case. Throws when the payload can never fit.
   */
  tryWrite(keyIndex: number, bytes: Uint8Array): boolean {
    if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= MAX_KEYS) {
      throw new Error(
        `[active-state/threads] keyIndex must be an integer in [0, ${MAX_KEYS}), got ${keyIndex}`,
      );
    }
    if (bytes.length > this.maxBytes) {
      throw new Error(
        `[active-state/threads] value of ${bytes.length} bytes exceeds the ring limit of ${this.maxBytes} bytes; allocate a larger ring (allocRing(capacity))`,
      );
    }
    const need = HEADER_BYTES + bytes.length;
    const cap = this.capacity;
    const ctrl = this.ctrl;
    let w = Atomics.load(ctrl, CTRL_WRITE);
    const r = Atomics.load(ctrl, CTRL_READ);

    if (w >= r) {
      const tail = cap - w;
      // Landing exactly on cap wraps to 0; that is fine unless r is 0.
      const fitsTail = need < tail || (need === tail && r !== 0);
      if (!fitsTail) {
        if (need >= r) return false;
        if (tail >= 2) this.view.setUint16(w, PAD_MARKER, true);
        w = 0;
      }
    } else if (need >= r - w) {
      return false;
    }

    this.view.setUint16(w, keyIndex, true);
    this.view.setUint32(w + 2, bytes.length, true);
    this.data.set(bytes, w + HEADER_BYTES);
    Atomics.add(ctrl, CTRL_VERSION + keyIndex, 1);
    Atomics.store(ctrl, CTRL_WRITE, (w + need) & this.mask);
    Atomics.notify(ctrl, CTRL_WRITE);
    return true;
  }

  /** Pop one record, copying its bytes out of shared memory. Null when empty. */
  tryRead(): RingRecord | null {
    const ctrl = this.ctrl;
    let r = Atomics.load(ctrl, CTRL_READ);
    const w = Atomics.load(ctrl, CTRL_WRITE);
    if (r === w) return null;
    if (
      this.capacity - r < 2 ||
      this.view.getUint16(r, true) === PAD_MARKER
    ) {
      r = 0;
    }
    const keyIndex = this.view.getUint16(r, true);
    const len = this.view.getUint32(r + 2, true);
    const start = r + HEADER_BYTES;
    // slice() copies into a non-shared buffer: TextDecoder rejects SAB views.
    const bytes = this.data.slice(start, start + len);
    Atomics.store(ctrl, CTRL_READ, (start + len) & this.mask);
    Atomics.notify(ctrl, CTRL_READ);
    return { keyIndex, bytes };
  }

  /** Block until the write cursor moves away from `seen` (workers only). */
  wait(seen: number, timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    return Atomics.wait(this.ctrl, CTRL_WRITE, seen, timeoutMs);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** JSON encode; `undefined` becomes an empty payload. */
export function encodeValue(value: unknown): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return encoder.encode(JSON.stringify(value));
}

export function decodeValue(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return undefined;
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

type WaitAsyncResult = {
  async: boolean;
  value: Promise<"ok" | "timed-out"> | "not-equal" | "timed-out";
};

type AtomicsWithWaitAsync = typeof Atomics & {
  waitAsync?: (
    arr: Int32Array,
    index: number,
    value: number,
    timeout?: number,
  ) => WaitAsyncResult;
};

export function hasWaitAsync(): boolean {
  return typeof (Atomics as AtomicsWithWaitAsync).waitAsync === "function";
}

/**
 * Resolve once `arr[index]` differs from `seen`, or after `timeoutMs`.
 * Uses `Atomics.waitAsync` when present, else a short poll (never blocks).
 */
export function waitChange(
  arr: Int32Array,
  index: number,
  seen: number,
  timeoutMs = Infinity,
): Promise<void> {
  const waitAsync = (Atomics as AtomicsWithWaitAsync).waitAsync;
  if (waitAsync) {
    const res = waitAsync(arr, index, seen, timeoutMs);
    if (!res.async) return Promise.resolve();
    return (res.value as Promise<unknown>).then(() => undefined);
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (Atomics.load(arr, index) !== seen || Date.now() >= deadline) {
        resolve();
      } else {
        setTimeout(tick, 1);
      }
    };
    tick();
  });
}
