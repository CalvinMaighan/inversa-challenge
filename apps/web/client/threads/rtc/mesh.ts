/**
 * Peer mesh lifecycle (PRD §12 "New tech 3"): one session per listed peer, at most `maxPeers`, negotiated
 * with the "polite peer" pattern so two sides offering at once (glare) settle without a retry. The
 * RTCPeerConnection surface is injected (`createPc`) and the signaling is the C9 client, so the whole state
 * machine runs under bun against fakes.
 *
 * Both ends create the "ops" channel as `negotiated: true, id: 0`: whoever's offer wins, there is exactly
 * one channel and neither side waits for `ondatachannel`.
 */
import type { Signaling, SignalMessage, SignalPeer } from "./signal";

export const MAX_PEERS = 8;
export const OPS_CHANNEL_LABEL = "ops";

export type SessionState = "connecting" | "connected" | "failed" | "closed";

/** The subset of RTCPeerConnection the mesh drives. `C` is the data channel type it hands out. */
export type PcLike<C> = {
  readonly signalingState: RTCSignalingState;
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: RTCSessionDescriptionInit | null;
  createDataChannel(label: string, init?: RTCDataChannelInit): C;
  setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void>;
  close(): void;
  onnegotiationneeded: ((ev: Event) => void) | null;
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null;
  onconnectionstatechange: ((ev: Event) => void) | null;
};

export type MeshOptions<C> = {
  me: string;
  room: string;
  signal: Signaling;
  createPc: () => PcLike<C>;
  /** A new session's channel, before it opens (so it can still be transferred). */
  onChannel: (peerId: string, channel: C) => void;
  onState: (peerId: string, state: SessionState) => void;
  onError?: (peerId: string, err: unknown) => void;
  maxPeers?: number;
};

/** Deterministic role: the lower id yields on glare. */
export function isPolite(me: string, other: string): boolean {
  return me < other;
}

class Session<C> {
  state: SessionState = "connecting";
  makingOffer = false;
  ignoreOffer = false;
  /** Rollbacks performed on glare (diagnostics and tests). */
  rollbacks = 0;
  readonly channel: C;

  constructor(
    readonly peerId: string,
    readonly polite: boolean,
    readonly pc: PcLike<C>,
    private readonly o: MeshOptions<C>,
  ) {
    this.channel = pc.createDataChannel(OPS_CHANNEL_LABEL, { negotiated: true, id: 0, ordered: true });
    pc.onnegotiationneeded = () => void this.negotiate();
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.send("ice", ev.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case "connected":
          this.setState("connected");
          return;
        case "failed":
          this.setState("failed");
          return;
        case "closed":
          this.setState("closed");
          return;
        default:
          // "connecting" and "disconnected" may still recover; ICE keeps trying.
          return;
      }
    };
  }

  private setState(state: SessionState): void {
    if (this.state === state || this.state === "closed") return;
    this.state = state;
    this.o.onState(this.peerId, state);
  }

  private send(kind: "offer" | "answer" | "ice", payload: unknown): void {
    this.o.signal.send(this.o.room, this.peerId, this.o.me, kind, payload).catch((err: unknown) => this.o.onError?.(this.peerId, err));
  }

  private async negotiate(): Promise<void> {
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) this.send("offer", this.pc.localDescription);
    } catch (err) {
      this.o.onError?.(this.peerId, err);
    } finally {
      this.makingOffer = false;
    }
  }

  /** Perfect negotiation (w3c "Perfect Negotiation" example), one signaling message at a time. */
  async handle(msg: SignalMessage): Promise<void> {
    const pc = this.pc;
    if (msg.kind === "ice") {
      try {
        await pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
      } catch (err) {
        if (!this.ignoreOffer) this.o.onError?.(this.peerId, err);
      }
      return;
    }
    const desc = msg.payload as RTCSessionDescriptionInit;
    const collision = desc.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    if (collision) this.rollbacks += 1;
    try {
      await pc.setRemoteDescription(desc); // the polite side's pending offer rolls back implicitly
      if (desc.type === "offer") {
        await pc.setLocalDescription();
        if (pc.localDescription) this.send("answer", pc.localDescription);
      }
    } catch (err) {
      this.o.onError?.(this.peerId, err);
    }
  }

  close(): void {
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
    this.setState("closed");
  }
}

export class Mesh<C> {
  private readonly sessions = new Map<string, Session<C>>();
  private readonly max: number;
  private closed = false;

  constructor(private readonly o: MeshOptions<C>) {
    this.max = o.maxPeers ?? MAX_PEERS;
  }

  /** Sessions in progress, any state. */
  peerIds(): string[] {
    return [...this.sessions.keys()];
  }

  stateOf(peerId: string): SessionState | null {
    return this.sessions.get(peerId)?.state ?? null;
  }

  rollbacksOf(peerId: string): number {
    return this.sessions.get(peerId)?.rollbacks ?? 0;
  }

  /** True while any handshake is in flight: the inbox must be polled. */
  pending(): boolean {
    for (const s of this.sessions.values()) if (s.state === "connecting") return true;
    return false;
  }

  /**
   * Bring the sessions in line with the room's peer list: drop sessions for peers that left (unless still
   * connected; their heartbeat may just be late), forget failed ones so they retry, open the missing ones.
   */
  reconcile(list: readonly SignalPeer[]): void {
    if (this.closed) return;
    const listed = new Set(list.map((p) => p.peerId).filter((id) => id !== this.o.me));
    for (const [id, s] of this.sessions) {
      if (s.state === "failed" || s.state === "closed" || (!listed.has(id) && s.state !== "connected")) {
        s.close();
        this.sessions.delete(id);
      }
    }
    for (const id of listed) {
      if (this.sessions.size >= this.max) break;
      if (!this.sessions.has(id)) this.open(id);
    }
  }

  /** A signaling message for us. An offer from a stranger opens a session (they found us first). */
  async deliver(msg: SignalMessage): Promise<void> {
    if (this.closed || msg.from === this.o.me) return;
    let s = this.sessions.get(msg.from);
    if (!s) {
      if (msg.kind !== "offer" || this.sessions.size >= this.max) return;
      s = this.open(msg.from);
    }
    await s.handle(msg);
  }

  private open(peerId: string): Session<C> {
    const s = new Session(peerId, isPolite(this.o.me, peerId), this.o.createPc(), this.o);
    this.sessions.set(peerId, s);
    this.o.onChannel(peerId, s.channel);
    this.o.onState(peerId, "connecting");
    return s;
  }

  drop(peerId: string): void {
    const s = this.sessions.get(peerId);
    if (!s) return;
    s.close();
    this.sessions.delete(peerId);
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }
}
