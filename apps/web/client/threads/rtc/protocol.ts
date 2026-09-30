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

export type PeerMessage =
  | { type: "ops"; boardId: string; ops: Op[] }
  | { type: "cursor"; lon: number | null; lat: number | null }
  | { type: "hello"; me: PeerIdentity };

export function isPeerMessage(d: unknown): d is PeerMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as { type?: unknown; boardId?: unknown; ops?: unknown; me?: unknown; lon?: unknown; lat?: unknown };
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
  /** Test hook: drop every peer message in both directions, so edits must ride the WebSocket. */
  | { t: "rtc:block"; on: boolean };

export type FromRtc =
  | { t: "rtc:open"; peerId: string }
  | { t: "rtc:closed"; peerId: string }
  | { t: "rtc:ops"; peerId: string; boardId: string; ops: Op[] }
  | { t: "rtc:peer-hello"; peerId: string; me: PeerIdentity }
  | { t: "rtc:peer-cursor"; peerId: string; lon: number | null; lat: number | null }
  | { t: "rtc:stats"; open: number };

export function isToRtc(d: unknown): d is ToRtc {
  return Boolean(d) && typeof d === "object" && typeof (d as { t?: unknown }).t === "string" && (d as { t: string }).t.startsWith("rtc:");
}

export function isFromRtc(d: unknown): d is FromRtc {
  return isToRtc(d);
}
