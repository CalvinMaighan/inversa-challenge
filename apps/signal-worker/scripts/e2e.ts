// Two-peer WebRTC rendezvous against the real Workers runtime: `wrangler dev --local`
// (workerd + Miniflare's local R2, fresh state per run). Prints EXCHANGE-OK as the last
// line on success; on failure prints the wrangler log and EXCHANGE-FAIL, exit code 1.

import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3050";
const ROOM = `e2e-${Date.now().toString(36)}`;
const WRANGLER = "wrangler@4.145.0";
const READY_TIMEOUT_MS = 180_000;

const appDir = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "signal-e2e-"));
const logPath = join(scratch, "wrangler.log");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function isUp(): Promise<boolean> {
  try {
    await fetch(`${BASE}/rooms/probe/peers`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(BASE + path, {
    method,
    headers: { Origin: ORIGIN, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert(res.headers.get("Cross-Origin-Resource-Policy") === "cross-origin", `${method} ${path}: missing CORP`);
  assert(res.headers.get("Access-Control-Allow-Origin") === ORIGIN, `${method} ${path}: missing CORS allow`);
  return res;
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await req("POST", path, body);
  if (res.status !== 204) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
}

async function get<T>(path: string): Promise<T> {
  const res = await req("GET", path);
  if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type Msg = { from: string; kind: string; payload: unknown };
const drain = (peer: string) => get<Msg[]>(`/rooms/${ROOM}/inbox/${peer}`);
const step = (s: string) => console.log(`  ok  ${s}`);

async function exchange(): Promise<void> {
  // Announce both peers at once: the etag compare-and-swap must keep both.
  await Promise.all([
    post(`/rooms/${ROOM}/peers`, { peerId: "alice", name: "Alice" }),
    post(`/rooms/${ROOM}/peers`, { peerId: "bob", name: "Bob" }),
  ]);
  step("announce x2 (concurrent)");

  const peers = await get<Array<{ peerId: string; name: string; seenAt: number }>>(`/rooms/${ROOM}/peers`);
  assert(
    JSON.stringify(peers.map((p) => [p.peerId, p.name]).sort()) === JSON.stringify([["alice", "Alice"], ["bob", "Bob"]]),
    `peer list: ${JSON.stringify(peers)}`,
  );
  assert(peers.every((p) => Math.abs(Date.now() - p.seenAt) < 60_000), "seenAt not current");
  step(`list -> ${peers.map((p) => p.peerId).sort().join(", ")}`);

  const offer = { type: "offer", sdp: "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\n" };
  await post(`/rooms/${ROOM}/inbox/bob`, { from: "alice", kind: "offer", payload: offer });
  const atBob = await drain("bob");
  assert(atBob.length === 1 && atBob[0]!.kind === "offer" && atBob[0]!.from === "alice", `bob inbox: ${JSON.stringify(atBob)}`);
  assert(JSON.stringify(atBob[0]!.payload) === JSON.stringify(offer), "offer payload changed in transit");
  step("alice -> bob offer");

  const answer = { type: "answer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n" };
  await post(`/rooms/${ROOM}/inbox/alice`, { from: "bob", kind: "answer", payload: answer });
  const atAlice = await drain("alice");
  assert(atAlice.length === 1 && atAlice[0]!.kind === "answer" && atAlice[0]!.from === "bob", `alice inbox: ${JSON.stringify(atAlice)}`);
  step("bob -> alice answer");

  const candidates = [0, 1, 2].map((i) => ({
    candidate: `candidate:${i} 1 udp 2122260223 192.168.1.${10 + i} 5${i}000 typ host`,
    sdpMid: "0",
    sdpMLineIndex: 0,
  }));
  for (const c of candidates) await post(`/rooms/${ROOM}/inbox/bob`, { from: "alice", kind: "ice", payload: c });
  await post(`/rooms/${ROOM}/inbox/alice`, { from: "bob", kind: "ice", payload: candidates[0] });
  const iceBob = await drain("bob");
  assert(
    JSON.stringify(iceBob.map((m) => m.payload)) === JSON.stringify(candidates) && iceBob.every((m) => m.kind === "ice"),
    `bob ice (order matters): ${JSON.stringify(iceBob)}`,
  );
  const iceAlice = await drain("alice");
  assert(iceAlice.length === 1 && iceAlice[0]!.kind === "ice", `alice ice: ${JSON.stringify(iceAlice)}`);
  step("ice both ways, in send order");

  const [emptyBob, emptyAlice] = await Promise.all([drain("bob"), drain("alice")]);
  assert(emptyBob.length === 0 && emptyAlice.length === 0, `inbox not drained: ${JSON.stringify([emptyBob, emptyAlice])}`);
  step("inboxes drained to empty");

  const turn = await get<{ iceServers: Array<{ urls: string[] }> }>("/turn");
  assert(turn.iceServers.length > 0 && turn.iceServers[0]!.urls.length > 0, `turn: ${JSON.stringify(turn)}`);
  step(`turn -> ${turn.iceServers.flatMap((s) => s.urls).join(" ")}`);

  // A full 8-peer board announcing at once against the runtime's own R2 preconditions.
  const mesh = Array.from({ length: 8 }, (_, i) => `p${i}`);
  await Promise.all(mesh.map((peerId) => post(`/rooms/${ROOM}-mesh/peers`, { peerId, name: peerId })));
  const meshList = (await get<Array<{ peerId: string }>>(`/rooms/${ROOM}-mesh/peers`)).map((p) => p.peerId).sort();
  assert(JSON.stringify(meshList) === JSON.stringify(mesh), `lost update under concurrency: ${JSON.stringify(meshList)}`);
  step("8 concurrent announces, none lost");

  const denied = await fetch(`${BASE}/rooms/${ROOM}/peers`, { headers: { Origin: "https://evil.example" } });
  assert(denied.headers.get("Access-Control-Allow-Origin") === null, "disallowed origin got a CORS allow header");
  assert(denied.headers.get("Cross-Origin-Resource-Policy") === "cross-origin", "disallowed origin response lacks CORP");
  step(`disallowed origin -> ${denied.status}, no allow header`);
}

async function main(): Promise<number> {
  if (await isUp()) {
    console.log(`port ${PORT} is already serving; stop that process first`);
    return 1;
  }

  const log = openSync(logPath, "a");
  const child = spawn(
    "bunx",
    [WRANGLER, "dev", "--local", "--env", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", join(scratch, "state")],
    {
      cwd: appDir,
      detached: true, // own process group, so the workerd grandchild dies with it
      stdio: ["ignore", log, log],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  let exited = false;
  const exitedPromise = new Promise<void>((resolve) => child.once("exit", () => ((exited = true), resolve())));

  const stop = async () => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, 5000);
    await exitedPromise;
    clearTimeout(killTimer);
  };

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await isUp())) {
      if (exited) throw new Error("wrangler exited before it was ready");
      if (Date.now() > deadline) throw new Error(`wrangler not ready after ${READY_TIMEOUT_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`wrangler dev --local up on ${BASE}, room ${ROOM}`);
    await exchange();
    await stop();
    return 0;
  } catch (err) {
    await stop();
    console.log("---- wrangler log ----");
    console.log(readFileSync(logPath, "utf8").split("\n").slice(-60).join("\n"));
    console.log("----------------------");
    console.log(`EXCHANGE-FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const code = await main();
if (code === 0) console.log("EXCHANGE-OK");
process.exit(code);
