/**
 * SPSC byte ring over a SharedArrayBuffer.
 *
 * Layout of one buffer:
 *   ctrl  Int32Array[2 + 256] = [writeCursor, readCursor, keyVersion × 256]
 *   data  Uint8Array[capacity], capacity a power of 2
 *
 * Record: u16 keyIndex, u32 len, then `len` bytes (little-endian header).
 * A record never straddles the wrap. When it does not fit at the tail the
 * writer stores the pad marker `0xFFFF` as a u16 (when 2 bytes remain) and
 * continues at offset 0. Readers treat a tail shorter than 2 bytes as an
 * implicit pad.
 *
 * One writer thread, one reader thread. Cursors are offsets in [0, capacity).
 * The ring is empty when the cursors are equal, so a write never lands the
 * write cursor on the read cursor: that keeps one byte free and makes "full"
 * unambiguous. `tryWrite` returns false instead of overwriting.
 */
declare const MAX_KEYS = 256;
declare const PAD_MARKER = 65535;
declare const CTRL_WRITE = 0;
declare const CTRL_READ = 1;
declare const CTRL_VERSION = 2;
/** Bytes of the control block that precedes the data region. */
declare const CTRL_BYTES: number;
declare const MIN_CAPACITY = 64;
/** 2 MiB per direction: a 1 MB JSON value fits with room to spare. */
declare const DEFAULT_CAPACITY: number;
type RingRecord = {
    keyIndex: number;
    bytes: Uint8Array;
};
/** Allocate a SharedArrayBuffer sized for a control block plus `capacity` data bytes. */
declare function allocRing(capacity?: number): SharedArrayBuffer;
declare class Ring {
    readonly buffer: SharedArrayBuffer;
    readonly ctrl: Int32Array;
    readonly data: Uint8Array;
    readonly capacity: number;
    /** Largest payload `tryWrite` accepts. */
    readonly maxBytes: number;
    private readonly view;
    private readonly mask;
    constructor(buffer: SharedArrayBuffer);
    get writeCursor(): number;
    get readCursor(): number;
    /** Number of writes seen for `keyIndex` (wraps at 2^31). */
    version(keyIndex: number): number;
    isEmpty(): boolean;
    /**
     * Append one record. Returns false when the ring lacks room; nothing is
     * written in that case. Throws when the payload can never fit.
     */
    tryWrite(keyIndex: number, bytes: Uint8Array): boolean;
    /** Pop one record, copying its bytes out of shared memory. Null when empty. */
    tryRead(): RingRecord | null;
    /** Block until the write cursor moves away from `seen` (workers only). */
    wait(seen: number, timeoutMs?: number): "ok" | "not-equal" | "timed-out";
}
/** JSON encode; `undefined` becomes an empty payload. */
declare function encodeValue(value: unknown): Uint8Array;
declare function decodeValue(bytes: Uint8Array): unknown;
declare function hasWaitAsync(): boolean;
/**
 * Resolve once `arr[index]` differs from `seen`, or after `timeoutMs`.
 * Uses `Atomics.waitAsync` when present, else a short poll (never blocks).
 */
declare function waitChange(arr: Int32Array, index: number, seen: number, timeoutMs?: number): Promise<void>;

/**
 * Transports carry `(keyIndex, value)` messages between two threads.
 *
 * `SabTransport` runs a pair of SPSC rings over SharedArrayBuffers, one per
 * direction. `MessageTransport` is the postMessage fallback with the same
 * ordering and delivery semantics. Values must be JSON-serializable: the
 * SAB path encodes them as UTF-8 JSON, and the fallback keeps that contract.
 */

