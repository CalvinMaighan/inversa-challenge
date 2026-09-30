import { afterEach, describe, expect, test } from "bun:test";
import { get, init, reset, set, subscribe } from "../../src/core";
import {
  hostThread,
  keyIndexTable,
  type HostThreadOptions,
} from "../../src/threads";
import { CATALOG } from "./echo";

async function until(
  cond: () => boolean,
  describe: () => string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${describe()}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

afterEach(() => {
  reset();
});

type FromWorker = { kind?: string; count?: number };

async function roundTrip(
  script: string,
  options: HostThreadOptions,
  expectKind: string,
): Promise<void> {
  init({ ...CATALOG });
  set("COUNT", 42);
  const worker = new Worker(new URL(script, import.meta.url).href);
  const fromWorker: FromWorker = {};
  worker.addEventListener("message", (ev) => {
    Object.assign(fromWorker, ev.data as FromWorker);
  });
  const link = hostThread(worker, { ...CATALOG }, options);
  const pongs: number[] = [];
  subscribe("PONG", (v) => {
    if (v !== 0) pongs.push(v as number);
  });

  const total = 10_000;
  for (let i = 1; i <= total; i++) set("PING", i);
  await until(
    () => pongs.length === total,
    () => `pongs=${pongs.length} worker=${JSON.stringify(fromWorker)}`,
  );
  expect(pongs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  expect(get<number>("PONG")).toBe(total);

  await until(
    () => fromWorker.kind !== undefined && fromWorker.count !== undefined,
    () => `worker=${JSON.stringify(fromWorker)}`,
  );
  expect(fromWorker.kind).toBe(expectKind);
  expect(fromWorker.count).toBe(42);

  link.close();
  worker.terminate();
}

describe("hostThread", () => {
  test("worker round trip over SAB: 10k messages in order", async () => {
    await roundTrip("./echo.worker.ts", { transport: "sab" }, "sab");
  });

  test("worker round trip over postMessage fallback: 10k messages in order", async () => {
    await roundTrip("./echo.worker.ts", { transport: "message" }, "message");
  });

  test("worker round trip over SAB with a sliced Atomics.wait reader", async () => {
    await roundTrip("./echo-sync.worker.ts", { transport: "sab" }, "sab");
  });

  test("worker round trip still works after the worker sat idle", async () => {
    // A worker whose loop holds only a parked Atomics.waitAsync would exit in
    // Bun; the transport keeps it alive while open.
    init({ ...CATALOG });
    const worker = new Worker(new URL("./echo.worker.ts", import.meta.url).href);
    const link = hostThread(worker, { ...CATALOG }, { transport: "sab" });
    const pongs: number[] = [];
    subscribe("PONG", (v) => {
      if (v !== 0) pongs.push(v as number);
    });
    await new Promise((r) => setTimeout(r, 300));
    set("PING", 1);
    await until(
      () => pongs.length === 1,
      () => `pongs=${JSON.stringify(pongs)}`,
    );
    expect(pongs).toEqual([1]);
    link.close();
    worker.terminate();
  });

  test("worker round trip does not echo a remote apply back", async () => {
    init({ ...CATALOG });
    const worker = new Worker(new URL("./echo.worker.ts", import.meta.url).href);
    const link = hostThread(worker, { ...CATALOG }, { transport: "sab" });
    // Count what main puts on the wire after the snapshot.
    const transport = link.transport!;
    const send = transport.send.bind(transport);
    let sends = 0;
    transport.send = (k, v) => {
      sends++;
      send(k, v);
    };
    const echoes: string[] = [];
    subscribe("ECHO", (v) => {
      if (v !== "") echoes.push(v as string);
    });
    set("ECHO", "hi");
    await until(
      () => echoes.length >= 2,
      () => `echoes=${JSON.stringify(echoes)}`,
    );
    await new Promise((r) => setTimeout(r, 30));
    // main: "hi" (local) then "hi!" (from worker). Applying "hi!" must not
    // send it back: exactly one outbound message, the original "hi".
    expect(echoes).toEqual(["hi", "hi!"]);
    expect(get<string>("ECHO")).toBe("hi!");
    expect(sends).toBe(1);
    link.close();
    worker.terminate();
  });
});

describe("keyIndexTable", () => {
  test("is the sorted key-id list", () => {
    expect(keyIndexTable({ PONG: 0, ECHO: "", PING: 0 })).toEqual([
      "ECHO",
      "PING",
      "PONG",
    ]);
    expect(keyIndexTable(["B", "A"])).toEqual(["A", "B"]);
  });
});
