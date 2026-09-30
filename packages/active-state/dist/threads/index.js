var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/threads/ring.ts
var MAX_KEYS = 256;
var PAD_MARKER = 65535;
var CTRL_WRITE = 0;
var CTRL_READ = 1;
var CTRL_VERSION = 2;
var CTRL_LENGTH = CTRL_VERSION + MAX_KEYS;
var CTRL_BYTES = CTRL_LENGTH * 4;
var HEADER_BYTES = 6;
var MIN_CAPACITY = 64;
var DEFAULT_CAPACITY = 1 << 21;
function isPow2(n) {
  return Number.isInteger(n) && n > 0 && (n & n - 1) === 0;
}
function assertCapacity(capacity) {
  if (!isPow2(capacity) || capacity < MIN_CAPACITY) {
    throw new Error(
      `[active-state/threads] ring capacity must be a power of 2 >= ${MIN_CAPACITY}, got ${capacity}`
    );
  }
}
function allocRing(capacity = DEFAULT_CAPACITY) {
  assertCapacity(capacity);
  return new SharedArrayBuffer(CTRL_BYTES + capacity);
}
var Ring = class {
  constructor(buffer) {
    __publicField(this, "buffer");
    __publicField(this, "ctrl");
    __publicField(this, "data");
    __publicField(this, "capacity");
    /** Largest payload `tryWrite` accepts. */
    __publicField(this, "maxBytes");
    __publicField(this, "view");
    __publicField(this, "mask");
    const capacity = buffer.byteLength - CTRL_BYTES;
    assertCapacity(capacity);
    this.buffer = buffer;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.maxBytes = capacity - 1 - HEADER_BYTES;
    this.ctrl = new Int32Array(buffer, 0, CTRL_LENGTH);
    this.data = new Uint8Array(buffer, CTRL_BYTES, capacity);
    this.view = new DataView(buffer, CTRL_BYTES, capacity);
  }
  get writeCursor() {
    return Atomics.load(this.ctrl, CTRL_WRITE);
  }
  get readCursor() {
    return Atomics.load(this.ctrl, CTRL_READ);
  }
  /** Number of writes seen for `keyIndex` (wraps at 2^31). */
  version(keyIndex) {
    return Atomics.load(this.ctrl, CTRL_VERSION + keyIndex);
  }
  isEmpty() {
    return this.writeCursor === this.readCursor;
  }
  /**
   * Append one record. Returns false when the ring lacks room; nothing is
   * written in that case. Throws when the payload can never fit.
   */
  tryWrite(keyIndex, bytes) {
    if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= MAX_KEYS) {
      throw new Error(
        `[active-state/threads] keyIndex must be an integer in [0, ${MAX_KEYS}), got ${keyIndex}`
      );
    }
    if (bytes.length > this.maxBytes) {
      throw new Error(
        `[active-state/threads] value of ${bytes.length} bytes exceeds the ring limit of ${this.maxBytes} bytes; allocate a larger ring (allocRing(capacity))`
      );
    }
    const need = HEADER_BYTES + bytes.length;
    const cap = this.capacity;
    const ctrl = this.ctrl;
    let w = Atomics.load(ctrl, CTRL_WRITE);
    const r = Atomics.load(ctrl, CTRL_READ);
    if (w >= r) {
      const tail = cap - w;
      const fitsTail = need < tail || need === tail && r !== 0;
      if (!fitsTail) {
        if (need >= r) return false;
        if (tail >= 2) this.view.setUint16(w, PAD_MARKER, true);
        w = 0;
      }
    } else if (need >= r - w) {
      return false;
    }
    this.view.setUint16(w, keyIndex, true);
    this.view.setUint32(w + 2, bytes.length, true);
    this.data.set(bytes, w + HEADER_BYTES);
    Atomics.add(ctrl, CTRL_VERSION + keyIndex, 1);
    Atomics.store(ctrl, CTRL_WRITE, w + need & this.mask);
    Atomics.notify(ctrl, CTRL_WRITE);
    return true;
  }
  /** Pop one record, copying its bytes out of shared memory. Null when empty. */
  tryRead() {
    const ctrl = this.ctrl;
    let r = Atomics.load(ctrl, CTRL_READ);
    const w = Atomics.load(ctrl, CTRL_WRITE);
    if (r === w) return null;
    if (this.capacity - r < 2 || this.view.getUint16(r, true) === PAD_MARKER) {
      r = 0;
    }
    const keyIndex = this.view.getUint16(r, true);
    const len = this.view.getUint32(r + 2, true);
    const start = r + HEADER_BYTES;
    const bytes = this.data.slice(start, start + len);
    Atomics.store(ctrl, CTRL_READ, start + len & this.mask);
    Atomics.notify(ctrl, CTRL_READ);
    return { keyIndex, bytes };
  }
  /** Block until the write cursor moves away from `seen` (workers only). */
  wait(seen, timeoutMs) {
    return Atomics.wait(this.ctrl, CTRL_WRITE, seen, timeoutMs);
  }
};
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function encodeValue(value) {
  if (value === void 0) return new Uint8Array(0);
  return encoder.encode(JSON.stringify(value));
}
function decodeValue(bytes) {
  if (bytes.length === 0) return void 0;
  return JSON.parse(decoder.decode(bytes));
}
function hasWaitAsync() {
  return typeof Atomics.waitAsync === "function";
}
function waitChange(arr, index, seen, timeoutMs = Infinity) {
  const waitAsync = Atomics.waitAsync;
  if (waitAsync) {
    const res = waitAsync(arr, index, seen, timeoutMs);
    if (!res.async) return Promise.resolve();
    return res.value.then(() => void 0);
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (Atomics.load(arr, index) !== seen || Date.now() >= deadline) {
        resolve();
      } else {
        setTimeout(tick, 1);
      }
    };
    tick();
  });
}

