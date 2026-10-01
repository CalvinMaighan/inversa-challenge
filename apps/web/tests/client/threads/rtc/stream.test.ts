import { describe, expect, test } from "bun:test";

import { applyDelta, caretAfter, diffText, REORDER_WINDOW, StreamReceiver, StreamSender, type Delta } from "client/threads/rtc/stream";

/** xorshift32, fixed seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const ALPHABET = ["a", "b", "c", " ", "\n", "é", "😀", "🦎", "👨‍👩‍👧", "字"];

/** A random single edit (type, backspace, mid-insert, selection replace) on `text`, never splitting a surrogate pair. */
function randomEdit(text: string, next: () => number): string {
  const points = [...text];
  const n = points.length;
  const i = Math.floor(next() * (n + 1));
  const kind = next();
  if (kind < 0.5 || n === 0) {
    const ins = ALPHABET[Math.floor(next() * ALPHABET.length)]!;
    return [...points.slice(0, i), ins, ...points.slice(i)].join("");
  }
  if (kind < 0.8) {
    const at = Math.min(i, n - 1);
    return [...points.slice(0, at), ...points.slice(at + 1)].join("");
  }
  const len = Math.floor(next() * 4);
  const ins = ALPHABET[Math.floor(next() * ALPHABET.length)]!;
  return [...points.slice(0, i), ins, ...points.slice(i + len)].join("");
}

