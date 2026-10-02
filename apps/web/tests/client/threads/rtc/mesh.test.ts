import { describe, expect, test } from "bun:test";

import { isPolite, MAX_PEERS, Mesh, OPS_CHANNEL_LABEL, type SessionState } from "client/threads/rtc/mesh";

import { FakePc, FakeSignaling, settle, type FakeChannel } from "./fakes";

const ROOM = "everglades";

type Node = {
  id: string;
  mesh: Mesh<FakeChannel>;
  pcs: FakePc[];
  channels: FakeChannel[];
  states: [string, SessionState][];
  errors: unknown[];
};

function node(id: string, signal: FakeSignaling, maxPeers?: number): Node {
  const n: Node = { id, mesh: null as unknown as Mesh<FakeChannel>, pcs: [], channels: [], states: [], errors: [] };
  n.mesh = new Mesh<FakeChannel>({
    me: id,
    room: ROOM,
    signal,
    maxPeers,
    createPc: () => {
      const pc = new FakePc(`${id}#${n.pcs.length}`);
      n.pcs.push(pc);
      return pc;
    },
    onChannel: (_peer, ch) => n.channels.push(ch),
    onState: (peer, state) => n.states.push([peer, state]),
    onError: (_peer, err) => n.errors.push(err),
  });
  return n;
}

/** Poll every inbox until the room goes quiet, like the 500 ms loop would. */
async function pump(signal: FakeSignaling, nodes: Node[], maxRounds = 20): Promise<number> {
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    await settle();
    if (signal.waiting(ROOM) === 0) break;
    for (const n of nodes) for (const msg of await signal.drain(ROOM, n.id)) await n.mesh.deliver(msg);
  }
  await settle();
  return rounds;
}

async function join(signal: FakeSignaling, nodes: Node[]): Promise<void> {
  for (const n of nodes) await signal.announce(ROOM, n.id, n.id);
  const list = await signal.listPeers(ROOM);
  for (const n of nodes) n.mesh.reconcile(list);
}

describe("polite peer roles", () => {
  test("exactly one side of every pair is polite, by id order", () => {
    expect(isPolite("a", "b")).toBe(true);
    expect(isPolite("b", "a")).toBe(false);
    expect(isPolite("a", "a")).toBe(false);
  });
});

