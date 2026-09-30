import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import worker from "../src/index";
import { DRAIN_LIMIT, MAX_BODY_BYTES, PEER_TTL_MS, STUN_ONLY, TURN_TTL_S, type Env, type InboxMessage, type Peer } from "../src/signal";
import { MemR2 } from "./mem-r2";

const PROD = "https://inversa.calvinmaighan.dev";
const DEV = "http://localhost:3050";
const EVIL = "https://evil.example";
const BASE = "https://signal.test";

let bucket: MemR2;
let env: Env;

beforeEach(() => {
  bucket = new MemR2();
  env = { SIGNAL: bucket, ALLOWED_ORIGIN: `${PROD}, ${DEV}` };
});

afterEach(() => {
  setSystemTime();
});

function call(method: string, path: string, opts: { body?: unknown; raw?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers(opts.headers);
  const origin = opts.origin === undefined ? PROD : opts.origin;
  if (origin !== null) headers.set("Origin", origin);
  let body: string | undefined = opts.raw;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set("Content-Type", "application/json");
  }
  return worker.fetch(new Request(BASE + path, { method, headers, body }), env);
}

const announce = (room: string, peerId: string, name = peerId) => call("POST", `/rooms/${room}/peers`, { body: { peerId, name } });
const peers = async (room: string) => (await (await call("GET", `/rooms/${room}/peers`)).json()) as Peer[];
const send = (room: string, to: string, from: string, kind: string, payload: unknown) =>
  call("POST", `/rooms/${room}/inbox/${to}`, { body: { from, kind, payload } });
const inbox = async (room: string, peer: string) => (await (await call("GET", `/rooms/${room}/inbox/${peer}`)).json()) as InboxMessage[];

function expectCorp(res: Response) {
  expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
}

async function expectError(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Content-Type")).toStartWith("application/json");
  const body = (await res.json()) as { error: unknown };
  expect(typeof body.error).toBe("string");
  expectCorp(res);
  return body.error as string;
}

