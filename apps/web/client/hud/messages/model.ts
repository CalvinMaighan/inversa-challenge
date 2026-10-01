/**
 * Pure helpers behind the Direct messages panel (PLAN.md C-A7, M1): which messages belong to a thread, the
 * thread list (live peers plus anyone a thread was had with), and a peer's presence. No DOM;
 * `tests/client/hud/messages` runs it under bun.
 */
import { colorOfNode } from "client/state/me";
import { dmThread, peerOfThread } from "client/state/messages";
import { livePeers, type Peer } from "client/state/peers";
import type { MessageView } from "client/threads/crdt/merge";

/** A direct message is at most this long; the rtc frame cap (`MAX_STREAM_TEXT_CHARS`) is 4 KB. */
export const MAX_DM_CHARS = 2_000;
/** A peer unheard over its open channel for longer is away (the rtc worker says hello every 5 s). */
export const DM_PRESENCE_TTL_MS = 20_000;

export type Presence = "online" | "away";

export type DmThreadRow = {
  peerId: string;
  callsign: string;
  color: string;
  presence: Presence;
  /** The newest message in the thread, or null. */
  last: MessageView | null;
  /** Messages in the thread. */
  count: number;
};

/** The thread's messages, oldest first (the board view is already HLC-ordered). */
export function threadMessages(messages: readonly MessageView[], thread: string): MessageView[] {
  return messages.filter((m) => m.thread === thread);
}

/** Team-wide messages: no thread. */
export function teamMessages(messages: readonly MessageView[]): MessageView[] {
  return messages.filter((m) => m.thread === null);
}

/**
 * "online" for a peer whose data channel is open and who was heard over it within DM_PRESENCE_TTL_MS, "away"
 * otherwise. Keystrokes travel only over the channel, so a peer on the server fallback (`link: "relay"`) cannot
 * see a draft and reads as away; a tab that vanished keeps an "open" channel on this side for a while, and the
 * missing heartbeats are what give it away. Committed messages still reach an away peer.
 */
export function presenceOf(peerId: string, peers: readonly Peer[], nowMs: number): Presence {
  return livePeers(peers, nowMs).some((p) => p.peerId === peerId && p.link === "open" && nowMs - Date.parse(p.seenAt) <= DM_PRESENCE_TTL_MS) ? "online" : "away";
}

/** Callsign for a node: a live peer's, else what its last message in `messages` has no record of, so the id's head. */
export function callsignFor(peerId: string, peers: readonly Peer[]): string {
  return peers.find((p) => p.peerId === peerId)?.callsign ?? peerId.slice(0, 8);
}

/**
 * Threads to list: every live peer (so a DM can start), plus every peer this node already has a thread with,
 * online first, then by callsign.
 */
export function threadRows(messages: readonly MessageView[], peers: readonly Peer[], me: string, nowMs: number): DmThreadRow[] {
  const ids = new Set<string>();
  for (const p of livePeers(peers, nowMs)) ids.add(p.peerId);
  for (const m of messages) {
    if (m.thread === null) continue;
    const other = peerOfThread(m.thread, me);
    if (other) ids.add(other);
  }
  const rows = [...ids].map((peerId): DmThreadRow => {
    const mine = threadMessages(messages, dmThread(me, peerId));
    return {
      peerId,
      callsign: callsignFor(peerId, peers),
      color: peers.find((p) => p.peerId === peerId)?.color ?? colorOfNode(peerId),
      presence: presenceOf(peerId, peers, nowMs),
      last: mine.at(-1) ?? null,
      count: mine.length,
    };
  });
  return rows.sort((a, b) => (a.presence === b.presence ? a.callsign.localeCompare(b.callsign) : a.presence === "online" ? -1 : 1));
}