// src/threads/transport.ts
var SYNC_SLICE_MS = 8;
var KEEP_ALIVE_MS = 6e4;
function dispatch(listeners, keyIndex, value) {
  for (const cb of listeners) {
    try {
      cb(keyIndex, value);
    } catch (err) {
      console.error("[active-state/threads] listener threw", err);
    }
  }
}
var SabTransport = class {
  constructor(outgoing, incoming, options = {}) {
    __publicField(this, "outgoing");
    __publicField(this, "incoming");
    __publicField(this, "waitMode");
    __publicField(this, "listeners", /* @__PURE__ */ new Set());
    __publicField(this, "pending", []);
    __publicField(this, "flushing", false);
    __publicField(this, "closed", false);
    __publicField(this, "timer", null);
    // Bun and Node end a worker whose event loop holds only a parked
    // Atomics.waitAsync; a live timer keeps the reader's thread up.
    __publicField(this, "keepAlive", null);
    this.outgoing = outgoing instanceof Ring ? outgoing : new Ring(outgoing);
    this.incoming = incoming instanceof Ring ? incoming : new Ring(incoming);
    this.waitMode = options.wait ?? (hasWaitAsync() ? "async" : "sync");
    if (this.waitMode === "sync" && typeof Atomics.wait !== "function") {
      throw new Error(
        '[active-state/threads] wait: "sync" needs Atomics.wait (workers only)'
      );
    }
    queueMicrotask(() => this.startReader());
  }
  /** Messages queued because the outgoing ring was full. */
  get backlog() {
    return this.pending.length;
  }
  send(keyIndex, value) {
    if (this.closed) return;
    const bytes = encodeValue(value);
    if (this.pending.length > 0 || !this.outgoing.tryWrite(keyIndex, bytes)) {
      this.pending.push({ keyIndex, bytes });
      this.scheduleFlush();
    }
  }
  onMessage(cb) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.pending.length = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.keepAlive !== null) clearInterval(this.keepAlive);
    Atomics.notify(this.incoming.ctrl, CTRL_WRITE);
  }
  flush() {
    this.flushing = false;
    if (this.closed) return;
    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (!this.outgoing.tryWrite(next.keyIndex, next.bytes)) {
        this.scheduleFlush();
        return;
      }
      this.pending.shift();
    }
  }
  /** Retry once the reader advances its cursor (it notifies CTRL_READ). */
  scheduleFlush() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    const seen = this.outgoing.readCursor;
    void waitChange(this.outgoing.ctrl, CTRL_READ, seen).then(() => this.flush());
  }
  drain() {
    const ring = this.incoming;
    for (let rec = ring.tryRead(); rec !== null; rec = ring.tryRead()) {
      if (this.closed) return;
      dispatch(this.listeners, rec.keyIndex, decodeValue(rec.bytes));
    }
  }
  startReader() {
    if (this.closed) return;
    const ring = this.incoming;
    if (this.waitMode === "async") {
      this.keepAlive = setInterval(() => {
      }, KEEP_ALIVE_MS);
      const loop2 = () => {
        while (!this.closed) {
          this.drain();
          const seen = ring.writeCursor;
          if (ring.readCursor !== seen) continue;
          const parked = waitChange(ring.ctrl, CTRL_WRITE, seen);
          void parked.then(loop2);
          return;
        }
      };
      loop2();
      return;
    }
    const loop = () => {
      this.timer = null;
      if (this.closed) return;
      this.drain();
      const seen = ring.writeCursor;
      if (ring.readCursor === seen) ring.wait(seen, SYNC_SLICE_MS);
      this.timer = setTimeout(loop, 0);
    };
    loop();
  }
};
var MESSAGE_TAG = "active-state:msg";
var MessageTransport = class {
  constructor(port) {
    __publicField(this, "port");
    __publicField(this, "listeners", /* @__PURE__ */ new Set());
    __publicField(this, "closed", false);
    __publicField(this, "onEvent", (ev) => {
      const d = ev.data;
      if (!d || typeof d !== "object" || d.t !== MESSAGE_TAG) return;
      dispatch(this.listeners, d.k, d.v);
    });
    this.port = port;
    port.addEventListener("message", this.onEvent);
    port.start?.();
  }
  send(keyIndex, value) {
    if (this.closed) return;
    const msg = { t: MESSAGE_TAG, k: keyIndex, v: value };
    this.port.postMessage(msg);
  }
  onMessage(cb) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.port.removeEventListener("message", this.onEvent);
    this.port.close?.();
  }
};
function sabAvailable() {
  if (typeof SharedArrayBuffer !== "function") return false;
  const isolated = globalThis.crossOriginIsolated;
  return isolated !== false;
}
function createChannel(options = {}) {
  const want = options.transport ?? "auto";
  const kind = want === "auto" ? sabAvailable() ? "sab" : "message" : want;
  if (kind === "sab") {
    const toRemote = allocRing(options.capacity);
    const toLocal = allocRing(options.capacity);
    return {
      kind,
      transport: new SabTransport(toRemote, toLocal, options),
      handle: { kind, toRemote, toLocal },
      transfer: []
    };
  }
  const { port1, port2 } = new MessageChannel();
  return {
    kind,
    transport: new MessageTransport(port1),
    handle: { kind, port: port2 },
    transfer: [port2]
  };
}
function openChannel(handle, options = {}) {
  if (handle.kind === "sab") {
    return new SabTransport(handle.toLocal, handle.toRemote, options);
  }
  return new MessageTransport(handle.port);
}

