/**
 * Team realtime wire shapes (PRD §12 "New tech 3", PLAN.md C5/C9).
 *
 * Three layers share this file:
 * - peer <-> peer: JSON text on the "ops" RTCDataChannel (`PeerMessage`);
 * - main <-> rtc worker: `ToRtc` / `FromRtc` over the worker's postMessage;
 * - main <-> rtc worker relay: frames on a T16 channel for browsers that cannot transfer an RTCDataChannel
 *   (`relay.ts`).
 */
import type { Op } from "client/threads/crdt/types";

/** Identity a peer announces on its data channel. Mirrors `MeState` without importing the state module. */
export type PeerIdentity = { nodeId: string; callsign: string; color: string };

export type PeerCursor = { lon: number; lat: number } | null;

/** One edit of a streamed text: delete `len` UTF-16 code units at `pos`, then insert `ins` there (PLAN.md C-A7). */
export type StreamDel = { pos: number; len: number };

/**
 * Live text streams (PLAN.md C-A7, M1). `from` is what the sender claims; the rtc worker replaces it with the
 * channel's peer id before main sees it, so a peer cannot speak as someone else. `seq` runs from 1 per stream
 * (`msgId` / `noteId`); `stream.sync` carries the whole text after delta `seq` and is sent in reply to a
 * `stream.resync`, on reconnect, and when a stream starts.
 */
export type StreamMessage =
  | { type: "dm.delta"; thread: string; msgId: string; from: string; to: string; seq: number; at: number; del: StreamDel; ins: string }
  | { type: "dm.commit"; thread: string; msgId: string; from: string; to: string; text: string; hlc: string }
  | { type: "dm.typing"; thread: string; from: string; on: boolean }
  | { type: "note.delta"; noteId: string; from: string; seq: number; del: StreamDel; ins: string }
  | { type: "stream.sync"; kind: "dm" | "note"; id: string; from: string; seq: number; text: string }
  | { type: "stream.resync"; kind: "dm" | "note"; id: string; from: string };

export type PeerMessage = { type: "ops"; boardId: string; ops: Op[] } | { type: "cursor"; lon: number | null; lat: number | null } | { type: "hello"; me: PeerIdentity } | StreamMessage;

/** Longest `ins` or committed `text` in a stream message, in UTF-16 code units. */
export const MAX_STREAM_TEXT_CHARS = 4 * 1024;
/** Longest stream, thread and node id. */
export const MAX_STREAM_ID_CHARS = 256;

const STREAM_TYPES = new Set(["dm.delta", "dm.commit", "dm.typing", "note.delta", "stream.sync", "stream.resync"]);

/** Exactly these keys, each passing its check. */
const shape = (m: Record<string, unknown>, checks: Record<string, (v: unknown) => boolean>): boolean => {
  const keys = Object.keys(m);
  if (keys.length !== Object.keys(checks).length) return false;
  return keys.every((k) => Object.hasOwn(checks, k) && checks[k]!(m[k]));
};
const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= MAX_STREAM_ID_CHARS;
const text = (v: unknown) => typeof v === "string" && v.length <= MAX_STREAM_TEXT_CHARS;
const uint = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const seq = (v: unknown) => uint(v) && (v as number) >= 1;
const del = (v: unknown) => Boolean(v) && typeof v === "object" && shape(v as Record<string, unknown>, { pos: uint, len: uint });
const kind = (v: unknown) => v === "dm" || v === "note";
const bool = (v: unknown) => typeof v === "boolean";
const literal = (s: string) => (v: unknown) => v === s;

export function isStreamMessage(d: unknown): d is StreamMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  switch (m.type) {
    case "dm.delta":
      return shape(m, { type: literal("dm.delta"), thread: id, msgId: id, from: id, to: id, seq, at: uint, del, ins: text });
    case "dm.commit":
      return shape(m, { type: literal("dm.commit"), thread: id, msgId: id, from: id, to: id, text, hlc: id });
    case "dm.typing":
      return shape(m, { type: literal("dm.typing"), thread: id, from: id, on: bool });
    case "note.delta":
      return shape(m, { type: literal("note.delta"), noteId: id, from: id, seq, del, ins: text });
    case "stream.sync":
      return shape(m, { type: literal("stream.sync"), kind, id, from: id, seq: uint, text });
    case "stream.resync":
      return shape(m, { type: literal("stream.resync"), kind, id, from: id });
    default:
      return false;
  }
}

export function isPeerMessage(d: unknown): d is PeerMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as { type?: unknown; boardId?: unknown; ops?: unknown; me?: unknown; lon?: unknown; lat?: unknown };
  if (typeof m.type === "string" && STREAM_TYPES.has(m.type)) return isStreamMessage(d);
  switch (m.type) {
    case "ops":
      return typeof m.boardId === "string" && Array.isArray(m.ops);
    case "cursor":
      return (m.lon === null || typeof m.lon === "number") && (m.lat === null || typeof m.lat === "number");
    case "hello":
      return Boolean(m.me) && typeof m.me === "object" && typeof (m.me as PeerIdentity).nodeId === "string";
    default:
      return false;
  }
}

/** Largest peer message accepted, in UTF-16 code units. A 200-op batch of 16 KiB values stays well under this. */
export const MAX_PEER_MESSAGE_CHARS = 4 * 1024 * 1024;

export type ToRtc =
  | { t: "rtc:hello"; me: PeerIdentity }
  /** A transferred RTCDataChannel (Chrome/Edge 130+, Safari 15+). */
  | { t: "rtc:attach"; peerId: string; channel: RTCDataChannel }
  /** The T16 channel main relays through when transfer is unsupported (Firefox). Sent once. */
  | { t: "rtc:relay"; handle: unknown }
  | { t: "rtc:detach"; peerId: string }
  | { t: "rtc:broadcast"; boardId: string; ops: Op[] }
  | { t: "rtc:cursor"; lon: number | null; lat: number | null }
  /** A stream message to one peer (`to`), or to every open channel when `to` is null. */
  | { t: "rtc:send"; to: string | null; msg: StreamMessage }
  /** Test hook: drop every peer message in both directions, so edits must ride the WebSocket. */
  | { t: "rtc:block"; on: boolean };

export type FromRtc =
  | { t: "rtc:open"; peerId: string }
  | { t: "rtc:closed"; peerId: string }
  | { t: "rtc:ops"; peerId: string; boardId: string; ops: Op[] }
  | { t: "rtc:peer-hello"; peerId: string; me: PeerIdentity }
  | { t: "rtc:peer-cursor"; peerId: string; lon: number | null; lat: number | null }
  /** A validated stream message whose `from` the worker set to the channel's peer id. */
  | { t: "rtc:peer-stream"; peerId: string; msg: StreamMessage }
  | { t: "rtc:stats"; open: number };

export function isToRtc(d: unknown): d is ToRtc {
  return Boolean(d) && typeof d === "object" && typeof (d as { t?: unknown }).t === "string" && (d as { t: string }).t.startsWith("rtc:");
}

export function isFromRtc(d: unknown): d is FromRtc {
  return isToRtc(d);
}