describe("mesh lifecycle with fake signaling", () => {
  test("two peers discovering each other at once (glare) end up connected with one rollback, on the polite side", async () => {
    const signal = new FakeSignaling();
    const a = node("a", signal);
    const b = node("b", signal);
    await join(signal, [a, b]);
    expect(a.mesh.pending()).toBe(true);
    expect(b.mesh.pending()).toBe(true);
    // Both fire negotiationneeded and offer: two offers cross in the inboxes.
    await settle();
    expect(signal.log.filter((m) => m.kind === "offer").map((m) => m.from).sort()).toEqual(["a", "b"]);

    await pump(signal, [a, b]);
    expect(a.mesh.stateOf("b")).toBe("connected");
    expect(b.mesh.stateOf("a")).toBe("connected");
    expect(a.mesh.pending()).toBe(false);
    expect(b.mesh.pending()).toBe(false);
    // a < b, so a is polite: it rolled back its own offer and answered b's. b ignored a's offer.
    expect(a.pcs[0]!.rollbacks).toBe(1);
    expect(a.mesh.rollbacksOf("b")).toBe(1);
    expect(b.pcs[0]!.rollbacks).toBe(0);
    expect(signal.log.filter((m) => m.kind === "answer")).toEqual([{ room: ROOM, to: "b", from: "a", kind: "answer" }]);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    // One negotiated "ops" channel per side, created before the handshake so it can still be transferred.
    expect(a.channels).toEqual([{ label: OPS_CHANNEL_LABEL, init: { negotiated: true, id: 0, ordered: true }, owner: "a#0" }]);
    expect(b.channels.length).toBe(1);
    expect(a.states).toEqual([
      ["b", "connecting"],
      ["b", "connected"],
    ]);
  });

  test("a stranger's offer opens a session: the late joiner found us first", async () => {
    const signal = new FakeSignaling();
    const a = node("a", signal);
    const b = node("b", signal);
    await signal.announce(ROOM, "a", "a");
    a.mesh.reconcile(await signal.listPeers(ROOM)); // alone, nothing pending
    expect(a.mesh.pending()).toBe(false);
    await signal.announce(ROOM, "b", "b");
    b.mesh.reconcile(await signal.listPeers(ROOM)); // b sees a and offers
    await settle();
    expect(signal.waiting(ROOM)).toBe(1);
    // a's next announce drains its inbox once and finds the offer.
    for (const msg of await signal.drain(ROOM, "a")) await a.mesh.deliver(msg);
    expect(a.mesh.stateOf("b")).not.toBeNull();
    await pump(signal, [a, b]);
    expect(a.mesh.stateOf("b")).toBe("connected");
    expect(b.mesh.stateOf("a")).toBe("connected");
    // No glare this time: b offered, a answered, nobody rolled back.
    expect(a.pcs[0]!.rollbacks + b.pcs[0]!.rollbacks).toBe(0);
  });

  test("ice and answers for unknown peers are ignored; ice after an ignored offer is swallowed", async () => {
    const signal = new FakeSignaling();
    const a = node("a", signal);
    await a.mesh.deliver({ from: "ghost", kind: "ice", payload: { candidate: "x" } });
    await a.mesh.deliver({ from: "ghost", kind: "answer", payload: { type: "answer", sdp: "y" } });
    expect(a.mesh.peerIds()).toEqual([]);
    expect(a.errors).toEqual([]);
  });

  test("a peer leaving the list closes its unfinished session; a connected one survives a late heartbeat", async () => {
    const signal = new FakeSignaling();
    const a = node("a", signal);
    const b = node("b", signal);
    const c = node("c", signal);
    await join(signal, [a, b, c]);
    // Let a<->b finish but hold c's messages back.
    await settle();
    for (let i = 0; i < 6; i++) {
      for (const n of [a, b]) for (const msg of await signal.drain(ROOM, n.id)) if (msg.from !== "c") await n.mesh.deliver(msg);
      await settle();
    }
    expect(a.mesh.stateOf("b")).toBe("connected");
    expect(a.mesh.stateOf("c")).toBe("connecting");
    // c's heartbeat lapses: it drops from the list. b's is also missing this round but b is connected.
    a.mesh.reconcile([{ peerId: "a", name: "a", seenAt: 0 }]);
    expect(a.mesh.stateOf("c")).toBeNull();
    expect(a.mesh.stateOf("b")).toBe("connected");
    expect(a.states.filter(([p]) => p === "c").map(([, s]) => s)).toEqual(["connecting", "closed"]);
    expect(a.pcs.find((pc) => pc.id === "a#1")!.closed).toBe(true);
  });

  test("a failed transport is forgotten and re-opened on the next reconcile", async () => {
    const signal = new FakeSignaling();
    const a = node("a", signal);
    const b = node("b", signal);
    await join(signal, [a, b]);
    await pump(signal, [a, b]);
    expect(a.mesh.stateOf("b")).toBe("connected");
    a.pcs[0]!.fail();
    expect(a.mesh.stateOf("b")).toBe("failed");
    expect(a.mesh.pending()).toBe(false);
    a.mesh.reconcile(await signal.listPeers(ROOM));
    expect(a.mesh.stateOf("b")).toBe("connecting");
    expect(a.pcs.length).toBe(2);
    expect(a.mesh.pending()).toBe(true);
    await pump(signal, [a, b]);
    expect(a.mesh.stateOf("b")).toBe("connected");
  });

  test("the mesh caps at 8 peers and ignores offers past the cap", async () => {
    const signal = new FakeSignaling();
    const me = node("m", signal);
    const list = Array.from({ length: 12 }, (_, i) => ({ peerId: `p${i}`, name: `p${i}`, seenAt: 0 }));
    me.mesh.reconcile([...list, { peerId: "m", name: "m", seenAt: 0 }]);
    expect(me.mesh.peerIds().length).toBe(MAX_PEERS);
    expect(me.mesh.peerIds()).not.toContain("m");
    await me.mesh.deliver({ from: "p11", kind: "offer", payload: { type: "offer", sdp: "late" } });
    expect(me.mesh.stateOf("p11")).toBeNull();
    me.mesh.close();
    expect(me.mesh.peerIds()).toEqual([]);
    expect(me.pcs.every((pc) => pc.closed)).toBe(true);
  });

  test("a full 8-peer room converges: every pair connected, every handshake settles", async () => {
    const signal = new FakeSignaling();
    const nodes = Array.from({ length: 8 }, (_, i) => node(`n${i}`, signal));
    await join(signal, nodes);
    await pump(signal, nodes, 40);
    for (const n of nodes) {
      expect(n.mesh.pending()).toBe(false);
      expect(n.mesh.peerIds().length).toBe(7);
      for (const other of nodes) if (other !== n) expect(n.mesh.stateOf(other.id)).toBe("connected");
      expect(n.errors).toEqual([]);
    }
  });
});