// src/threads/thread.ts
import {
  getStateInstance,
  init
} from "@calvinjs/active-state";
var HANDSHAKE = "active-state:thread";
function keyIndexTable(catalog) {
  const ids = Array.isArray(catalog) ? [...catalog] : Object.keys(catalog);
  return ids.sort();
}
function ensureBus(catalog) {
  try {
    return getStateInstance();
  } catch {
    init(catalog);
    return getStateInstance();
  }
}
function bridge(bus, transport, ids) {
  const index = /* @__PURE__ */ new Map();
  ids.forEach((id, i) => index.set(id, i));
  let remoteApply = null;
  let active = true;
  const base = bus.update;
  bus.update = (id, value) => {
    const fromRemote = remoteApply === id;
    remoteApply = null;
    const prev = bus.observables.get(id)?.getValue();
    base(id, value);
    if (fromRemote || !active || Object.is(prev, value)) return;
    const keyIndex = index.get(id);
    if (keyIndex !== void 0) transport.send(keyIndex, value);
  };
  const off = transport.onMessage((keyIndex, value) => {
    const id = ids[keyIndex];
    if (id === void 0) return;
    remoteApply = id;
    try {
      bus.update(id, value);
    } finally {
      remoteApply = null;
    }
  });
  return () => {
    active = false;
    off();
  };
}
function hostThread(worker, catalog, options = {}) {
  const bus = ensureBus(catalog);
  const ids = keyIndexTable(catalog);
  const channel = createChannel(options);
  const unlink = bridge(bus, channel.transport, ids);
  const hello = { type: HANDSHAKE, ids, handle: channel.handle };
  worker.postMessage(hello, channel.transfer);
  if (options.snapshot ?? true) {
    ids.forEach((id, i) => {
      const source = bus.observables.get(id);
      if (source) channel.transport.send(i, source.getValue());
    });
  }
  return {
    ids,
    ready: Promise.resolve(),
    transport: channel.transport,
    close() {
      unlink();
      channel.transport.close();
    }
  };
}
function connectThread(scope, catalog, options = {}) {
  const bus = ensureBus(catalog);
  const localIds = keyIndexTable(catalog);
  let transport = null;
  let unlink = null;
  let closed = false;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const link = {
    ids: localIds,
    ready,
    transport,
    close() {
      closed = true;
      scope.removeEventListener("message", onMessage);
      unlink?.();
      transport?.close();
    }
  };
  const onMessage = (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.type !== HANDSHAKE) return;
    scope.removeEventListener("message", onMessage);
    if (closed || !d.handle || !Array.isArray(d.ids)) return;
    const ids = d.ids;
    if (ids.join("\0") !== localIds.join("\0")) {
      console.warn(
        "[active-state/threads] worker catalog differs from host; using host key table"
      );
    }
    transport = openChannel(d.handle, options);
    unlink = bridge(bus, transport, ids);
    link.ids = ids;
    link.transport = transport;
    resolveReady();
  };
  scope.addEventListener("message", onMessage);
  return link;
}

