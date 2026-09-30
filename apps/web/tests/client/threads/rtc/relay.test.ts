import { describe, expect, test } from "bun:test";

import type { Transport } from "@calvinjs/active-state/threads";

import { BROADCAST, isRelayFrame, RELAY_CLOSE, RELAY_IN, RELAY_OPEN, RELAY_OUT, RelayClient, RelayHost, type ChannelLike, type RelayedChannel } from "client/threads/rtc/relay";

/** Two `Transport`s wired back to back, synchronous, like the SAB ring without the ring. */
function transportPair(): [Transport, Transport, { frames: [number, unknown][] }] {
  const log = { frames: [] as [number, unknown][] };
  const make = (): Transport & { peer?: Transport & { listeners: Set<(k: number, v: unknown) => void> }; listeners: Set<(k: number, v: unknown) => void> } => {
    const t = {
      listeners: new Set<(k: number, v: unknown) => void>(),
      peer: undefined as (Transport & { listeners: Set<(k: number, v: unknown) => void> }) | undefined,
      send(k: number, v: unknown) {
        log.frames.push([k, JSON.parse(JSON.stringify(v))]);
        for (const cb of t.peer!.listeners) cb(k, JSON.parse(JSON.stringify(v)));
      },
      onMessage(cb: (k: number, v: unknown) => void) {
        t.listeners.add(cb);
        return () => void t.listeners.delete(cb);
      },
      close() {
        t.listeners.clear();
      },
    };
    return t;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b, log];
}

class FakeDataChannel implements ChannelLike {
  readyState = "connecting";
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
  }
  open() {
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }
  receive(text: string) {
    this.onmessage?.(new MessageEvent("message", { data: text }));
  }
}

describe("relay framing", () => {
  test("frames carry a peer id and optional text; anything else is dropped", () => {
    expect(isRelayFrame({ peerId: "p" })).toBe(true);
    expect(isRelayFrame({ peerId: "p", text: "x" })).toBe(true);
    expect(isRelayFrame({ peerId: 1 })).toBe(false);
    expect(isRelayFrame({ peerId: "p", text: 2 })).toBe(false);
    expect(isRelayFrame(null)).toBe(false);
    expect(new Set([RELAY_IN, RELAY_OUT, RELAY_OPEN, RELAY_CLOSE]).size).toBe(4);
  });

  test("open, inbound text, outbound text, broadcast and close cross the transport as frames", () => {
    const [main, worker, log] = transportPair();
    const host = new RelayHost(main);
    const opened: RelayedChannel[] = [];
    const received: [string, string][] = [];
    const closed: string[] = [];
    const client = new RelayClient(worker, (ch) => {
      opened.push(ch);
      ch.onmessage = (ev) => received.push([ch.peerId, ev.data as string]);
      ch.onclose = () => closed.push(ch.peerId);
    });

    const chA = new FakeDataChannel();
    const chB = new FakeDataChannel();
    host.attach("a", chA);
    host.attach("b", chB);
    expect(client.size()).toBe(0); // nothing until the real channel opens
    chA.open();
    expect(log.frames.at(-1)).toEqual([RELAY_OPEN, { peerId: "a" }]);
    expect(opened.map((c) => c.peerId)).toEqual(["a"]);
    expect(opened[0]!.readyState).toBe("open");

    chA.receive('{"type":"cursor","lon":1,"lat":2}');
    expect(log.frames.at(-1)).toEqual([RELAY_IN, { peerId: "a", text: '{"type":"cursor","lon":1,"lat":2}' }]);
    expect(received).toEqual([["a", '{"type":"cursor","lon":1,"lat":2}']]);

    opened[0]!.send("hello a");
    expect(log.frames.at(-1)).toEqual([RELAY_OUT, { peerId: "a", text: "hello a" }]);
    expect(chA.sent).toEqual(["hello a"]);

    chB.open();
    client.broadcast("all");
    expect(log.frames.at(-1)).toEqual([RELAY_OUT, { peerId: BROADCAST, text: "all" }]);
    expect(chA.sent).toEqual(["hello a", "all"]);
    expect(chB.sent).toEqual(["all"]);

    // A closed real channel tells the worker; a worker-side close tells main to close the real one.
    chA.close();
    expect(closed).toEqual(["a"]);
    expect(client.size()).toBe(1);
    opened[1]!.close();
    expect(log.frames.at(-1)).toEqual([RELAY_CLOSE, { peerId: "b" }]);
    expect(chB.readyState).toBe("closed");
    expect(host.size()).toBe(0);
    expect(client.size()).toBe(0);
  });

  test("a channel attached already open reports open at once; a send to a closed channel is dropped", () => {
    const [main, worker] = transportPair();
    const host = new RelayHost(main);
    const opened: RelayedChannel[] = [];
    new RelayClient(worker, (ch) => opened.push(ch));
    const ch = new FakeDataChannel();
    ch.readyState = "open";
    host.attach("z", ch);
    expect(opened.map((c) => c.peerId)).toEqual(["z"]);
    ch.readyState = "closed";
    opened[0]!.send("late");
    expect(ch.sent).toEqual([]);
    host.close();
  });

  test("re-attaching a peer replaces its channel and closes the old one", () => {
    const [main, worker] = transportPair();
    const host = new RelayHost(main);
    new RelayClient(worker, () => {});
    const old = new FakeDataChannel();
    const fresh = new FakeDataChannel();
    host.attach("p", old);
    host.attach("p", fresh);
    expect(old.readyState).toBe("closed");
    expect(host.size()).toBe(1);
  });
});