describe("CORS and CORP", () => {
  test("CORS: allowed origin is echoed with Vary, and CORP is set", async () => {
    const res = await call("GET", "/rooms/demo/peers");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
    expect(res.headers.get("Vary")).toBe("Origin");
    expectCorp(res);
  });

  test("CORS: every origin in the comma-separated list is allowed", async () => {
    const res = await call("GET", "/rooms/demo/peers", { origin: DEV });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(DEV);
  });

  test("CORS: disallowed origin gets 403 and no allow header, CORP still set", async () => {
    for (const origin of [EVIL, "null", `${PROD}.evil.example`, "http://inversa.calvinmaighan.dev"]) {
      const res = await call("GET", "/rooms/demo/peers", { origin });
      await expectError(res, 403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  test("CORS: disallowed origin cannot write through a simple POST", async () => {
    const res = await call("POST", "/rooms/demo/inbox/bob", {
      origin: EVIL,
      raw: JSON.stringify({ from: "mallory", kind: "offer", payload: {} }),
      headers: { "Content-Type": "text/plain" },
    });
    await expectError(res, 403);
    expect(bucket.objects.size).toBe(0);
  });

  test("CORS: preflight from allowed origin", async () => {
    const res = await call("OPTIONS", "/rooms/demo/inbox/bob", {
      headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expectCorp(res);
  });

  test("CORS: preflight from disallowed origin gets no allow headers", async () => {
    const res = await call("OPTIONS", "/rooms/demo/peers", { origin: EVIL, headers: { "Access-Control-Request-Method": "POST" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expectCorp(res);
  });

  test("CORS: request without Origin (curl, server) works without an allow header", async () => {
    const res = await call("GET", "/rooms/demo/peers", { origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expectCorp(res);
  });

  test("CORP: set on every status the worker produces", async () => {
    const cases: Array<[Promise<Response>, number]> = [
      [announce("demo", "a"), 204],
      [call("GET", "/rooms/demo/peers"), 200],
      [call("GET", "/turn"), 200],
      [call("OPTIONS", "/turn"), 204],
      [call("GET", "/rooms/bad!room/peers"), 400],
      [call("GET", "/nope"), 404],
      [call("DELETE", "/rooms/demo/peers"), 405],
      [call("POST", "/rooms/demo/peers", { raw: "x".repeat(MAX_BODY_BYTES + 1) }), 413],
      [call("GET", "/rooms/demo/peers", { origin: EVIL }), 403],
    ];
    for (const [pending, status] of cases) {
      const res = await pending;
      expect(res.status).toBe(status);
      expectCorp(res);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("CORP: set on a 500 from a failing bucket, with a JSON error", async () => {
    bucket.get = () => Promise.reject(new Error("r2 down"));
    const err = spyOn(console, "error").mockImplementation(() => {});
    const res = await call("GET", "/rooms/demo/peers");
    expect(await expectError(res, 500)).toBe("internal error");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
    err.mockRestore();
  });
});

describe("peers", () => {
  test("empty room lists []", async () => {
    expect(await peers("demo")).toEqual([]);
  });

  test("announce returns 204 and the peer is listed with seenAt", async () => {
    setSystemTime(new Date(1_800_000_000_000));
    const res = await announce("demo", "alice", "Alice");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await peers("demo")).toEqual([{ peerId: "alice", name: "Alice", seenAt: 1_800_000_000_000 }]);
    expect([...bucket.objects.keys()]).toEqual(["rooms/demo/peers.json"]);
  });

  test("heartbeat refreshes seenAt and name without duplicating", async () => {
    setSystemTime(new Date(1_800_000_000_000));
    await announce("demo", "alice", "Alice");
    await announce("demo", "bob", "Bob");
    setSystemTime(new Date(1_800_000_030_000));
    await announce("demo", "alice", "Alice R");
    const list = await peers("demo");
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.peerId === "alice")).toEqual({ peerId: "alice", name: "Alice R", seenAt: 1_800_000_030_000 });
    expect(list.find((p) => p.peerId === "bob")?.seenAt).toBe(1_800_000_000_000);
  });

  test("entries older than 60 s are hidden from GET and pruned on the next write", async () => {
    const t0 = 1_800_000_000_000;
    setSystemTime(new Date(t0));
    await announce("demo", "alice");
    setSystemTime(new Date(t0 + 30_000));
    await announce("demo", "bob");

    setSystemTime(new Date(t0 + PEER_TTL_MS - 1));
    expect((await peers("demo")).map((p) => p.peerId).sort()).toEqual(["alice", "bob"]);

    setSystemTime(new Date(t0 + PEER_TTL_MS));
    expect((await peers("demo")).map((p) => p.peerId)).toEqual(["bob"]);
    // Still stored until a write prunes it.
    expect(bucket.objects.get("rooms/demo/peers.json")!.value).toContain("alice");

    await announce("demo", "carol");
    const stored = JSON.parse(bucket.objects.get("rooms/demo/peers.json")!.value) as Peer[];
    expect(stored.map((p) => p.peerId).sort()).toEqual(["bob", "carol"]);

    setSystemTime(new Date(t0 + 30_000 + PEER_TTL_MS));
    expect((await peers("demo")).map((p) => p.peerId)).toEqual(["carol"]);
  });

  test("rooms are isolated", async () => {
    await announce("r1", "alice");
    await announce("r2", "bob");
    expect((await peers("r1")).map((p) => p.peerId)).toEqual(["alice"]);
    expect((await peers("r2")).map((p) => p.peerId)).toEqual(["bob"]);
  });

  test("concurrent announces lose no update (etag compare-and-swap retries)", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
    const results = await Promise.all(ids.map((id) => announce("board", id)));
    expect(results.map((r) => r.status)).toEqual(ids.map(() => 204));
    expect((await peers("board")).map((p) => p.peerId).sort()).toEqual(ids);
    // Contention really happened: some writes were rejected by the precondition and retried.
    expect(bucket.calls.putRejected).toBeGreaterThan(0);
  });

  test("concurrent announces into a fresh room: only one create wins, the rest retry", async () => {
    const results = await Promise.all([announce("fresh", "a"), announce("fresh", "b")]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    expect((await peers("fresh")).map((p) => p.peerId).sort()).toEqual(["a", "b"]);
    expect(bucket.calls.putRejected).toBeGreaterThanOrEqual(1);
  });

  test("a write that never wins the precondition gives up with 503", async () => {
    bucket.put = async () => null;
    const res = await announce("demo", "alice");
    expect(await expectError(res, 503)).toContain("busy");
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  test("a corrupt peers.json is replaced instead of wedging the room", async () => {
    await bucket.put("rooms/demo/peers.json", "{not json");
    expect(await peers("demo")).toEqual([]);
    expect((await announce("demo", "alice")).status).toBe(204);
    expect((await peers("demo")).map((p) => p.peerId)).toEqual(["alice"]);
  });

  test("validation: peerId and name", async () => {
    const bad: unknown[] = [
      {},
      { name: "x" },
      { peerId: "", name: "x" },
      { peerId: "a b", name: "x" },
      { peerId: "a".repeat(65), name: "x" },
      { peerId: 7, name: "x" },
      { peerId: "alice" },
      { peerId: "alice", name: "" },
      { peerId: "alice", name: 5 },
      { peerId: "alice", name: "n".repeat(65) },
    ];
    for (const body of bad) await expectError(await call("POST", "/rooms/demo/peers", { body }), 400);
    expect(bucket.objects.size).toBe(0);
    expect((await announce("demo", "a".repeat(64), "n".repeat(64))).status).toBe(204);
  });
});

describe("inbox", () => {
  test("offer, answer and ice are returned in send order, then deleted", async () => {
    const offer = { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" };
    const ice = { candidate: "candidate:1 1 udp 2122260223 10.0.0.2 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    let t = 1_800_000_000_000;
    for (const [kind, payload] of [["offer", offer], ["ice", ice], ["ice", null]] as const) {
      setSystemTime(new Date(t++));
      expect((await send("demo", "bob", "alice", kind, payload)).status).toBe(204);
    }
    const keys = [...bucket.objects.keys()];
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k).toMatch(/^rooms\/demo\/inbox\/bob\/\d{13}-[0-9a-f]{16}\.json$/);

    const got = await inbox("demo", "bob");
    expect(got.map((m) => [m.from, m.kind, m.payload])).toEqual([
      ["alice", "offer", offer],
      ["alice", "ice", ice],
      ["alice", "ice", null],
    ]);
    expect(got[0]!.sentAt).toBe(1_800_000_000_000);
    expect(await inbox("demo", "bob")).toEqual([]);
    expect(bucket.objects.size).toBe(0);
  });

  test("messages stored in the same millisecond keep send order", async () => {
    setSystemTime(new Date(1_800_000_000_000));
    for (let i = 0; i < 20; i++) await send("demo", "bob", "alice", "ice", { n: i });
    expect((await inbox("demo", "bob")).map((m) => (m.payload as { n: number }).n)).toEqual([...Array(20).keys()]);
  });

  test("inboxes are isolated per peer and per room", async () => {
    await send("r1", "bob", "alice", "offer", "to-bob");
    await send("r1", "carol", "alice", "offer", "to-carol");
    await send("r2", "bob", "alice", "offer", "other-room");
    expect((await inbox("r1", "bob")).map((m) => m.payload)).toEqual(["to-bob"]);
    expect((await inbox("r1", "carol")).map((m) => m.payload)).toEqual(["to-carol"]);
    expect((await inbox("r2", "bob")).map((m) => m.payload)).toEqual(["other-room"]);
  });

  test("a drain is bounded; the remainder arrives on the next poll", async () => {
    const total = DRAIN_LIMIT + 8;
    for (let i = 0; i < total; i++) await send("demo", "bob", "alice", "ice", i);
    const first = await inbox("demo", "bob");
    expect(first.map((m) => m.payload)).toEqual([...Array(DRAIN_LIMIT).keys()]);
    const second = await inbox("demo", "bob");
    expect(second.map((m) => m.payload)).toEqual([...Array(8).keys()].map((i) => i + DRAIN_LIMIT));
    expect(await inbox("demo", "bob")).toEqual([]);
  });

  test("an unreadable stored message is dropped, the rest still arrive", async () => {
    await send("demo", "bob", "alice", "offer", "ok");
    await bucket.put("rooms/demo/inbox/bob/0000000000000-garbage.json", "{broken");
    expect((await inbox("demo", "bob")).map((m) => m.payload)).toEqual(["ok"]);
    expect(bucket.objects.size).toBe(0);
  });

  test("validation: from, kind and payload", async () => {
    const bad: unknown[] = [
      { kind: "offer", payload: {} },
      { from: "bad id", kind: "offer", payload: {} },
      { from: "alice", payload: {} },
      { from: "alice", kind: "bye", payload: {} },
      { from: "alice", kind: "OFFER", payload: {} },
      { from: "alice", kind: 1, payload: {} },
      { from: "alice", kind: "ice" },
    ];
    for (const body of bad) await expectError(await call("POST", "/rooms/demo/inbox/bob", { body }), 400);
    expect(bucket.objects.size).toBe(0);
  });
});

describe("request validation and routing", () => {
  test("room and peer ids in the path must match the id pattern", async () => {
    const paths = [
      "/rooms/bad.room/peers",
      `/rooms/${"r".repeat(65)}/peers`,
      "/rooms/%41lice/peers",
      "/rooms/demo/inbox/bad.peer",
      `/rooms/demo/inbox/${"p".repeat(65)}`,
      "/rooms/de%2Fmo/inbox/bob",
    ];
    for (const path of paths) {
      expect(await expectError(await call("GET", path), 400)).toMatch(/(room|peer) must match/);
    }
    expect((await call("GET", `/rooms/${"r".repeat(64)}/inbox/A-z_09`)).status).toBe(200);
  });

  test("body over 64 KB is 413, by content-length or by counted bytes", async () => {
    const big = { from: "alice", kind: "offer", payload: "x".repeat(MAX_BODY_BYTES) };
    expect(await expectError(await call("POST", "/rooms/demo/inbox/bob", { body: big }), 413)).toContain("65536");

    // Streamed body without a content-length header.
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const req = new Request(`${BASE}/rooms/demo/peers`, { method: "POST", body: stream, headers: { Origin: PROD } });
    expect(req.headers.get("content-length")).toBeNull();
    await expectError(await worker.fetch(req, env), 413);
    expect(bucket.objects.size).toBe(0);
  });

  test("body at exactly the cap is accepted", async () => {
    const skeleton = JSON.stringify({ from: "alice", kind: "offer", payload: "" });
    const payload = "x".repeat(MAX_BODY_BYTES - skeleton.length);
    const raw = JSON.stringify({ from: "alice", kind: "offer", payload });
    expect(raw.length).toBe(MAX_BODY_BYTES);
    expect((await call("POST", "/rooms/demo/inbox/bob", { raw })).status).toBe(204);
  });

  test("malformed bodies are 400", async () => {
    for (const raw of ["", "{", "[]", "null", "42", '"s"']) {
      await expectError(await call("POST", "/rooms/demo/peers", { raw }), 400);
    }
    await expectError(await call("POST", "/rooms/demo/peers"), 400);
  });

  test("unknown routes are 404", async () => {
    for (const path of ["/", "/rooms", "/rooms/demo", "/rooms/demo/peers/extra", "/rooms/demo/inbox", "/rooms/demo/inbox/bob/x", "/turn/x", "/rooms/demo/other"]) {
      await expectError(await call("GET", path), 404);
    }
  });

  test("wrong methods are 405 with Allow", async () => {
    for (const [method, path, allow] of [
      ["PUT", "/rooms/demo/peers", "GET, POST, OPTIONS"],
      ["DELETE", "/rooms/demo/inbox/bob", "GET, POST, OPTIONS"],
      ["PATCH", "/rooms/demo/peers", "GET, POST, OPTIONS"],
      ["POST", "/turn", "GET, OPTIONS"],
    ] as const) {
      const res = await call(method, path);
      await expectError(res, 405);
      expect(res.headers.get("Allow")).toBe(allow);
    }
  });
});

describe("turn", () => {
  test("without secrets: public STUN only, no upstream call", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const res = await call("GET", "/turn");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] });
    expect(STUN_ONLY).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("with secrets: mints credentials from the Realtime TURN API, drops port 53", async () => {
    env.CF_TURN_KEY_ID = "key-123";
    env.CF_TURN_KEY_TOKEN = "tok-456";
    const upstream = {
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:53?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "u",
          credential: "c",
        },
      ],
    };
    let seen: Request | undefined;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
      seen = new Request(input, init);
      return Response.json(upstream, { status: 201 });
    }) as typeof fetch);

    const res = await call("GET", "/turn");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "u",
          credential: "c",
        },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers");
    expect(seen!.headers.get("Authorization")).toBe("Bearer tok-456");
    expect(await seen!.json()).toEqual({ ttl: TURN_TTL_S });
    expect(TURN_TTL_S).toBe(3600);
    fetchSpy.mockRestore();
  });

  test("legacy single-object iceServers shape is normalized to an array", async () => {
    env.CF_TURN_KEY_ID = "k";
    env.CF_TURN_KEY_TOKEN = "t";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ iceServers: { urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" } })) as unknown as typeof fetch);
    expect(await (await call("GET", "/turn")).json()).toEqual({
      iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }],
    });
    fetchSpy.mockRestore();
  });

  test("upstream failure falls back to STUN only", async () => {
    env.CF_TURN_KEY_ID = "k";
    env.CF_TURN_KEY_TOKEN = "t";
    const err = spyOn(console, "error").mockImplementation(() => {});
    for (const impl of [
      async () => new Response("unauthorized", { status: 401 }),
      async () => Response.json({ iceServers: [] }),
      async () => {
        throw new TypeError("network down");
      },
    ]) {
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl as unknown as typeof fetch);
      const res = await call("GET", "/turn");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ iceServers: STUN_ONLY });
      fetchSpy.mockRestore();
    }
    expect(err).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });
});