// src/threads/bulk.ts
var GRID_MAGIC = 826693189;
var HDR_MAGIC = 0;
var HDR_VERSION = 1;
var HDR_FRAMES = 2;
var HDR_COLS = 3;
var HDR_ROWS = 4;
var HDR_SPECIES = 5;
var HDR_LENGTH = 8;
var GRID_HEADER_BYTES = HDR_LENGTH * 4;
function assertShape(shape) {
  for (const [name, n] of Object.entries(shape)) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `[active-state/threads] grid ${name} must be a non-negative integer, got ${n}`
      );
    }
  }
}
function frameGridBytes(shape) {
  assertShape(shape);
  const cells = shape.cols * shape.rows;
  return GRID_HEADER_BYTES + shape.frameCount * (shape.speciesCount + 2) * cells * 4;
}
function allocFrameGrid(shape) {
  const buffer = new SharedArrayBuffer(frameGridBytes(shape));
  const hdr = new Int32Array(buffer, 0, HDR_LENGTH);
  hdr[HDR_MAGIC] = GRID_MAGIC;
  hdr[HDR_FRAMES] = shape.frameCount;
  hdr[HDR_COLS] = shape.cols;
  hdr[HDR_ROWS] = shape.rows;
  hdr[HDR_SPECIES] = shape.speciesCount;
  return attachFrameGrid(buffer);
}
function attachFrameGrid(buffer) {
  if (buffer.byteLength < GRID_HEADER_BYTES) {
    throw new Error("[active-state/threads] grid buffer too small for a header");
  }
  const hdr = new Int32Array(buffer, 0, HDR_LENGTH);
  if (hdr[HDR_MAGIC] !== GRID_MAGIC) {
    throw new Error("[active-state/threads] grid buffer has a bad magic");
  }
  const shape = {
    frameCount: hdr[HDR_FRAMES],
    cols: hdr[HDR_COLS],
    rows: hdr[HDR_ROWS],
    speciesCount: hdr[HDR_SPECIES]
  };
  const expected = frameGridBytes(shape);
  if (buffer.byteLength !== expected) {
    throw new Error(
      `[active-state/threads] grid buffer is ${buffer.byteLength} bytes, header implies ${expected}`
    );
  }
  const cells = shape.cols * shape.rows;
  const frameFloats = (shape.speciesCount + 2) * cells;
  const floats = new Float32Array(
    buffer,
    GRID_HEADER_BYTES,
    shape.frameCount * frameFloats
  );
  const check = (name, n, limit) => {
    if (!Number.isInteger(n) || n < 0 || n >= limit) {
      throw new RangeError(
        `[active-state/threads] ${name} ${n} out of range [0, ${limit})`
      );
    }
  };
  const frameStart = (frame) => {
    check("frame", frame, shape.frameCount);
    return frame * frameFloats;
  };
  return {
    buffer,
    shape,
    cells,
    frameFloats,
    floats,
    frame(index) {
      const start = frameStart(index);
      return floats.subarray(start, start + frameFloats);
    },
    hotspot(frame, species) {
      check("species", species, shape.speciesCount);
      const start = frameStart(frame) + species * cells;
      return floats.subarray(start, start + cells);
    },
    lst(frame) {
      const start = frameStart(frame) + shape.speciesCount * cells;
      return floats.subarray(start, start + cells);
    },
    sst(frame) {
      const start = frameStart(frame) + (shape.speciesCount + 1) * cells;
      return floats.subarray(start, start + cells);
    },
    version() {
      return Atomics.load(hdr, HDR_VERSION);
    },
    bump() {
      const next = Atomics.add(hdr, HDR_VERSION, 1) + 1;
      Atomics.notify(hdr, HDR_VERSION);
      return next;
    },
    waitVersion(seen, timeoutMs) {
      return waitChange(hdr, HDR_VERSION, seen, timeoutMs).then(
        () => Atomics.load(hdr, HDR_VERSION)
      );
    }
  };
}
export {
  CTRL_BYTES,
  CTRL_READ,
  CTRL_VERSION,
  CTRL_WRITE,
  DEFAULT_CAPACITY,
  GRID_HEADER_BYTES,
  GRID_MAGIC,
  MAX_KEYS,
  MIN_CAPACITY,
  MessageTransport,
  PAD_MARKER,
  Ring,
  SabTransport,
  allocFrameGrid,
  allocRing,
  attachFrameGrid,
  connectThread,
  createChannel,
  decodeValue,
  encodeValue,
  frameGridBytes,
  hasWaitAsync,
  hostThread,
  keyIndexTable,
  openChannel,
  sabAvailable,
  waitChange
};
