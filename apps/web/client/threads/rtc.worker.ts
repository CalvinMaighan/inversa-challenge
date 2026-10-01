/**
 * rtc worker (PRD §12 "New tech 3"): owns the peer data channels so main never parses peer traffic. Each
 * `RTCPeerConnection` lives on main (`rtc/peers.ts`); its "ops" channel arrives here transferred
 * (`rtc:attach`) or, where transfer is unsupported, as a relayed channel over a T16 transport (`rtc:relay`).
 *
 * Peer messages are JSON `{type:"ops"|"cursor"|"hello"}` (`rtc/protocol.ts`). Incoming ops go back to main
 * as `rtc:ops`, and main calls the db worker's `applyRemoteOps` over its normal RPC. Chosen over a direct
 * MessageChannel to the db worker because the db worker exists only on the leader tab: follower tabs route
 * db calls through main's BroadcastChannel proxy, and this way both kinds of tab behave the same. One extra
 * structured clone per batch is the cost; a batch is a few hundred bytes.
 */
import { openChannel, type ChannelHandle } from "@calvinjs/active-state/threads";

import { isPeerMessage, isToRtc, MAX_PEER_MESSAGE_CHARS, type FromRtc, type PeerIdentity, type PeerMessage, type StreamMessage } from "./rtc/protocol";
import { RelayClient, RelayedChannel, type ChannelLike } from "./rtc/relay";
import { admitInbound, RateLimit } from "./rtc/stream";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const post = (m: FromRtc) => scope.postMessage(m);

type Link = { peerId: string; channel: ChannelLike; relayed: boolean; deltas: RateLimit };

const links = new Map<string, Link>();
let me: PeerIdentity | null = null;
let relay: RelayClient | null = null;
let blocked = false;

const openLinks = () => [...links.values()].filter((l) => l.channel.readyState === "open");

function stats(): void {
  post({ t: "rtc:stats", open: openLinks().length });
}

/**
 * Liveness over the channel: a `hello` every HELLO_MS to each open link. Chrome does not tell the other side
 * when a tab vanishes (no close alert; ICE consent can take a minute to fail), so a peer's `seenAt` is what the
 * DM panel's presence reads (`hud/messages/model.ts`), and a heartbeat keeps it honest within seconds.
 */
const HELLO_MS = 5_000;
setInterval(() => {
  if (!me || blocked) return;
  const text = JSON.stringify({ type: "hello", me } satisfies PeerMessage);
  for (const l of openLinks()) l.channel.send(text);
}, HELLO_MS);

function sendAll(msg: PeerMessage): void {
  if (blocked) return;
  const text = JSON.stringify(msg);
  let relayed = false;
  for (const l of openLinks()) {
    if (l.relayed) relayed = true;
    else l.channel.send(text);
  }
  if (relayed) relay?.broadcast(text);
}

function sendTo(peerId: string, msg: PeerMessage): void {
  if (blocked) return;
  const l = links.get(peerId);
  if (l?.channel.readyState === "open") l.channel.send(JSON.stringify(msg));
}

/**
 * A stream message from a peer, with `from` set to the channel it came on (a peer cannot speak as another), a
 * `to` that must be this node, and deltas capped at MAX_DELTAS_PER_SECOND per peer. Dropped deltas leave a seq
 * gap, and main answers a gap with a `stream.resync`, so a flood costs one sync instead of a frozen tab.
 */
function receiveStream(link: Link, msg: StreamMessage): void {
  if (!me) return;
  const admitted = admitInbound(msg, link.peerId, me.nodeId, link.deltas, Date.now());
  if (admitted) post({ t: "rtc:peer-stream", peerId: link.peerId, msg: admitted });
}

function receive(peerId: string, data: unknown): void {
  if (typeof data !== "string" || data.length > MAX_PEER_MESSAGE_CHARS) return;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (!isPeerMessage(msg)) return;
  switch (msg.type) {
    case "ops":
      if (!blocked) post({ t: "rtc:ops", peerId, boardId: msg.boardId, ops: msg.ops });
      return;
    case "cursor":
      post({ t: "rtc:peer-cursor", peerId, lon: msg.lon, lat: msg.lat });
      return;
    case "hello":
      post({ t: "rtc:peer-hello", peerId, me: msg.me });
      return;
    default: {
      const link = links.get(peerId);
      if (link && !blocked) receiveStream(link, msg);
      return;
    }
  }
}

function wire(peerId: string, channel: ChannelLike, relayed: boolean): void {
  detach(peerId);
  const link: Link = { peerId, channel, relayed, deltas: new RateLimit() };
  links.set(peerId, link);
  channel.onopen = () => {
    if (me) channel.send(JSON.stringify({ type: "hello", me } satisfies PeerMessage));
    post({ t: "rtc:open", peerId });
    stats();
  };
  channel.onmessage = (ev) => receive(peerId, ev.data);
  channel.onclose = () => {
    if (links.get(peerId) === link) links.delete(peerId);
    post({ t: "rtc:closed", peerId });
    stats();
  };
  channel.onerror = () => {
    // The close event follows; nothing to do here beyond not crashing the worker.
  };
  if (channel.readyState === "open") channel.onopen(new Event("open"));
}

function detach(peerId: string): void {
  const link = links.get(peerId);
  if (!link) return;
  links.delete(peerId);
  link.channel.onopen = link.channel.onmessage = link.channel.onclose = null;
  link.channel.close();
}

scope.addEventListener("message", (ev: MessageEvent) => {
  const m = ev.data as unknown;
  if (!isToRtc(m)) return;
  switch (m.t) {
    case "rtc:hello":
      me = m.me;
      for (const l of openLinks()) l.channel.send(JSON.stringify({ type: "hello", me } satisfies PeerMessage));
      return;
    case "rtc:attach":
      wire(m.peerId, m.channel, false);
      return;
    case "rtc:relay":
      relay?.close();
      relay = new RelayClient(openChannel(m.handle as ChannelHandle), (ch: RelayedChannel) => wire(ch.peerId, ch, true));
      return;
    case "rtc:detach":
      detach(m.peerId);
      return;
    case "rtc:broadcast":
      sendAll({ type: "ops", boardId: m.boardId, ops: m.ops });
      return;
    case "rtc:cursor":
      sendAll({ type: "cursor", lon: m.lon, lat: m.lat });
      return;
    case "rtc:send":
      if (m.to === null) sendAll(m.msg);
      else sendTo(m.to, m.msg);
      return;
    case "rtc:block":
      blocked = m.on;
      return;
  }
});
