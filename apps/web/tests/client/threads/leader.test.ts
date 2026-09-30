import { describe, expect, test } from "bun:test";

import { createElection, locksAvailable, type LeaderState, type Locks } from "client/threads/db/leader";
import { createRouter, ProxyError, type ChannelLike } from "client/threads/db/proxy";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick();
};

/** In-memory Web Locks: one holder per name, FIFO waiters, abortable requests. */
function fakeLocks(): Locks & { holders(name: string): number; waiters(name: string): number } {
  type Waiter = { grant: () => void; signal?: AbortSignal };
  const held = new Map<string, boolean>();
  const queue = new Map<string, Waiter[]>();
  const next = (name: string) => {
    const q = queue.get(name) ?? [];
    while (q.length) {
      const w = q.shift()!;
      if (w.signal?.aborted) continue;
      held.set(name, true);
      w.grant();
      return;
    }
    held.set(name, false);
  };
  return {
    request(name, options, callback) {
      const run = () =>
        Promise.resolve(callback({ name })).finally(() => next(name));
      if (!held.get(name)) {
        held.set(name, true);
        return run();
      }
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise((resolve, reject) => {
        const w: Waiter = { grant: () => resolve(run()), signal: options.signal };
        options.signal?.addEventListener("abort", () => {
          const q = queue.get(name) ?? [];
          const i = q.indexOf(w);
          if (i >= 0) q.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        });
        queue.set(name, [...(queue.get(name) ?? []), w]);
      });
    },
    holders: (name) => (held.get(name) ? 1 : 0),
    waiters: (name) => (queue.get(name) ?? []).filter((w) => !w.signal?.aborted).length,
  };
}

describe("leader election", () => {
  test("the first tab leads, later tabs follow, and leadership fails over in queue order", async () => {
    const locks = fakeLocks();
    const seen: Record<string, LeaderState[]> = { a: [], b: [], c: [] };
    const a = createElection({ locks, onChange: (s) => seen.a!.push(s) });
    await settle();
    const b = createElection({ locks, onChange: (s) => seen.b!.push(s) });
    const c = createElection({ locks, onChange: (s) => seen.c!.push(s) });
    await settle();

    expect(await a.settled).toBe("leader");
    expect(await b.settled).toBe("follower");
    expect(await c.settled).toBe("follower");
    expect([a.state, b.state, c.state]).toEqual(["leader", "follower", "follower"]);
    expect(locks.waiters("inversa-db")).toBe(2);

    a.close();
    await settle();
    expect(a.state).toBe("closed");
    expect([b.state, c.state]).toEqual(["leader", "follower"]);
    await b.leadership;
    expect(seen.b).toEqual(["electing", "follower", "leader"]);

    b.close();
    await settle();
    expect(c.state).toBe("leader");
    expect(locks.holders("inversa-db")).toBe(1);
    c.close();
    await settle();
    expect(locks.holders("inversa-db")).toBe(0);
  });

  test("closing a follower withdraws its queued request", async () => {
    const locks = fakeLocks();
    const a = createElection({ locks });
    await settle();
    const b = createElection({ locks });
    await settle();
    expect(locks.waiters("inversa-db")).toBe(1);
    b.close();
    await settle();
    expect(locks.waiters("inversa-db")).toBe(0);
    expect(b.state).toBe("closed");
    a.close();
  });

  test("a lock manager that throws leaves the tab a follower rather than stuck", async () => {
    const locks: Locks = { request: () => Promise.reject(new Error("locks broken")) };
    const orig = console.error;
    console.error = () => {};
    try {
      const e = createElection({ locks });
      expect(await e.settled).toBe("follower");
      e.close();
    } finally {
      console.error = orig;
    }
  });

  test("locksAvailable reflects navigator.locks", () => {
    expect(locksAvailable({ locks: {} })).toBe(true);
    expect(locksAvailable({})).toBe(false);
    expect(locksAvailable(undefined)).toBe(false);
  });
});

/** A BroadcastChannel group: a post on one member reaches every other member. */
function fakeChannels(n: number): ChannelLike[] {
  const members: { listeners: Set<(ev: MessageEvent) => void> }[] = Array.from({ length: n }, () => ({ listeners: new Set() }));
  return members.map((me) => ({
    postMessage(message) {
      for (const other of members) {
        if (other === me) continue;
        for (const cb of other.listeners) queueMicrotask(() => cb({ data: structuredClone(message) } as MessageEvent));
      }
    },
    addEventListener: (_t, cb) => me.listeners.add(cb),
    removeEventListener: (_t, cb) => me.listeners.delete(cb),
  }));
}

