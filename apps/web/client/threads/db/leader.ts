/**
 * Web Locks leader election (PRD §12 "New tech 2"). One tab holds `inversa-db` and owns the db worker; the
 * others follow and proxy over BroadcastChannel (`proxy.ts`). When the leader closes, the lock is released
 * and the longest-waiting follower is granted it: failover with no message exchange.
 *
 * The lock manager is injected so the state machine runs under bun with a fake.
 */

export type LeaderState = "idle" | "electing" | "leader" | "follower" | "closed";

export type LockRequestOptions = { ifAvailable?: boolean; signal?: AbortSignal };

/** The subset of `navigator.locks` used here. */
export type Locks = {
  request(name: string, options: LockRequestOptions, callback: (lock: unknown | null) => Promise<unknown>): Promise<unknown>;
};

export type ElectionOptions = {
  locks: Locks;
  name?: string;
  onChange?: (state: LeaderState) => void;
};

export type Election = {
  readonly state: LeaderState;
  /** Resolves with the first settled state, `leader` or `follower`. */
  readonly settled: Promise<"leader" | "follower">;
  /** Resolves once this tab holds the lock (immediately when it already does). */
  readonly leadership: Promise<void>;
  onChange(cb: (state: LeaderState) => void): () => void;
  /** Release the lock (if held) or withdraw the pending request. */
  close(): void;
};

export const LOCK_NAME = "inversa-db";

export function createElection(options: ElectionOptions): Election {
  const name = options.name ?? LOCK_NAME;
  const listeners = new Set<(s: LeaderState) => void>();
  if (options.onChange) listeners.add(options.onChange);
  let state: LeaderState = "idle";
  let releaseLock: (() => void) | null = null;
  const abort = new AbortController();

  let settle!: (s: "leader" | "follower") => void;
  const settled = new Promise<"leader" | "follower">((r) => {
    settle = r;
  });
  let grantLeadership!: () => void;
  const leadership = new Promise<void>((r) => {
    grantLeadership = r;
  });

  const setState = (next: LeaderState) => {
    if (state === "closed" || state === next) return;
    state = next;
    for (const cb of listeners) cb(next);
  };

  /** Hold the lock until `close()`. */
  const hold = (): Promise<void> =>
    new Promise<void>((release) => {
      releaseLock = release;
      setState("leader");
      settle("leader");
      grantLeadership();
    });

  const run = async () => {
    setState("electing");
    try {
      // Try without waiting: `null` means another tab holds it.
      await options.locks.request(name, { ifAvailable: true }, async (lock) => {
        if (lock === null) return;
        await hold();
      });
      if (state === "leader" || state === "closed") return;
      setState("follower");
      settle("follower");
      // Queue behind the holder; granted when the leader closes (failover).
      await options.locks.request(name, { signal: abort.signal }, async (lock) => {
        if (lock === null || state === "closed") return;
        await hold();
      });
    } catch (err) {
      if (state !== "closed") {
        console.error("[threads/leader] lock request failed", err);
        setState("follower");
        settle("follower");
      }
    }
  };
  void run();

  return {
    get state() {
      return state;
    },
    settled,
    leadership,
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      abort.abort();
      releaseLock?.();
      releaseLock = null;
      listeners.clear();
    },
  };
}

/** True when the page can elect at all; without Web Locks every tab runs its own db worker. */
export function locksAvailable(nav: { locks?: unknown } | undefined = globalThis.navigator): boolean {
  return Boolean(nav && typeof nav.locks === "object" && nav.locks !== null);
}
