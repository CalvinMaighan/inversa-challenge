/**
 * Main-thread side of team realtime (PRD §12 "New tech 3"). Runs the signaling loop against the C9 Worker,
 * keeps every `RTCPeerConnection` on main (the mesh), hands each "ops" channel to the rtc worker, and
 * writes PEERS. Room = board id; announce every 20 s; poll the inbox every 500 ms only while a handshake
 * is pending.
 *
 * The channel goes to the worker transferred where the browser allows it (Chrome/Edge 130+, Safari 15+).
 * Where `postMessage` refuses (Firefox) main keeps the channel and relays its text through a T16 channel
 * (`relay.ts`); the worker sees the same interface either way.
 */
import { get, set, subscribe } from "@calvinjs/active-state";
import { createChannel, type Channel } from "@calvinjs/active-state/threads";

import { onGlobeReady, type GeoPoint } from "client/globe/api";
import { ME, PEER_COLORS, type MeState } from "client/state/me";
import { PEERS, type Peer } from "client/state/peers";
import type { Op } from "client/threads/crdt/types";
import type { Threads } from "client/threads/boot";

import { Mesh, type SessionState } from "./mesh";
import { isFromRtc, type PeerIdentity, type ToRtc } from "./protocol";
import { RelayHost } from "./relay";
import { createSignaling, resolveSignalUrl, type IceServer, type Signaling, type SignalPeer } from "./signal";

export const ANNOUNCE_MS = 20_000;
export const POLL_MS = 500;
/** Cursor updates to peers, at most this often. */
export const CURSOR_MS = 100;
const STUN_ONLY: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
/** C9's name cap; also what a peer may call itself over the channel. */
const MAX_CALLSIGN_CHARS = 64;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export type TeamLink = {
  readonly boardId: string;
  readonly nodeId: string;
  /** Fan a local op batch out to every open channel. */
  broadcast(ops: Op[]): void;
  /** Test hook: stop all peer traffic so edits must take the WebSocket path. */
  setBlocked(on: boolean): void;
  /** Fires with ops a peer delivered over a data channel, after they were handed to the db worker. */
  onRemoteOps(cb: (ops: Op[]) => void): () => void;
  peers(): Peer[];
  close(): void;
};

export type StartPeersOptions = {
  boardId: string;
  me: MeState;
  threads: Threads;
  signalUrl?: string;
  signaling?: Signaling;
  createWorker?: () => Worker;
  now?: () => number;
};

const iso = (ms: number) => new Date(ms).toISOString();

function identity(me: MeState): PeerIdentity {
  return { nodeId: me.nodeId, callsign: me.callsign, color: me.color };
}