describe("db call router", () => {
  test("the leader answers locally, followers proxy through it", async () => {
    const [chA, chB] = fakeChannels(2);
    const leader: string = "a";
    const calls: string[] = [];
    const a = createRouter({ channel: chA!, tabId: "a", isLeader: () => leader === "a", local: async (m, p) => (calls.push(`a:${m}`), { m, p, by: "a" }) });
    const b = createRouter({ channel: chB!, tabId: "b", isLeader: () => leader === "b", local: async (m) => (calls.push(`b:${m}`), { by: "b" }) });

    expect(await a.call("stats", {})).toEqual({ m: "stats", p: {}, by: "a" });
    expect(await b.call("query", { q: 1 })).toEqual({ m: "query", p: { q: 1 }, by: "a" });
    expect(calls).toEqual(["a:stats", "a:query"]);
    expect(b.pending).toBe(0);
    a.close();
    b.close();
  });

  test("a local error on the leader reaches the follower as a ProxyError", async () => {
    const [chA, chB] = fakeChannels(2);
    const a = createRouter({ channel: chA!, tabId: "a", isLeader: () => true, local: async () => Promise.reject(new Error("no such board")) });
    const b = createRouter({ channel: chB!, tabId: "b", isLeader: () => false, local: async () => null });
    await expect(b.call("readBoard", {})).rejects.toBeInstanceOf(ProxyError);
    await expect(b.call("readBoard", {})).rejects.toThrow("no such board");
    a.close();
    b.close();
  });

  test("an unanswered call is re-dispatched, and runs locally once this tab leads", async () => {
    const [chA, chB] = fakeChannels(2);
    let bLeads = false;
    const localB: string[] = [];
    // No leader is listening: tab A never answers.
    const a = createRouter({ channel: chA!, tabId: "a", isLeader: () => false, local: async () => null });
    const b = createRouter({ channel: chB!, tabId: "b", isLeader: () => bLeads, local: async (m) => (localB.push(m), "from-b"), timeoutMs: 5, maxAttempts: 3 });
    const p = b.call("stats", {});
    await new Promise((r) => setTimeout(r, 7));
    expect(b.pending).toBe(1);
    bLeads = true;
    expect(await p).toBe("from-b");
    expect(localB).toEqual(["stats"]);
    a.close();
    b.close();
  });

  test("gives up after maxAttempts with no leader", async () => {
    const [ch] = fakeChannels(1);
    const r = createRouter({ channel: ch!, tabId: "x", isLeader: () => false, local: async () => null, timeoutMs: 2, maxAttempts: 2 });
    await expect(r.call("stats", {})).rejects.toThrow(/no leader answered stats after 2 attempts/);
    r.close();
  });

  test("closing rejects in-flight calls", async () => {
    const [ch] = fakeChannels(1);
    const r = createRouter({ channel: ch!, tabId: "x", isLeader: () => false, local: async () => null, timeoutMs: 1000 });
    const p = r.call("stats", {});
    r.close();
    await expect(p).rejects.toThrow("router closed");
    await expect(r.call("stats", {})).rejects.toThrow("router closed");
  });

  test("leader events reach followers only", async () => {
    const [chA, chB, chC] = fakeChannels(3);
    const got: string[] = [];
    const a = createRouter({ channel: chA!, tabId: "a", isLeader: () => true, local: async () => null, onEvent: (e) => got.push(`a:${e}`) });
    const b = createRouter({ channel: chB!, tabId: "b", isLeader: () => false, local: async () => null, onEvent: (e, d) => got.push(`b:${e}:${JSON.stringify(d)}`) });
    const c = createRouter({ channel: chC!, tabId: "c", isLeader: () => false, local: async () => null, onEvent: (e) => got.push(`c:${e}`) });
    a.broadcast("board", { boardId: "b1" });
    await settle();
    expect(got.sort()).toEqual(['b:board:{"boardId":"b1"}', "c:board"]);
    a.close();
    b.close();
    c.close();
  });
});