describe("stream delta", () => {
  test("stream delta: applyDelta deletes then inserts at a code-unit position, clamping past the end", () => {
    expect(applyDelta("hello", { pos: 5, len: 0 }, " world")).toBe("hello world");
    expect(applyDelta("hello", { pos: 4, len: 1 }, "")).toBe("hell");
    expect(applyDelta("hello", { pos: 1, len: 3 }, "ipp")).toBe("hippo");
    expect(applyDelta("hi", { pos: 10, len: 5 }, "!")).toBe("hi!");
    expect(applyDelta("hi", { pos: 1, len: 50 }, "")).toBe("h");
  });

  test("stream delta: diffText finds the one edit between two texts, null when equal", () => {
    expect(diffText("abc", "abc")).toBeNull();
    expect(diffText("", "h")).toEqual({ del: { pos: 0, len: 0 }, ins: "h" });
    expect(diffText("hello", "hell")).toEqual({ del: { pos: 4, len: 1 }, ins: "" });
    expect(diffText("hello world", "hello big world")).toEqual({ del: { pos: 6, len: 0 }, ins: "big " });
    expect(diffText("aaa", "aa")).toEqual({ del: { pos: 2, len: 1 }, ins: "" });
    expect(diffText("abc", "")).toEqual({ del: { pos: 0, len: 3 }, ins: "" });
    for (const [a, b] of [
      ["hello", "hell"],
      ["abc", "xyz"],
      ["", "typed"],
      ["same prefix and suffix", "same suffix"],
    ] as const) {
      const d = diffText(a, b)!;
      expect(applyDelta(a, d.del, d.ins)).toBe(b);
    }
  });

  test("stream delta: emoji and other surrogate pairs travel whole, never split into halves", () => {
    const d1 = diffText("ab", "a😀b")!;
    expect(d1).toEqual({ del: { pos: 1, len: 0 }, ins: "😀" });
    // Replacing one emoji by another that shares a high surrogate: the whole pair is replaced.
    const d2 = diffText("a😀b", "a😁b")!;
    expect(d2.ins).toBe("😁");
    expect(d2.del).toEqual({ pos: 1, len: 2 });
    expect(applyDelta("a😀b", d2.del, d2.ins)).toBe("a😁b");
    // Backspace on an emoji removes both code units.
    const d3 = diffText("hi 🦎", "hi ")!;
    expect(d3).toEqual({ del: { pos: 3, len: 2 }, ins: "" });
    // A ZWJ family sequence inserted in the middle.
    const d4 = diffText("ab", "a👨‍👩‍👧b")!;
    expect(applyDelta("ab", d4.del, d4.ins)).toBe("a👨‍👩‍👧b");
    for (const d of [d1, d2, d3, d4]) {
      for (const s of [d.ins]) {
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff) expect(i + 1 < s.length).toBe(true);
          if (c >= 0xdc00 && c <= 0xdfff) expect(i > 0).toBe(true);
        }
      }
    }
  });

  test("stream delta: the author's caret lands after what was inserted, and the receiver clamps it to the text", () => {
    expect(caretAfter({ pos: 3, len: 0 }, "ab")).toBe(5);
    expect(caretAfter({ pos: 3, len: 2 }, "")).toBe(3);
    const r = new StreamReceiver();
    r.receive({ seq: 1, del: { pos: 0, len: 0 }, ins: "a😀" });
    expect(r.caret).toBe(3);
    r.receive({ seq: 2, del: { pos: 1, len: 2 }, ins: "" });
    expect([r.text, r.caret]).toEqual(["a", 1]);
  });

  test("stream delta: sender numbers deltas from 1, coalesces keystrokes within a frame, and snapshots the sent text", () => {
    const s = new StreamSender(16);
    expect(s.flush(0)).toBeNull();
    s.update("h");
    s.update("he");
    s.update("hel");
    expect(s.flush(0)).toEqual({ seq: 1, del: { pos: 0, len: 0 }, ins: "hel" });
    s.update("hell");
    expect(s.flush(5)).toBeNull(); // same frame
    expect(s.dirty()).toBe(true);
    expect(s.flush(16)).toEqual({ seq: 2, del: { pos: 3, len: 0 }, ins: "l" });
    expect(s.flush(40)).toBeNull();
    expect(s.snapshot()).toEqual({ seq: 2, text: "hell" });
    s.reset("saved");
    expect(s.seq).toBe(0);
    expect(s.snapshot()).toEqual({ seq: 0, text: "saved" });
  });

  test("stream delta: receiver applies in seq order, ignores duplicates, holds early deltas, and reports a gap", () => {
    const r = new StreamReceiver(4);
    const d1: Delta = { seq: 1, del: { pos: 0, len: 0 }, ins: "ab" };
    const d2: Delta = { seq: 2, del: { pos: 2, len: 0 }, ins: "c" };
    const d3: Delta = { seq: 3, del: { pos: 0, len: 1 }, ins: "" };
    expect(r.receive(d2)).toBe("buffered");
    expect(r.text).toBe("");
    expect(r.receive(d1)).toBe("applied");
    expect(r.text).toBe("abc");
    expect(r.seq).toBe(2);
    expect(r.receive(d1)).toBe("duplicate");
    expect(r.receive(d2)).toBe("duplicate");
    expect(r.receive(d3)).toBe("applied");
    expect(r.text).toBe("bc");
    expect(r.caret).toBe(0);
    expect(r.receive({ seq: 3 + 4 + 1, del: { pos: 0, len: 0 }, ins: "z" })).toBe("gap");
    expect(r.seq).toBe(3);
    r.sync(8, "synced text");
    expect(r.text).toBe("synced text");
    expect(r.seq).toBe(8);
    expect(r.receive({ seq: 9, del: { pos: 11, len: 0 }, ins: "!" })).toBe("applied");
    expect(r.text).toBe("synced text!");
    expect(REORDER_WINDOW).toBe(64);
  });

  test("stream delta: a sync drops buffered deltas it already covers and applies the ones after it", () => {
    const r = new StreamReceiver();
    expect(r.receive({ seq: 5, del: { pos: 0, len: 0 }, ins: "old" })).toBe("buffered");
    expect(r.receive({ seq: 7, del: { pos: 4, len: 0 }, ins: "!" })).toBe("buffered");
    r.sync(6, "base");
    // seq 5 was covered by the sync and dropped; seq 7 followed it and applied at once.
    expect(r.pending()).toBe(0);
    expect(r.seq).toBe(7);
    expect(r.text).toBe("base!");
    expect(r.receive({ seq: 7, del: { pos: 4, len: 0 }, ins: "!" })).toBe("duplicate");
  });

  test("stream delta: property: random edit sequences on a sender converge on the receiver under shuffling and duplicates within the window", () => {
    const next = rng(0x5eed);
    for (let round = 0; round < 60; round++) {
      const sender = new StreamSender(0);
      let text = "";
      const deltas: Delta[] = [];
      const steps = 1 + Math.floor(next() * 80);
      for (let i = 0; i < steps; i++) {
        text = randomEdit(text, next);
        sender.update(text);
        const d = sender.flush(i);
        if (d) deltas.push(d);
      }
      // Deliver in windows: shuffle within each window of REORDER_WINDOW, and repeat some deltas.
      const receiver = new StreamReceiver();
      for (let start = 0; start < deltas.length; start += REORDER_WINDOW) {
        const chunk = deltas.slice(start, start + REORDER_WINDOW);
        const order = [...chunk];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        for (const d of order) {
          const outcome = receiver.receive(d);
          expect(outcome === "applied" || outcome === "buffered").toBe(true);
          if (next() < 0.3) expect(["duplicate", "buffered"]).toContain(receiver.receive(d));
        }
      }
      expect(receiver.pending()).toBe(0);
      expect(receiver.text).toBe(text);
      expect(receiver.text).toBe(sender.snapshot().text);
    }
  });

  test("stream delta: property: two receivers fed the same deltas in different orders agree, and a gap heals with one sync", () => {
    const next = rng(0xabcdef);
    const sender = new StreamSender(0);
    let text = "";
    const deltas: Delta[] = [];
    for (let i = 0; i < 200; i++) {
      text = randomEdit(text, next);
      sender.update(text);
      const d = sender.flush(i);
      if (d) deltas.push(d);
    }
    const a = new StreamReceiver();
    const b = new StreamReceiver();
    for (const d of deltas) a.receive(d);
    // b misses the first 100 deltas (a dropped channel), then sees the rest: a gap, healed by the author's sync.
    let gaps = 0;
    for (const d of deltas.slice(100)) if (b.receive(d) === "gap") gaps++;
    expect(gaps).toBeGreaterThan(0);
    expect(b.text).not.toBe(a.text);
    const snap = sender.snapshot();
    b.sync(snap.seq, snap.text);
    expect(b.text).toBe(a.text);
    expect(a.text).toBe(text);
  });
});
