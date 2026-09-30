import { describe, expect, test } from "bun:test";
import {
  createChannel,
  openChannel,
  sabAvailable,
  SabTransport,
  type ChannelKind,
  type Transport,
} from "../../src/threads";

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

function pair(kind: ChannelKind, capacity?: number): [Transport, Transport] {
  const channel = createChannel({ transport: kind, capacity });
  expect(channel.kind).toBe(kind);
  return [channel.transport, openChannel(channel.handle)];
}

for (const kind of ["sab", "message"] as const) {
  describe(`${kind} transport`, () => {
    test("delivers 10k messages in order, both directions", async () => {
      const [a, b] = pair(kind);
      const atB: [number, unknown][] = [];
      const atA: [number, unknown][] = [];
      b.onMessage((k, v) => atB.push([k, v]));
      a.onMessage((k, v) => atA.push([k, v]));
      for (let i = 0; i < 10_000; i++) {
        a.send(i % 256, { i });
        b.send(255 - (i % 256), i);
      }
      await until(() => atB.length === 10_000 && atA.length === 10_000);
      for (let i = 0; i < 10_000; i++) {
        expect(atB[i]).toEqual([i % 256, { i }]);
        expect(atA[i]).toEqual([255 - (i % 256), i]);
      }
      a.close();
      b.close();
    });

    test("unsubscribe stops a listener; close stops delivery", async () => {
      const [a, b] = pair(kind);
      let kept = 0;
      let dropped = 0;
      const off = b.onMessage(() => dropped++);
      b.onMessage(() => kept++);
      a.send(0, 1);
      await until(() => kept === 1);
      expect(dropped).toBe(1);
      off();
      a.send(0, 2);
      await until(() => kept === 2);
      expect(dropped).toBe(1);
      b.close();
      a.send(0, 3);
      await new Promise((r) => setTimeout(r, 20));
      expect(kept).toBe(2);
      a.close();
    });

    test("carries undefined, null, strings and nested objects", async () => {
      const [a, b] = pair(kind);
      const got: unknown[] = [];
      b.onMessage((_k, v) => got.push(v));
      const values = [undefined, null, "", "x", 0, -1.5, [1, [2]], { a: { b: 1 } }];
      for (const v of values) a.send(9, v);
      await until(() => got.length === values.length);
      expect(got).toEqual(values);
      a.close();
      b.close();
    });
  });
}

describe("SabTransport backpressure", () => {
  test("queues when the ring is full and drains in order", async () => {
    const [a, b] = pair("sab", 64);
    const got: number[] = [];
    b.onMessage((_k, v) => got.push(v as number));
    for (let i = 0; i < 500; i++) a.send(1, i);
    expect((a as SabTransport).backlog).toBeGreaterThan(0);
    await until(() => got.length === 500);
    expect(got).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect((a as SabTransport).backlog).toBe(0);
    a.close();
    b.close();
  });

  test("rejects values that can never fit", () => {
    const [a, b] = pair("sab", 64);
    expect(() => a.send(0, "x".repeat(60))).toThrow(/exceeds the ring limit/);
    a.close();
    b.close();
  });
});

describe("createChannel", () => {
  test("auto picks SAB in Bun and message when asked", () => {
    expect(sabAvailable()).toBe(true);
    const auto = createChannel();
    expect(auto.kind).toBe("sab");
    expect(auto.handle.kind).toBe("sab");
    expect(auto.transfer).toEqual([]);
    auto.transport.close();

    const msg = createChannel({ transport: "message" });
    expect(msg.handle.kind).toBe("message");
    expect(msg.transfer.length).toBe(1);
    msg.transport.close();
    openChannel(msg.handle).close();
  });
});
