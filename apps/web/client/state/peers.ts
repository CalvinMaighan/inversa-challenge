import { key } from "@calvinjs/active-state";

/** Signaling heartbeat TTL (PLAN.md C9): a peer unseen for longer is gone. */
export const PEER_TTL_MS = 60_000;

export type Peer = {
  /** The peer's ME.nodeId. */
  peerId: string;
  callsign: string;
  color: string;
  /** Last heartbeat or data-channel message, RFC 3339. */
  seenAt: string;
  /** Last globe cursor position, degrees, or null when off the globe. */
  cursor: { lon: number; lat: number } | null;
  /** Data-channel state; "relay" when messages fall back to the server WebSocket. */
  link: "connecting" | "open" | "relay" | "closed";
};

export const PEERS = key("PEERS", [] as Peer[]);

/** Peers heard from within the TTL, ordered by callsign. */
export function livePeers(peers: readonly Peer[], nowMs: number): Peer[] {
  return peers
    .filter((p) => p.link !== "closed" && nowMs - Date.parse(p.seenAt) <= PEER_TTL_MS)
    .sort((a, b) => a.callsign.localeCompare(b.callsign));
}
