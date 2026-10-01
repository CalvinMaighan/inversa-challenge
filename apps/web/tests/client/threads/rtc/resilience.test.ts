import { beforeEach, describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { startLiveStreams, type LiveLink } from "client/hud/messages/live";
import { state } from "client/state";
import { dmThread, MESSAGES, type MessagesState } from "client/state/messages";
import { NOTES, type NotesState } from "client/state/notes";
import type { StreamMessage } from "client/threads/rtc/protocol";
import { admitInbound, MAX_DELTAS_PER_SECOND, RateLimit, StreamReceiver, TYPING_TTL_MS } from "client/threads/rtc/stream";

init(state);

/**
 * Two nodes with a data channel between them, as the rtc worker presents it: a message sent by one lands on the
 * other with `from` set to the sender's id, deltas pass a per-peer token bucket, and `cut()`/`join()` are the
 * channel closing and reopening. Delivery is synchronous unless `hold` is on.
 */
class FakeMesh {
  readonly links = new Map<string, LiveLink & { streams: Set<(m: StreamMessage) => void>; linkCbs: Set<(p: string, s: "open" | "closed") => void> }>();
  readonly sent: { from: string; to: string | null; msg: StreamMessage }[] = [];
  readonly buckets = new Map<string, RateLimit>();
  open = true;
  hold: StreamMessage[] | null = null;
  now = 1_000_000;

  constructor(readonly ids: string[]) {
    for (const id of ids) {
      const streams = new Set<(m: StreamMessage) => void>();
      const linkCbs = new Set<(p: string, s: "open" | "closed") => void>();
      this.links.set(id, {
        streams,
        linkCbs,
        send: (to, msg) => this.deliver(id, to, msg),
        onStream: (cb) => (streams.add(cb), () => void streams.delete(cb)),
        onLink: (cb) => (linkCbs.add(cb), () => void linkCbs.delete(cb)),
      });
    }
  }

  private deliver(from: string, to: string | null, msg: StreamMessage) {
    this.sent.push({ from, to, msg });
    if (!this.open) return;
    for (const [id, link] of this.links) {
      if (id === from || (to !== null && to !== id)) continue;
      const key = `${id}<${from}`;
      let bucket = this.buckets.get(key);
      if (!bucket) this.buckets.set(key, (bucket = new RateLimit()));
      const admitted = admitInbound(JSON.parse(JSON.stringify(msg)) as StreamMessage, from, id, bucket, this.now);
      if (!admitted) continue;
      if (this.hold) this.hold.push(admitted);
      else for (const cb of link.streams) cb(admitted);
    }
  }

  cut() {
    this.open = false;
    for (const [id, link] of this.links) for (const other of this.ids) if (other !== id) for (const cb of link.linkCbs) cb(other, "closed");
  }

  join() {
    this.open = true;
    for (const [id, link] of this.links) for (const other of this.ids) if (other !== id) for (const cb of link.linkCbs) cb(other, "open");
  }
}

const messages = () => get<MessagesState>(MESSAGES) ?? MESSAGES.defaults;
const notes = () => get<NotesState>(NOTES) ?? NOTES.defaults;

beforeEach(() => {
  set(MESSAGES, MESSAGES.defaults);
  set(NOTES, NOTES.defaults);
});

describe("dm resilience", () => {
  test("dm resilience: a flood of 10k deltas in one second is throttled to at most 60 per peer per second", () => {
    const bucket = new RateLimit();
    let admitted = 0;
    const perSecond = new Map<number, number>();
    for (let i = 0; i < 10_000; i++) {
      const at = (i / 10_000) * 1_000;
      const msg: StreamMessage = { type: "dm.delta", thread: "dm:a~b", msgId: "m", from: "x", to: "b", seq: i + 1, at, del: { pos: 0, len: 0 }, ins: "x" };
      if (admitInbound(msg, "a", "b", bucket, at)) {
        admitted++;
        perSecond.set(Math.floor(at / 1000), (perSecond.get(Math.floor(at / 1000)) ?? 0) + 1);
      }
    }
    expect(admitted).toBe(MAX_DELTAS_PER_SECOND);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(MAX_DELTAS_PER_SECOND);
    // A steady 50/s sender (a real keyboard under the one-per-frame cap) is never throttled.
    const steady = new RateLimit();
    let dropped = 0;
    for (let i = 0; i < 500; i++) if (!steady.take(i * 20)) dropped++;
    expect(dropped).toBe(0);
    // Every stream type counts against the same window: a flood of typing flags is dropped too.
    expect(admitInbound({ type: "dm.typing", thread: "dm:a~b", from: "x", on: true }, "a", "b", bucket, 999)).toBeNull();
    // The window slides: a second later a delta passes again.
    expect(admitInbound({ type: "dm.delta", thread: "dm:a~b", msgId: "m", from: "x", to: "b", seq: 1, at: 2_000, del: { pos: 0, len: 0 }, ins: "x" }, "a", "b", bucket, 2_000)).not.toBeNull();
  });

  test("dm resilience: the receiver stays responsive under a flood: 10k deltas apply in one long task under 50 ms", () => {
    const r = new StreamReceiver();
    const deltas = Array.from({ length: 10_000 }, (_, i) => ({ seq: i + 1, del: { pos: i % 7, len: i % 3 }, ins: i % 5 === 0 ? "😀" : "ab" }));
    const t0 = performance.now();
    for (const d of deltas) r.receive(d);
    const ms = performance.now() - t0;
    expect(r.seq).toBe(10_000);
    expect(ms).toBeLessThan(50);
  });

  test("dm resilience: deltas dropped by the throttle leave a gap that one resync and sync heal", () => {
    const mesh = new FakeMesh(["a", "b"]);
    const flushes: (() => void)[] = [];
    const schedule = (cb: () => void) => flushes.push(cb);
    const runFlushes = () => {
      // One frame: callbacks a flush re-arms run on the next frame, not in this loop.
      for (const cb of flushes.splice(0)) cb();
    };
    const a = startLiveStreams({ link: mesh.links.get("a")!, nodeId: "a", persistDm: () => ({ hlc: "hlc", done: Promise.resolve() }), now: () => mesh.now, schedule });
    const b = startLiveStreams({ link: mesh.links.get("b")!, nodeId: "b", persistDm: () => ({ hlc: "hlc", done: Promise.resolve() }), now: () => mesh.now, schedule });
    const composer = a.dm("b");
    composer.update("real");
    mesh.now += 20;
    runFlushes();
    const first = mesh.sent.find((s) => s.msg.type === "dm.delta")!.msg as Extract<StreamMessage, { type: "dm.delta" }>;
    expect(messages().drafts[dmThread("a", "b")]?.text).toBe("real");
    // A hostile or runaway client floods 2 000 deltas on the same stream in 1.5 s, bypassing the frame cap: the
    // first 60 pass, the rest of that second is dropped, and what passes after that is far ahead of b's seq.
    for (let i = 2; i <= 2_000; i++) {
      mesh.now += 0.75;
      mesh.links.get("a")!.send("b", { ...first, seq: i, at: mesh.now, del: { pos: 0, len: 0 }, ins: "z" });
    }
    const resyncs = mesh.sent.filter((s) => s.msg.type === "stream.resync");
    const syncs = mesh.sent.filter((s) => s.msg.type === "stream.sync");
    expect(resyncs.length).toBeGreaterThan(0);
    expect(resyncs.length).toBeLessThan(5); // throttled, not one per dropped delta
    expect(syncs.length).toBe(resyncs.length);
    // b's view is the author's real snapshot, not a garbled run of what the throttle let through.
    expect(messages().drafts[dmThread("a", "b")]?.text).toBe("real");
    const admittedAfter = mesh.sent.filter((s) => s.msg.type === "dm.delta").length;
    expect(admittedAfter).toBe(2_000);
    a.close();
    b.close();
  });

  test("dm resilience: a channel closed mid-message clears the draft and typing on the other side, and reconnect resyncs", () => {
    const mesh = new FakeMesh(["a", "b"]);
    const flushes: (() => void)[] = [];
    const schedule = (cb: () => void) => flushes.push(cb);
    const run = () => {
      // One frame: callbacks a flush re-arms run on the next frame, not in this loop.
      for (const cb of flushes.splice(0)) cb();
    };
    const a = startLiveStreams({ link: mesh.links.get("a")!, nodeId: "a", persistDm: () => ({ hlc: "hlc", done: Promise.resolve() }), now: () => mesh.now, schedule });
    const b = startLiveStreams({ link: mesh.links.get("b")!, nodeId: "b", persistDm: () => ({ hlc: "hlc", done: Promise.resolve() }), now: () => mesh.now, schedule });
    const thread = dmThread("a", "b");
    const composer = a.dm("b");
    composer.update("hello wor");
    mesh.now += 20;
    run();
    expect(messages().drafts[thread]?.text).toBe("hello wor");
    expect(messages().typing[thread]).toBeDefined();

    mesh.cut();
    expect(messages().drafts[thread]).toBeUndefined();
    expect(messages().typing[thread]).toBeUndefined();
    // a keeps typing into the void.
    composer.update("hello world, are you there");
    mesh.now += 20;
    run();
    expect(messages().drafts[thread]).toBeUndefined();

    mesh.join();
    // The author's sync carries the whole text; b shows it again at once.
    expect(messages().drafts[thread]?.text).toBe("hello world, are you there");
    expect(messages().drafts[thread]?.caret).toBe("hello world, are you there".length);
    // Later deltas apply on top of the synced seq.
    composer.update("hello world, are you there?");
    mesh.now += 20;
    run();
    expect(messages().drafts[thread]?.text).toBe("hello world, are you there?");
    a.close();
    b.close();
  });

  test("dm resilience: no ghost typing: presence clears TYPING_TTL_MS after the last delta and at once on commit", async () => {
    const mesh = new FakeMesh(["a", "b"]);
    const flushes: (() => void)[] = [];
    const schedule = (cb: () => void) => flushes.push(cb);
    const run = () => {
      // One frame: callbacks a flush re-arms run on the next frame, not in this loop.
      for (const cb of flushes.splice(0)) cb();
    };
    const persisted: string[] = [];
    const a = startLiveStreams({
      link: mesh.links.get("a")!,
      nodeId: "a",
      persistDm: (_id, _to, _thread, text) => (persisted.push(text), { hlc: "1700000000000:0:a", done: Promise.resolve() }),
      now: () => mesh.now,
      schedule,
    });
    const b = startLiveStreams({ link: mesh.links.get("b")!, nodeId: "b", persistDm: () => ({ hlc: "hlc", done: Promise.resolve() }), now: () => mesh.now, schedule });
    const thread = dmThread("a", "b");
    const composer = a.dm("b");
    composer.update("typing");
    run();
    expect(messages().typing[thread]).toBe(mesh.now);
    expect(TYPING_TTL_MS).toBe(3_000);
    mesh.now += 20;

    // Commit: the other side drops the draft and the typing line in the same breath.
    const id = await composer.commit();
    expect(id).not.toBeNull();
    expect(persisted).toEqual(["typing"]);
    const commit = mesh.sent.find((s) => s.msg.type === "dm.commit")!.msg as Extract<StreamMessage, { type: "dm.commit" }>;
    expect(commit.text).toBe("typing");
    expect(commit.hlc).toBe("1700000000000:0:a");
    expect(messages().drafts[thread]).toBeUndefined();
    expect(messages().typing[thread]).toBeUndefined();

    // A new message after a commit starts a fresh stream (seq from 1, a new id).
    composer.update("again");
    mesh.now += 20;
    run();
    const deltas = mesh.sent.filter((s) => s.msg.type === "dm.delta").map((s) => s.msg as Extract<StreamMessage, { type: "dm.delta" }>);
    expect(deltas.at(-1)!.seq).toBe(1);
    expect(deltas.at(-1)!.msgId).not.toBe(commit.msgId);
    expect(messages().drafts[thread]?.text).toBe("again");
    a.close();
    b.close();
  });

  test("dm resilience: a note stream clears on the editor's channel closing; a late joiner gets a sync", () => {
    const mesh = new FakeMesh(["a", "b"]);
    const flushes: (() => void)[] = [];
    const schedule = (cb: () => void) => flushes.push(cb);
    const run = () => {
      // One frame: callbacks a flush re-arms run on the next frame, not in this loop.
      for (const cb of flushes.splice(0)) cb();
    };
    const a = startLiveStreams({ link: mesh.links.get("a")!, nodeId: "a", persistDm: () => ({ hlc: "hlc", done: Promise.resolve() }), now: () => mesh.now, schedule });
    const b = startLiveStreams({ link: mesh.links.get("b")!, nodeId: "b", persistDm: () => ({ hlc: "hlc", done: Promise.resolve() }), now: () => mesh.now, schedule });
    const editor = a.note("n1", "two pythons");
    expect(notes().live.n1?.text).toBe("two pythons"); // the seq-0 sync announces the edit
    mesh.now += 20;
    editor.update("two pythons by the gate");
    run();
    expect(notes().live.n1).toEqual({ from: "a", text: "two pythons by the gate", caret: "two pythons by the gate".length, at: mesh.now });
    mesh.cut();
    expect(notes().live.n1).toBeUndefined();
    mesh.join();
    expect(notes().live.n1?.text).toBe("two pythons by the gate");
    editor.done();
    a.close();
    b.close();
  });
});
