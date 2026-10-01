import { describe, expect, test } from "bun:test";

import { isPeerMessage, isStreamMessage, MAX_STREAM_ID_CHARS, MAX_STREAM_TEXT_CHARS, type StreamMessage } from "client/threads/rtc/protocol";

const delta: StreamMessage = { type: "dm.delta", thread: "dm:a~b", msgId: "m1", from: "a", to: "b", seq: 1, at: 1_700_000_000_000, del: { pos: 0, len: 0 }, ins: "h" };
const commit: StreamMessage = { type: "dm.commit", thread: "dm:a~b", msgId: "m1", from: "a", to: "b", text: "hello", hlc: "1700000000000:0:a" };
const typing: StreamMessage = { type: "dm.typing", thread: "dm:a~b", from: "a", on: true };
const note: StreamMessage = { type: "note.delta", noteId: "n1", from: "a", seq: 3, del: { pos: 2, len: 1 }, ins: "" };
const sync: StreamMessage = { type: "stream.sync", kind: "note", id: "n1", from: "a", seq: 0, text: "two pythons" };
const resync: StreamMessage = { type: "stream.resync", kind: "dm", id: "m1", from: "b" };

describe("peer message dm", () => {
  test("peer message dm: every C-A7 shape round-trips through JSON and validates", () => {
    for (const m of [delta, commit, typing, note, sync, resync]) {
      expect(isStreamMessage(JSON.parse(JSON.stringify(m)))).toBe(true);
      expect(isPeerMessage(JSON.parse(JSON.stringify(m)))).toBe(true);
    }
    // The older shapes still pass.
    expect(isPeerMessage({ type: "cursor", lon: 1, lat: 2 })).toBe(true);
    expect(isPeerMessage({ type: "hello", me: { nodeId: "a", callsign: "A", color: "#fff" } })).toBe(true);
    expect(isPeerMessage({ type: "ops", boardId: "b", ops: [] })).toBe(true);
  });

  test("peer message dm: oversize text (over 4 KB) is rejected, 4 KB exactly is fine", () => {
    expect(MAX_STREAM_TEXT_CHARS).toBe(4096);
    expect(isPeerMessage({ ...delta, ins: "x".repeat(4096) })).toBe(true);
    expect(isPeerMessage({ ...delta, ins: "x".repeat(4097) })).toBe(false);
    expect(isPeerMessage({ ...commit, text: "x".repeat(4097) })).toBe(false);
    expect(isPeerMessage({ ...sync, text: "x".repeat(4097) })).toBe(false);
    expect(isPeerMessage({ ...delta, msgId: "m".repeat(MAX_STREAM_ID_CHARS + 1) })).toBe(false);
  });

  test("peer message dm: unknown fields are rejected", () => {
    expect(isPeerMessage({ ...delta, html: "<b>" })).toBe(false);
    expect(isPeerMessage({ ...commit, extra: 1 })).toBe(false);
    expect(isPeerMessage({ ...typing, caret: 3 })).toBe(false);
    expect(isPeerMessage({ ...note, to: "b" })).toBe(false);
    expect(isPeerMessage({ ...delta, del: { pos: 0, len: 0, extra: true } })).toBe(false);
  });

  test("peer message dm: missing fields and wrong types are rejected", () => {
    const { ins: _ins, ...noIns } = delta;
    void _ins;
    expect(isPeerMessage(noIns)).toBe(false);
    expect(isPeerMessage({ ...delta, seq: 0 })).toBe(false);
    expect(isPeerMessage({ ...delta, seq: 1.5 })).toBe(false);
    expect(isPeerMessage({ ...delta, seq: "1" })).toBe(false);
    expect(isPeerMessage({ ...delta, at: -1 })).toBe(false);
    expect(isPeerMessage({ ...delta, del: { pos: -1, len: 0 } })).toBe(false);
    expect(isPeerMessage({ ...delta, del: { pos: 0 } })).toBe(false);
    expect(isPeerMessage({ ...delta, del: null })).toBe(false);
    expect(isPeerMessage({ ...delta, ins: 7 })).toBe(false);
    expect(isPeerMessage({ ...delta, from: "" })).toBe(false);
    expect(isPeerMessage({ ...delta, to: 5 })).toBe(false);
    expect(isPeerMessage({ ...commit, hlc: "" })).toBe(false);
    expect(isPeerMessage({ ...commit, text: null })).toBe(false);
    expect(isPeerMessage({ ...typing, on: "yes" })).toBe(false);
    expect(isPeerMessage({ ...note, noteId: 1 })).toBe(false);
    expect(isPeerMessage({ ...sync, kind: "chat" })).toBe(false);
    expect(isPeerMessage({ ...sync, seq: -1 })).toBe(false);
    expect(isPeerMessage({ ...resync, id: undefined })).toBe(false);
    expect(isPeerMessage({ type: "dm.delta" })).toBe(false);
    expect(isPeerMessage({ type: "dm.whisper", thread: "t", from: "a" })).toBe(false);
    expect(isPeerMessage(null)).toBe(false);
    expect(isPeerMessage("dm.delta")).toBe(false);
  });

  test("peer message dm: a prototype-polluting key does not pass as a known field", () => {
    const m = JSON.parse('{"type":"dm.typing","thread":"dm:a~b","from":"a","on":true,"__proto__":{"x":1}}') as unknown;
    expect(isPeerMessage(m)).toBe(false);
  });
});