export function startPeers(o: StartPeersOptions): TeamLink {
  const { boardId, threads } = o;
  const nodeId = o.me.nodeId;
  if (!nodeId) throw new Error("startPeers: ME.nodeId is empty");
  const now = o.now ?? (() => Date.now());
  const signal = o.signaling ?? createSignaling(resolveSignalUrl(o.signalUrl ?? process.env.NEXT_PUBLIC_SIGNAL_URL));
  const worker = o.createWorker ? o.createWorker() : new Worker(new URL("../rtc.worker.ts", import.meta.url), { type: "module", name: "inversa-rtc" });
  const remoteListeners = new Set<(ops: Op[]) => void>();
  let ice: IceServer[] = STUN_ONLY;
  let relay: { channel: Channel; host: RelayHost } | null = null;
  let closed = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;

  const post = (m: ToRtc, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? []);
  post({ t: "rtc:hello", me: identity(o.me) });

  // ---- PEERS -------------------------------------------------------------------------------------------

  const patchPeer = (peerId: string, patch: Partial<Peer>) => {
    set<Peer[]>(PEERS, (prev = []) => {
      const i = prev.findIndex((p) => p.peerId === peerId);
      if (i < 0) {
        const fresh: Peer = { peerId, callsign: peerId.slice(0, 8), color: PEER_COLORS[PEER_COLORS.length - 1], seenAt: iso(now()), cursor: null, link: "connecting", ...patch };
        return [...prev, fresh];
      }
      const next = prev.slice();
      next[i] = { ...prev[i]!, ...patch };
      return next;
    });
  };
  const removePeer = (peerId: string) => set<Peer[]>(PEERS, (prev = []) => prev.filter((p) => p.peerId !== peerId));

  // ---- channels to the worker -------------------------------------------------------------------------

  const attach = (peerId: string, channel: RTCDataChannel) => {
    if (!relay) {
      try {
        post({ t: "rtc:attach", peerId, channel }, [channel as unknown as Transferable]);
        return;
      } catch {
        // DataCloneError: this browser cannot transfer RTCDataChannel. Relay from now on.
        console.info("[rtc] RTCDataChannel is not transferable here; relaying through main");
        const ch = createChannel({ transport: threads.transport });
        post({ t: "rtc:relay", handle: ch.handle }, ch.transfer);
        relay = { channel: ch, host: new RelayHost(ch.transport) };
      }
    }
    relay.host.attach(peerId, channel);
  };

  const onState = (peerId: string, state: SessionState) => {
    switch (state) {
      case "connecting":
        patchPeer(peerId, { link: "connecting" });
        return;
      case "connected":
        return; // the channel's own open event flips the link
      case "failed":
        patchPeer(peerId, { link: "relay" }); // reachable through the server only
        post({ t: "rtc:detach", peerId });
        relay?.host.detach(peerId);
        return;
      case "closed":
        post({ t: "rtc:detach", peerId });
        relay?.host.detach(peerId);
        removePeer(peerId);
        return;
    }
  };

  const mesh = new Mesh<RTCDataChannel>({
    me: nodeId,
    room: boardId,
    signal,
    createPc: () => new RTCPeerConnection({ iceServers: ice }),
    onChannel: attach,
    onState,
    onError: (peerId, err) => console.warn("[rtc] peer", peerId, err),
  });

  worker.addEventListener("error", (ev) => console.error("[rtc] worker error", ev.message || ev));
  worker.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data as unknown;
    if (!isFromRtc(m)) return;
    switch (m.t) {
      case "rtc:open":
        patchPeer(m.peerId, { link: "open", seenAt: iso(now()) });
        return;
      case "rtc:closed":
        if (mesh.stateOf(m.peerId) !== null) patchPeer(m.peerId, { link: "relay" });
        return;
      case "rtc:ops":
        patchPeer(m.peerId, { seenAt: iso(now()) });
        threads
          .db("applyRemoteOps", { boardId: m.boardId, ops: m.ops })
          .then(() => {
            for (const cb of remoteListeners) cb(m.ops);
          })
          .catch((err: unknown) => console.warn("[rtc] applyRemoteOps", err));
        return;
      case "rtc:peer-hello": {
        // Peer-supplied: bound the name, accept only a hex colour.
        const callsign = typeof m.me.callsign === "string" && m.me.callsign.trim() ? m.me.callsign.trim().slice(0, MAX_CALLSIGN_CHARS) : m.peerId.slice(0, 8);
        const color = typeof m.me.color === "string" && HEX_COLOR.test(m.me.color) ? m.me.color : PEER_COLORS[PEER_COLORS.length - 1];
        patchPeer(m.peerId, { callsign, color, seenAt: iso(now()) });
        return;
      }
      case "rtc:peer-cursor": {
        const onGlobe = typeof m.lon === "number" && typeof m.lat === "number" && Math.abs(m.lon) <= 180 && Math.abs(m.lat) <= 90;
        patchPeer(m.peerId, { cursor: onGlobe ? { lon: m.lon as number, lat: m.lat as number } : null, seenAt: iso(now()) });
        return;
      }
      case "rtc:stats":
        return;
    }
  });

  // ---- signaling loop ---------------------------------------------------------------------------------

  const drain = async () => {
    const inbox = await signal.drain(boardId, nodeId);
    for (const msg of inbox) await mesh.deliver(msg);
  };

  const poll = async () => {
    pollTimer = null;
    if (closed) return;
    try {
      await drain();
    } catch (err) {
      console.warn("[rtc] inbox poll", err);
    }
    if (closed) return;
    if (mesh.pending()) pollTimer = setTimeout(() => void poll(), POLL_MS);
    else polling = false;
  };

  /** Poll while any handshake is pending; idle otherwise. */
  const ensurePolling = () => {
    if (polling || closed || !mesh.pending()) return;
    polling = true;
    pollTimer = setTimeout(() => void poll(), POLL_MS);
  };

  const mergeList = (list: SignalPeer[]) => {
    for (const p of list) {
      if (p.peerId === nodeId || mesh.stateOf(p.peerId) === null) continue;
      patchPeer(p.peerId, { callsign: (p.name || p.peerId.slice(0, 8)).slice(0, MAX_CALLSIGN_CHARS), seenAt: iso(p.seenAt) });
    }
  };

  const announce = async () => {
    announceTimer = null;
    if (closed) return;
    try {
      const me = get<MeState>(ME) ?? o.me;
      await signal.announce(boardId, nodeId, (me.callsign || nodeId).slice(0, MAX_CALLSIGN_CHARS));
      const list = await signal.listPeers(boardId);
      mesh.reconcile(list);
      mergeList(list);
      // A stranger's offer may be waiting: one drain per announce keeps discovery within the announce period.
      await drain();
    } catch (err) {
      console.warn("[rtc] announce", err);
    }
    if (closed) return;
    ensurePolling();
    announceTimer = setTimeout(() => void announce(), ANNOUNCE_MS);
  };

  void signal
    .iceServers()
    .then((servers) => {
      if (servers.length) ice = servers;
    })
    .catch(() => {})
    .then(() => announce());

  // ---- identity and cursor ----------------------------------------------------------------------------

  const offMe = subscribe(ME, () => {
    const me = get<MeState>(ME);
    if (me?.nodeId === nodeId) post({ t: "rtc:hello", me: identity(me) });
  });

  let lastCursor: GeoPoint | null | undefined;
  let cursorAt = 0;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  const sendCursor = (at: GeoPoint | null) => {
    lastCursor = at;
    const wait = CURSOR_MS - (now() - cursorAt);
    if (cursorTimer) return;
    cursorTimer = setTimeout(
      () => {
        cursorTimer = null;
        cursorAt = now();
        post({ t: "rtc:cursor", lon: lastCursor?.lon ?? null, lat: lastCursor?.lat ?? null });
      },
      Math.max(0, wait),
    );
  };
  let offCursor: (() => void) | null = null;
  const offGlobe = onGlobeReady((api) => {
    offCursor?.();
    offCursor = api.onCursor?.(sendCursor) ?? null;
  });

  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("pagehide", close);
    if (announceTimer) clearTimeout(announceTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (cursorTimer) clearTimeout(cursorTimer);
    offMe();
    offGlobe();
    offCursor?.();
    mesh.close();
    relay?.host.close();
    relay?.channel.transport.close();
    worker.terminate();
    set<Peer[]>(PEERS, []);
  };
  window.addEventListener("pagehide", close);

  return {
    boardId,
    nodeId,
    broadcast: (ops) => post({ t: "rtc:broadcast", boardId, ops }),
    setBlocked: (on) => post({ t: "rtc:block", on }),
    onRemoteOps(cb) {
      remoteListeners.add(cb);
      return () => {
        remoteListeners.delete(cb);
      };
    },
    peers: () => get<Peer[]>(PEERS) ?? [],
    close,
  };
}
