/** In-memory stand-ins for RTCPeerConnection and the C9 signaling Worker, for the mesh lifecycle tests. */
import type { PcLike } from "client/threads/rtc/mesh";
import type { Signaling, SignalKind, SignalMessage, SignalPeer } from "client/threads/rtc/signal";

export type FakeChannel = { label: string; init: RTCDataChannelInit | undefined; owner: string };

/**
 * Enough of the JSEP state machine to exercise perfect negotiation: implicit offers and answers, rollback
 * when an offer lands on a pending local offer, and "connected" once an offer/answer pair completed.
 */
export class FakePc implements PcLike<FakeChannel> {
  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  onnegotiationneeded: ((ev: Event) => void) | null = null;
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: ((ev: Event) => void) | null = null;
  rollbacks = 0;
  offers = 0;
  answers = 0;
  candidates: RTCIceCandidateInit[] = [];
  closed = false;

  constructor(readonly id: string) {}

  createDataChannel(label: string, init?: RTCDataChannelInit): FakeChannel {
    // Browsers fire negotiationneeded from a queued task, after the caller wired its handlers, and only
    // while stable; a channel negotiated inside a remote offer needs no further round.
    queueMicrotask(() => {
      if (this.signalingState === "stable") this.onnegotiationneeded?.(new Event("negotiationneeded"));
    });
    return { label, init, owner: this.id };
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    if (desc) {
      this.localDescription = desc;
      this.signalingState = desc.type === "offer" ? "have-local-offer" : "stable";
      return;
    }
    if (this.signalingState === "have-remote-offer") {
      this.answers += 1;
      this.localDescription = { type: "answer", sdp: `answer:${this.id}:${this.answers}` };
      this.signalingState = "stable";
      this.connect();
      return;
    }
    if (this.signalingState !== "stable") throw new Error(`InvalidStateError: offer while ${this.signalingState}`);
    this.offers += 1;
    this.localDescription = { type: "offer", sdp: `offer:${this.id}:${this.offers}` };
    this.signalingState = "have-local-offer";
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc.type === "offer") {
      if (this.signalingState === "have-local-offer") {
        this.rollbacks += 1; // implicit rollback: the pending local offer is discarded
        this.localDescription = null;
      } else if (this.signalingState !== "stable") throw new Error(`InvalidStateError: remote offer while ${this.signalingState}`);
      this.signalingState = "have-remote-offer";
      return;
    }
    if (this.signalingState !== "have-local-offer") throw new Error(`InvalidStateError: answer while ${this.signalingState}`);
    this.signalingState = "stable";
    this.connect();
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (this.signalingState === "stable" && !this.localDescription) throw new Error("InvalidStateError: no remote description");
    if (candidate) this.candidates.push(candidate);
  }

  private connect(): void {
    if (this.connectionState === "connected") return;
    this.connectionState = "connected";
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
  }

  /** Test hook: the transport died. */
  fail(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

/** The C9 Worker, minus HTTP: per-room peer lists and per-peer inboxes that drain on read. */
export class FakeSignaling implements Signaling {
  readonly peers = new Map<string, Map<string, SignalPeer>>();
  readonly inboxes = new Map<string, SignalMessage[]>();
  readonly log: { room: string; to: string; from: string; kind: SignalKind }[] = [];
  now = 1_000;

  private inbox(room: string, peer: string): SignalMessage[] {
    const key = `${room}/${peer}`;
    let box = this.inboxes.get(key);
    if (!box) this.inboxes.set(key, (box = []));
    return box;
  }

  async announce(room: string, peerId: string, name: string): Promise<void> {
    let list = this.peers.get(room);
    if (!list) this.peers.set(room, (list = new Map()));
    list.set(peerId, { peerId, name, seenAt: this.now });
  }

  async listPeers(room: string): Promise<SignalPeer[]> {
    return [...(this.peers.get(room)?.values() ?? [])];
  }

  async send(room: string, to: string, from: string, kind: SignalKind, payload: unknown): Promise<void> {
    this.log.push({ room, to, from, kind });
    this.inbox(room, to).push({ from, kind, payload, sentAt: this.now });
  }

  async drain(room: string, peerId: string): Promise<SignalMessage[]> {
    return this.inbox(room, peerId).splice(0);
  }

  async iceServers() {
    return [{ urls: ["stun:fake"] }];
  }

  /** Messages waiting anywhere in the room. */
  waiting(room: string): number {
    let n = 0;
    for (const [key, box] of this.inboxes) if (key.startsWith(`${room}/`)) n += box.length;
    return n;
  }
}

/** Let queued microtasks (negotiationneeded, async handlers) run. */
export const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};