interface Transport {
    send(keyIndex: number, value: unknown): void;
    onMessage(cb: (keyIndex: number, value: unknown) => void): () => void;
    close(): void;
}
type MessageListener = (keyIndex: number, value: unknown) => void;
/** `"async"` = `Atomics.waitAsync`; `"sync"` = sliced `Atomics.wait` (workers). */
type WaitMode = "async" | "sync";
type SabTransportOptions = {
    /** Defaults to `"async"` when `Atomics.waitAsync` exists, else `"sync"`. */
    wait?: WaitMode;
};
declare class SabTransport implements Transport {
    readonly outgoing: Ring;
    readonly incoming: Ring;
    readonly waitMode: WaitMode;
    private readonly listeners;
    private readonly pending;
    private flushing;
    private closed;
    private timer;
    private keepAlive;
    constructor(outgoing: SharedArrayBuffer | Ring, incoming: SharedArrayBuffer | Ring, options?: SabTransportOptions);
    /** Messages queued because the outgoing ring was full. */
    get backlog(): number;
    send(keyIndex: number, value: unknown): void;
    onMessage(cb: MessageListener): () => void;
    close(): void;
    private flush;
    /** Retry once the reader advances its cursor (it notifies CTRL_READ). */
    private scheduleFlush;
    private drain;
    private startReader;
}
/** Anything with a message event stream: MessagePort, Worker, or a worker's `self`. */
type MessagePortLike = {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
    start?(): void;
    close?(): void;
};
declare class MessageTransport implements Transport {
    readonly port: MessagePortLike;
    private readonly listeners;
    private closed;
    private readonly onEvent;
    constructor(port: MessagePortLike);
    send(keyIndex: number, value: unknown): void;
    onMessage(cb: MessageListener): () => void;
    close(): void;
}
type ChannelHandle = {
    kind: "sab";
    toRemote: SharedArrayBuffer;
    toLocal: SharedArrayBuffer;
} | {
    kind: "message";
    port: MessagePort;
};
type ChannelKind = "sab" | "message";
type ChannelOptions = SabTransportOptions & {
    /** `"auto"` (default) picks SAB when `sabAvailable()`. */
    transport?: ChannelKind | "auto";
    /** Data bytes per direction, a power of 2. Default 2 MiB. */
    capacity?: number;
};
type Channel = {
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
declare function sabAvailable(): boolean;
/** Create both ends of a channel: a local Transport and a handle for the other thread. */
declare function createChannel(options?: ChannelOptions): Channel;
/** Open the remote end of a channel from its posted handle. */
declare function openChannel(handle: ChannelHandle, options?: SabTransportOptions): Transport;

type WorkerLike = {
    postMessage(message: unknown, transfer?: Transferable[]): void;
};
type WorkerScopeLike = {
    addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
};
type ThreadLink = {
    /** Sorted key ids; a key's index is its position here. */
    readonly ids: readonly string[];
    /** Resolves once the transport is attached (immediately on the host). */
    readonly ready: Promise<void>;
    /** Null until `ready`. */
    readonly transport: Transport | null;
    /** Stop forwarding and close the transport. */
    close(): void;
};
type HostThreadOptions = ChannelOptions & {
    /** Send every catalog value to the worker on connect. Default true. */
    snapshot?: boolean;
};
type ConnectThreadOptions = SabTransportOptions;
/** Key index table: catalog ids sorted by UTF-16 code units. */
declare function keyIndexTable(catalog: Record<string, unknown> | readonly string[]): string[];
/** Main thread: link the store to `worker`. Post the handshake, then forward both ways. */
declare function hostThread(worker: WorkerLike, catalog: Record<string, unknown>, options?: HostThreadOptions): ThreadLink;
/**
 * Worker thread: call at the top level of the worker module (before the
 * first await) so the host's handshake is not missed. Initializes the store
 * from `catalog` when nothing has called `init` yet.
 */
declare function connectThread(scope: WorkerScopeLike, catalog: Record<string, unknown>, options?: ConnectThreadOptions): ThreadLink;

type GridShape = {
    frameCount: number;
    cols: number;
    rows: number;
    speciesCount: number;
};
/** "EVF1" as a little-endian u32. */
declare const GRID_MAGIC = 826693189;
declare const GRID_HEADER_BYTES: number;
type FrameGrid = {
    readonly buffer: SharedArrayBuffer;
    readonly shape: GridShape;
    readonly cells: number;
    /** Floats per frame: (speciesCount + 2) × cells. */
    readonly frameFloats: number;
    /** Every frame, contiguous. */
    readonly floats: Float32Array;
    /** One frame's fixed part; matches the EVF1 frame layout so a decoded frame can be `set` directly. */
    frame(index: number): Float32Array;
    hotspot(frame: number, species: number): Float32Array;
    lst(frame: number): Float32Array;
    sst(frame: number): Float32Array;
    version(): number;
    /** Publish a change: increments the version and wakes waiters. Returns the new version. */
    bump(): number;
    /** Resolves with the current version once it differs from `seen`. */
    waitVersion(seen: number, timeoutMs?: number): Promise<number>;
};
declare function frameGridBytes(shape: GridShape): number;
/** Allocate a zeroed grid buffer for `shape` and return views over it. */
declare function allocFrameGrid(shape: GridShape): FrameGrid;
/** Views over a grid buffer allocated elsewhere (another thread). */
declare function attachFrameGrid(buffer: SharedArrayBuffer): FrameGrid;

export { CTRL_BYTES, CTRL_READ, CTRL_VERSION, CTRL_WRITE, type Channel, type ChannelHandle, type ChannelKind, type ChannelOptions, type ConnectThreadOptions, DEFAULT_CAPACITY, type FrameGrid, GRID_HEADER_BYTES, GRID_MAGIC, type GridShape, type HostThreadOptions, MAX_KEYS, MIN_CAPACITY, type MessageListener, type MessagePortLike, MessageTransport, PAD_MARKER, Ring, type RingRecord, SabTransport, type SabTransportOptions, type ThreadLink, type Transport, type WaitMode, type WorkerLike, type WorkerScopeLike, allocFrameGrid, allocRing, attachFrameGrid, connectThread, createChannel, decodeValue, encodeValue, frameGridBytes, hasWaitAsync, hostThread, keyIndexTable, openChannel, sabAvailable, waitChange };
