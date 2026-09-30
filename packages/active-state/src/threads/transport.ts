/**
 * Transports carry `(keyIndex, value)` messages between two threads.
 *
 * `SabTransport` runs a pair of SPSC rings over SharedArrayBuffers, one per
 * direction. `MessageTransport` is the postMessage fallback with the same
 * ordering and delivery semantics. Values must be JSON-serializable: the
 * SAB path encodes them as UTF-8 JSON, and the fallback keeps that contract.
 */
import {
  allocRing,
  CTRL_READ,
  CTRL_WRITE,
  decodeValue,
  encodeValue,
  hasWaitAsync,
  Ring,
  waitChange,
} from "./ring";

export interface Transport {
  send(keyIndex: number, value: unknown): void;
  onMessage(cb: (keyIndex: number, value: unknown) => void): () => void;
  close(): void;
}

export type MessageListener = (keyIndex: number, value: unknown) => void;

/** `"async"` = `Atomics.waitAsync`; `"sync"` = sliced `Atomics.wait` (workers). */
export type WaitMode = "async" | "sync";

export type SabTransportOptions = {
  /** Defaults to `"async"` when `Atomics.waitAsync` exists, else `"sync"`. */
  wait?: WaitMode;
};

/** Longest a sync reader blocks before yielding to the worker event loop. */
const SYNC_SLICE_MS = 8;
const KEEP_ALIVE_MS = 60_000;

function dispatch(
  listeners: Set<MessageListener>,
  keyIndex: number,
  value: unknown,
): void {
  for (const cb of listeners) {
    try {
      cb(keyIndex, value);
    } catch (err) {
      console.error("[active-state/threads] listener threw", err);
    }
  }
}

export class SabTransport implements Transport {
  readonly outgoing: Ring;
  readonly incoming: Ring;
  readonly waitMode: WaitMode;
  private readonly listeners = new Set<MessageListener>();
  private readonly pending: { keyIndex: number; bytes: Uint8Array }[] = [];
  private flushing = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Bun and Node end a worker whose event loop holds only a parked
  // Atomics.waitAsync; a live timer keeps the reader's thread up.
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(
    outgoing: SharedArrayBuffer | Ring,
    incoming: SharedArrayBuffer | Ring,
    options: SabTransportOptions = {},
  ) {
    this.outgoing = outgoing instanceof Ring ? outgoing : new Ring(outgoing);
    this.incoming = incoming instanceof Ring ? incoming : new Ring(incoming);
    this.waitMode = options.wait ?? (hasWaitAsync() ? "async" : "sync");
    if (this.waitMode === "sync" && typeof Atomics.wait !== "function") {
      throw new Error(
        "[active-state/threads] wait: \"sync\" needs Atomics.wait (workers only)",
      );
    }
    // Defer so listeners registered right after construction see every record.
    queueMicrotask(() => this.startReader());
  }

  /** Messages queued because the outgoing ring was full. */
  get backlog(): number {
    return this.pending.length;
  }

  send(keyIndex: number, value: unknown): void {
    if (this.closed) return;
    const bytes = encodeValue(value);
    // Keep order: once anything is queued, everything queues behind it.
    if (this.pending.length > 0 || !this.outgoing.tryWrite(keyIndex, bytes)) {
      this.pending.push({ keyIndex, bytes });
      this.scheduleFlush();
    }
  }

  onMessage(cb: MessageListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.pending.length = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.keepAlive !== null) clearInterval(this.keepAlive);
    // Wake an async reader parked on our incoming ring so it can exit.
    Atomics.notify(this.incoming.ctrl, CTRL_WRITE);
  }

  private flush(): void {
    this.flushing = false;
    if (this.closed) return;
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      if (!this.outgoing.tryWrite(next.keyIndex, next.bytes)) {
        this.scheduleFlush();
        return;
      }
      this.pending.shift();
    }
  }

  /** Retry once the reader advances its cursor (it notifies CTRL_READ). */
  private scheduleFlush(): void {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    const seen = this.outgoing.readCursor;
    void waitChange(this.outgoing.ctrl, CTRL_READ, seen).then(() => this.flush());
  }

  private drain(): void {
    const ring = this.incoming;
    for (let rec = ring.tryRead(); rec !== null; rec = ring.tryRead()) {
      if (this.closed) return;
      dispatch(this.listeners, rec.keyIndex, decodeValue(rec.bytes));
    }
  }

  private startReader(): void {
    if (this.closed) return;
    const ring = this.incoming;
    if (this.waitMode === "async") {
      this.keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);
      const loop = (): void => {
        while (!this.closed) {
          this.drain();
          const seen = ring.writeCursor;
          if (ring.readCursor !== seen) continue;
          const parked = waitChange(ring.ctrl, CTRL_WRITE, seen);
          void parked.then(loop);
          return;
        }
      };
      loop();
      return;
    }
    const loop = (): void => {
      this.timer = null;
      if (this.closed) return;
      this.drain();
      const seen = ring.writeCursor;
      if (ring.readCursor === seen) ring.wait(seen, SYNC_SLICE_MS);
      this.timer = setTimeout(loop, 0);
    };
    loop();
  }
}

