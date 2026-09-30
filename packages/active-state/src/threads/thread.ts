/**
 * Cross-thread store links. `hostThread` runs on main for each worker;
 * `connectThread` runs inside the worker. Both sides keep the normal
 * `key / get / set / subscribe / useActiveState` API: a `set` on one thread
 * lands in the other thread's bus, where subscribers fire as usual.
 */
import {
  getStateInstance,
  init,
  type EventBus,
} from "@calvinjs/active-state";
import {
  createChannel,
  openChannel,
  type ChannelHandle,
  type ChannelOptions,
  type SabTransportOptions,
  type Transport,
} from "./transport";

const HANDSHAKE = "active-state:thread";

type Handshake = { type: typeof HANDSHAKE; ids: string[]; handle: ChannelHandle };

export type WorkerLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

export type WorkerScopeLike = {
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(
    type: "message",
    listener: (ev: MessageEvent) => void,
  ): void;
};

export type ThreadLink = {
  /** Sorted key ids; a key's index is its position here. */
  readonly ids: readonly string[];
  /** Resolves once the transport is attached (immediately on the host). */
  readonly ready: Promise<void>;
  /** Null until `ready`. */
  readonly transport: Transport | null;
  /** Stop forwarding and close the transport. */
  close(): void;
};

export type HostThreadOptions = ChannelOptions & {
  /** Send every catalog value to the worker on connect. Default true. */
  snapshot?: boolean;
};

export type ConnectThreadOptions = SabTransportOptions;

/** Key index table: catalog ids sorted by UTF-16 code units. */
export function keyIndexTable(
  catalog: Record<string, unknown> | readonly string[],
): string[] {
  const ids = Array.isArray(catalog)
    ? [...(catalog as readonly string[])]
    : Object.keys(catalog);
  return ids.sort();
}

function ensureBus(catalog: Record<string, unknown>): EventBus {
  try {
    return getStateInstance();
  } catch {
    init(catalog);
    return getStateInstance();
  }
}

/**
 * Forward local bus writes to `transport` and apply remote writes to the bus.
 * A remote apply is marked so the wrapper below it does not echo it back;
 * the mark is cleared before listeners run, so a listener's own `set` still
 * propagates. Wrappers from several links stack, which gives fan-out across
 * workers without echo.
 */
function bridge(bus: EventBus, transport: Transport, ids: readonly string[]) {
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));
  let remoteApply: string | null = null;
  let active = true;
  const base = bus.update;

  bus.update = (id, value) => {
    const fromRemote = remoteApply === id;
    remoteApply = null;
    const prev = bus.observables.get(id)?.getValue();
    base(id, value);
    if (fromRemote || !active || Object.is(prev, value)) return;
    const keyIndex = index.get(id);
    if (keyIndex !== undefined) transport.send(keyIndex, value);
  };

  const off = transport.onMessage((keyIndex, value) => {
    const id = ids[keyIndex];
    if (id === undefined) return;
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

/** Main thread: link the store to `worker`. Post the handshake, then forward both ways. */
export function hostThread(
  worker: WorkerLike,
  catalog: Record<string, unknown>,
  options: HostThreadOptions = {},
): ThreadLink {
  const bus = ensureBus(catalog);
  const ids = keyIndexTable(catalog);
  const channel = createChannel(options);
  const unlink = bridge(bus, channel.transport, ids);
  const hello: Handshake = { type: HANDSHAKE, ids, handle: channel.handle };
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
    },
  };
}

/**
 * Worker thread: call at the top level of the worker module (before the
 * first await) so the host's handshake is not missed. Initializes the store
 * from `catalog` when nothing has called `init` yet.
 */
export function connectThread(
  scope: WorkerScopeLike,
  catalog: Record<string, unknown>,
  options: ConnectThreadOptions = {},
): ThreadLink {
  const bus = ensureBus(catalog);
  const localIds = keyIndexTable(catalog);
  let transport: Transport | null = null;
  let unlink: (() => void) | null = null;
  let closed = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const link: { -readonly [K in keyof ThreadLink]: ThreadLink[K] } = {
    ids: localIds,
    ready,
    transport,
    close() {
      closed = true;
      scope.removeEventListener("message", onMessage);
      unlink?.();
      transport?.close();
    },
  };

  const onMessage = (ev: MessageEvent): void => {
    const d = ev.data as Partial<Handshake> | null;
    if (!d || typeof d !== "object" || d.type !== HANDSHAKE) return;
    scope.removeEventListener("message", onMessage);
    if (closed || !d.handle || !Array.isArray(d.ids)) return;
    const ids = d.ids;
    if (ids.join("\0") !== localIds.join("\0")) {
      console.warn(
        "[active-state/threads] worker catalog differs from host; using host key table",
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
