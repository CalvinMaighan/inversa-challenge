/**
 * Relay framing for browsers that cannot transfer an RTCDataChannel to a worker (Firefox). Main keeps the
 * channels and forwards their text over one T16 `Transport`; the rtc worker sees the same `ChannelLike`
 * surface it gets from a transferred channel. Frames are `(keyIndex, {peerId, text?})`:
 *
 *   IN    main -> worker   a message from `peerId`
 *   OUT   worker -> main   send `text` to `peerId` ("*" broadcasts)
 *   OPEN  main -> worker   `peerId`'s channel opened
 *   CLOSE either direction `peerId`'s channel closed (worker -> main asks main to close it)
 */
import type { Transport } from "@calvinjs/active-state/threads";

export const RELAY_IN = 0;
export const RELAY_OUT = 1;
export const RELAY_OPEN = 2;
export const RELAY_CLOSE = 3;
export const BROADCAST = "*";

export type RelayFrame = { peerId: string; text?: string };

export function isRelayFrame(v: unknown): v is RelayFrame {
  return Boolean(v) && typeof v === "object" && typeof (v as RelayFrame).peerId === "string" && ((v as RelayFrame).text === undefined || typeof (v as RelayFrame).text === "string");
}

/** What the worker needs from a data channel, transferred or relayed. RTCDataChannel satisfies it. */
export type ChannelLike = {
  readonly readyState: string;
  send(text: string): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: Event) => void) | null;
  onerror?: ((ev: RTCErrorEvent) => void) | null;
};

/** Main side: owns the real channels, forwards frames both ways. */
export class RelayHost {
  private readonly channels = new Map<string, ChannelLike>();
  private readonly off: () => void;

  constructor(private readonly transport: Transport) {
    this.off = transport.onMessage((k, v) => {
      if (!isRelayFrame(v)) return;
      if (k === RELAY_OUT && v.text !== undefined) {
        if (v.peerId === BROADCAST) for (const ch of this.channels.values()) this.sendTo(ch, v.text);
        else {
          const ch = this.channels.get(v.peerId);
          if (ch) this.sendTo(ch, v.text);
        }
      } else if (k === RELAY_CLOSE) {
        this.detach(v.peerId);
      }
    });
  }

  private sendTo(ch: ChannelLike, text: string): void {
    if (ch.readyState === "open") ch.send(text);
  }

  attach(peerId: string, ch: ChannelLike): void {
    this.detach(peerId);
    this.channels.set(peerId, ch);
    ch.onopen = () => this.transport.send(RELAY_OPEN, { peerId } satisfies RelayFrame);
    ch.onmessage = (ev) => {
      if (typeof ev.data === "string") this.transport.send(RELAY_IN, { peerId, text: ev.data } satisfies RelayFrame);
    };
    ch.onclose = () => {
      if (this.channels.get(peerId) === ch) this.channels.delete(peerId);
      this.transport.send(RELAY_CLOSE, { peerId } satisfies RelayFrame);
    };
    if (ch.readyState === "open") ch.onopen(new Event("open"));
  }

  detach(peerId: string): void {
    const ch = this.channels.get(peerId);
    if (!ch) return;
    this.channels.delete(peerId);
    ch.onopen = ch.onmessage = ch.onclose = null;
    ch.close();
  }

  size(): number {
    return this.channels.size;
  }

  close(): void {
    this.off();
    for (const id of [...this.channels.keys()]) this.detach(id);
  }
}

/** Worker side: a `ChannelLike` per relayed peer, backed by frames. */
export class RelayedChannel implements ChannelLike {
  readyState: "connecting" | "open" | "closed" = "connecting";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  onerror: ((ev: RTCErrorEvent) => void) | null = null;

  constructor(
    readonly peerId: string,
    private readonly transport: Transport,
    /** Drops this channel from its client's table. */
    private readonly release: () => void = () => {},
  ) {}

  send(text: string): void {
    if (this.readyState === "open") this.transport.send(RELAY_OUT, { peerId: this.peerId, text } satisfies RelayFrame);
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.release();
    this.transport.send(RELAY_CLOSE, { peerId: this.peerId } satisfies RelayFrame);
    this.onclose?.(new Event("close"));
  }

  /** @internal frames from the host */
  opened(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }

  /** @internal */
  received(text: string): void {
    this.onmessage?.(new MessageEvent("message", { data: text }));
  }

  /** @internal */
  closedByHost(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
  }
}

export class RelayClient {
  private readonly channels = new Map<string, RelayedChannel>();
  private readonly off: () => void;

  constructor(
    private readonly transport: Transport,
    private readonly onOpen: (ch: RelayedChannel) => void,
  ) {
    this.off = transport.onMessage((k, v) => {
      if (!isRelayFrame(v)) return;
      if (k === RELAY_OPEN) {
        let ch = this.channels.get(v.peerId);
        if (!ch) {
          const fresh = new RelayedChannel(v.peerId, transport, () => {
            if (this.channels.get(v.peerId) === fresh) this.channels.delete(v.peerId);
          });
          ch = fresh;
          this.channels.set(v.peerId, ch);
          this.onOpen(ch);
        }
        ch.opened();
      } else if (k === RELAY_IN && v.text !== undefined) {
        this.channels.get(v.peerId)?.received(v.text);
      } else if (k === RELAY_CLOSE) {
        const ch = this.channels.get(v.peerId);
        if (ch) {
          this.channels.delete(v.peerId);
          ch.closedByHost();
        }
      }
    });
  }

  /** One frame to every relayed peer, instead of one per channel. */
  broadcast(text: string): void {
    if (this.channels.size > 0) this.transport.send(RELAY_OUT, { peerId: BROADCAST, text } satisfies RelayFrame);
  }

  size(): number {
    return this.channels.size;
  }

  close(): void {
    this.off();
    for (const ch of this.channels.values()) ch.closedByHost();
    this.channels.clear();
  }
}