/** Anything with a message event stream: MessagePort, Worker, or a worker's `self`. */
export type MessagePortLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(
    type: "message",
    listener: (ev: MessageEvent) => void,
  ): void;
  start?(): void;
  close?(): void;
};

const MESSAGE_TAG = "active-state:msg";

type WireMessage = { t: typeof MESSAGE_TAG; k: number; v: unknown };

export class MessageTransport implements Transport {
  readonly port: MessagePortLike;
  private readonly listeners = new Set<MessageListener>();
  private closed = false;
  private readonly onEvent = (ev: MessageEvent): void => {
    const d = ev.data as WireMessage | null;
    if (!d || typeof d !== "object" || d.t !== MESSAGE_TAG) return;
    dispatch(this.listeners, d.k, d.v);
  };

  constructor(port: MessagePortLike) {
    this.port = port;
    port.addEventListener("message", this.onEvent);
    port.start?.();
  }

  send(keyIndex: number, value: unknown): void {
    if (this.closed) return;
    const msg: WireMessage = { t: MESSAGE_TAG, k: keyIndex, v: value };
    this.port.postMessage(msg);
  }

  onMessage(cb: MessageListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.port.removeEventListener("message", this.onEvent);
    this.port.close?.();
  }
}

export type ChannelHandle =
  | { kind: "sab"; toRemote: SharedArrayBuffer; toLocal: SharedArrayBuffer }
  | { kind: "message"; port: MessagePort };

export type ChannelKind = "sab" | "message";

export type ChannelOptions = SabTransportOptions & {
  /** `"auto"` (default) picks SAB when `sabAvailable()`. */
  transport?: ChannelKind | "auto";
  /** Data bytes per direction, a power of 2. Default 2 MiB. */
  capacity?: number;
};

export type Channel = {
  /** This thread's end. */
  transport: Transport;
  /** Post to the other thread, then `openChannel(handle)` there. */
  handle: ChannelHandle;
  /** Pass as the transfer list when posting `handle`. */
  transfer: Transferable[];
  kind: ChannelKind;
};

/**
 * True when SharedArrayBuffer may be shared with a worker: the page is
 * cross-origin isolated, or the runtime has no such gate (Bun, Node).
 * Browsers that gate SAB define `crossOriginIsolated` as `false`.
 */
export function sabAvailable(): boolean {
  if (typeof SharedArrayBuffer !== "function") return false;
  const isolated = (globalThis as { crossOriginIsolated?: boolean })
    .crossOriginIsolated;
  return isolated !== false;
}

/** Create both ends of a channel: a local Transport and a handle for the other thread. */
export function createChannel(options: ChannelOptions = {}): Channel {
  const want = options.transport ?? "auto";
  const kind: ChannelKind =
    want === "auto" ? (sabAvailable() ? "sab" : "message") : want;
  if (kind === "sab") {
    const toRemote = allocRing(options.capacity);
    const toLocal = allocRing(options.capacity);
    return {
      kind,
      transport: new SabTransport(toRemote, toLocal, options),
      handle: { kind, toRemote, toLocal },
      transfer: [],
    };
  }
  const { port1, port2 } = new MessageChannel();
  return {
    kind,
    transport: new MessageTransport(port1),
    handle: { kind, port: port2 },
    transfer: [port2],
  };
}

/** Open the remote end of a channel from its posted handle. */
export function openChannel(
  handle: ChannelHandle,
  options: SabTransportOptions = {},
): Transport {
  if (handle.kind === "sab") {
    return new SabTransport(handle.toLocal, handle.toRemote, options);
  }
  return new MessageTransport(handle.port);
}
