import { describe, expect, test } from "bun:test";
import {
  allocRing,
  CTRL_BYTES,
  decodeValue,
  encodeValue,
  PAD_MARKER,
  Ring,
} from "../../src/threads";

const bytes = (n: number, fill = n & 0xff) => new Uint8Array(n).fill(fill);

describe("ring", () => {
  test("rejects capacities that are not a power of 2", () => {
    expect(() => allocRing(100)).toThrow(/power of 2/);
    expect(() => allocRing(32)).toThrow(/power of 2/);
    expect(() => new Ring(new SharedArrayBuffer(CTRL_BYTES + 96))).toThrow(
      /power of 2/,
    );
  });

  test("wraparound writes the pad marker and continues at 0", () => {
    const ring = new Ring(allocRing(64));
    // 20-byte payloads need 26 bytes each: two fit (w = 52), a third does not.
    expect(ring.tryWrite(1, bytes(20, 1))).toBe(true);
    expect(ring.tryWrite(2, bytes(20, 2))).toBe(true);
    expect(ring.writeCursor).toBe(52);
    expect(ring.tryRead()?.keyIndex).toBe(1);
    expect(ring.tryRead()?.keyIndex).toBe(2);
    expect(ring.readCursor).toBe(52);

    expect(ring.tryWrite(3, bytes(20, 3))).toBe(true);
    const view = new DataView(ring.buffer, CTRL_BYTES);
    expect(view.getUint16(52, true)).toBe(PAD_MARKER);
    expect(ring.writeCursor).toBe(26);

    const rec = ring.tryRead();
    expect(rec?.keyIndex).toBe(3);
    expect(rec?.bytes).toEqual(bytes(20, 3));
    expect(ring.readCursor).toBe(26);
    expect(ring.tryRead()).toBeNull();
  });

  test("implicit wrap when fewer than 2 bytes remain at the tail", () => {
    const ring = new Ring(allocRing(64));
    // 57-byte payload needs 63 bytes: w lands on 63, one byte short of the end.
    expect(ring.tryWrite(0, bytes(57))).toBe(true);
    expect(ring.writeCursor).toBe(63);
    expect(ring.tryRead()?.bytes.length).toBe(57);
    expect(ring.readCursor).toBe(63);
    expect(ring.tryWrite(5, bytes(4))).toBe(true);
    expect(ring.writeCursor).toBe(10);
    expect(ring.tryRead()).toEqual({ keyIndex: 5, bytes: bytes(4) });
  });

  test("a 1 MB value round-trips through the default ring", () => {
    const ring = new Ring(allocRing());
    const big = new Uint8Array(1 << 20);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    expect(ring.tryWrite(7, big)).toBe(true);
    const rec = ring.tryRead();
    expect(rec?.keyIndex).toBe(7);
    expect(rec?.bytes.length).toBe(1 << 20);
    expect(rec?.bytes).toEqual(big);
    expect(ring.tryRead()).toBeNull();
  });

  test("a value too large for the ring throws a clear error", () => {
    const ring = new Ring(allocRing(64));
    expect(ring.maxBytes).toBe(57);
    expect(() => ring.tryWrite(0, bytes(58))).toThrow(
      /58 bytes exceeds the ring limit of 57 bytes/,
    );
    expect(ring.writeCursor).toBe(0);
    expect(() => ring.tryWrite(256, bytes(1))).toThrow(/keyIndex/);
  });

  test("10k messages arrive in order across many wraps", () => {
    const ring = new Ring(allocRing(1024));
    const total = 10_000;
    const seen: number[] = [];
    let next = 0;
    while (seen.length < total) {
      while (next < total && ring.tryWrite(next % 256, encodeValue(next))) {
        next++;
      }
      for (let rec = ring.tryRead(); rec; rec = ring.tryRead()) {
        expect(rec.keyIndex).toBe(seen.length % 256);
        seen.push(decodeValue(rec.bytes) as number);
      }
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(ring.isEmpty()).toBe(true);
  });

  test("a full ring applies backpressure and never overwrites", () => {
    const ring = new Ring(allocRing(64));
    // 10-byte payloads need 16 bytes: three fit, the fourth would land on r = 0.
    expect(ring.tryWrite(1, bytes(10, 1))).toBe(true);
    expect(ring.tryWrite(2, bytes(10, 2))).toBe(true);
    expect(ring.tryWrite(3, bytes(10, 3))).toBe(true);
    expect(ring.writeCursor).toBe(48);
    const snapshot = ring.data.slice();

    expect(ring.tryWrite(4, bytes(10, 4))).toBe(false);
    expect(ring.tryWrite(4, bytes(10, 4))).toBe(false);
    expect(ring.writeCursor).toBe(48);
    expect(ring.data.slice()).toEqual(snapshot);
    expect(ring.version(4)).toBe(0);

    expect(ring.tryRead()).toEqual({ keyIndex: 1, bytes: bytes(10, 1) });
    expect(ring.tryWrite(4, bytes(10, 4))).toBe(true);
    expect(ring.writeCursor).toBe(0);
    expect(ring.tryWrite(5, bytes(10, 5))).toBe(false);

    expect(ring.tryRead()).toEqual({ keyIndex: 2, bytes: bytes(10, 2) });
    expect(ring.tryRead()).toEqual({ keyIndex: 3, bytes: bytes(10, 3) });
    expect(ring.tryRead()).toEqual({ keyIndex: 4, bytes: bytes(10, 4) });
    expect(ring.tryRead()).toBeNull();
  });

  test("each write bumps the key version", () => {
    const ring = new Ring(allocRing(64));
    ring.tryWrite(3, bytes(1));
    ring.tryWrite(3, bytes(1));
    ring.tryWrite(7, bytes(1));
    expect(ring.version(3)).toBe(2);
    expect(ring.version(7)).toBe(1);
    expect(ring.version(0)).toBe(0);
    while (ring.tryRead()) {
      /* drain */
    }
    ring.tryWrite(255, bytes(1));
    expect(ring.version(255)).toBe(1);
    expect(ring.version(3)).toBe(2);
  });

  test("encodeValue/decodeValue keep undefined and unicode", () => {
    expect(decodeValue(encodeValue(undefined))).toBeUndefined();
    expect(encodeValue(undefined).length).toBe(0);
    const value = { s: "ünï 🐍", n: [1, 2.5, null], b: false };
    expect(decodeValue(encodeValue(value))).toEqual(value);
  });
});
