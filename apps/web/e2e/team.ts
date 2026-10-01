/**
 * Team realtime browser gates (gates/leaf-T21.md G2, G3) against the real stack:
 *
 *   - `wrangler dev --local` for the signal Worker on a free port, allowing the page's origin;
 *   - a real Axum (`cargo run --release`) on a free port with a temp INVERSA_DATA_DIR and INVERSA_SOURCES=off,
 *     so `applyOps`, `opsSince` and the `ops` subscription are the production code;
 *   - `next dev` on a free port proxying /v1 to it.
 *
 * Free ports throughout, so a developer's own `bun run dev` (3050, 8799) keeps running. Two Playwright
 * contexts (separate storage: two identities, two db workers, one WebRTC mesh) open the ops page and switch
 * the chat column to its Missions tab. A edits through the panel, B is watched by a MutationObserver; both timestamps come from the same
 * machine clock. 20 chat lines over RTC, then 20 more with peer traffic blocked (`window.__team.blockRtc`)
 * so they ride applyOps → Axum → the WebSocket. Then concurrent removal logging from both contexts must sum,
 * and an edit made while B is offline must converge after it reconnects.
 *
 * Prints `TEAM rtc_p50=<ms> ws_p50=<ms> converged=1` and `COUNTERS-OK OFFLINE-OK` on success.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

const APP_DIR = join(import.meta.dir, "..");
const REPO_DIR = join(APP_DIR, "../..");
const SIGNAL_DIR = join(REPO_DIR, "apps/signal-worker");
const WRANGLER = "wrangler@4.145.0";
/** Free ports, never the developer's own `bun run dev` (next on 3050, the signal Worker on 8799). */
const SIGNAL_PORT = freePort();
const NEXT_PORT = freePort(SIGNAL_PORT);
const SIGNAL_URL = `http://127.0.0.1:${SIGNAL_PORT}`;
const PAGE = `http://127.0.0.1:${NEXT_PORT}/`;
const EDITS = 20;
const REMOVALS_EACH = 5;
const READY_TIMEOUT_MS = 240_000;
const RTC_TIMEOUT_MS = 90_000;
const CONVERGE_TIMEOUT_MS = 60_000;

const scratch = mkdtempSync(join(tmpdir(), "team-e2e-"));
const log = (...args: unknown[]) => console.error("[e2e:team]", ...args);

function fail(msg: string): never {
  throw new Error(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port the OS says is free, other than `not`. */
function freePort(not?: number): number {
  for (;;) {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    if (port !== not) return port;
  }
}

async function portBusy(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError";
  }
}

// ---- processes --------------------------------------------------------------------------------------

type Proc = { name: string; child: ChildProcess; logPath: string; stop(): Promise<void> };

function start(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>): Proc {
  const logPath = join(scratch, `${name}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
  let exited = false;
  const exitedPromise = new Promise<void>((resolve) => child.once("exit", () => ((exited = true), resolve())));
  return {
    name,
    child,
    logPath,
    async stop() {
      if (exited || child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const killer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 5_000);
      await exitedPromise;
      clearTimeout(killer);
    },
  };
}

const tail = (p: Proc, n = 40) => {
  try {
    return readFileSync(p.logPath, "utf8").split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
};

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number, dead?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dead?.()) fail(`${what}: process exited`);
    if (await probe()) return;
    await sleep(300);
  }
  fail(`${what}: not ready after ${timeoutMs / 1000}s`);
}

async function startSignal(): Promise<Proc> {
  const p = start("signal", "bunx", [WRANGLER, "dev", "--local", "--env", "dev", "--port", String(SIGNAL_PORT), "--ip", "127.0.0.1", "--persist-to", join(scratch, "wrangler-state"), "--var", `ALLOWED_ORIGIN:http://127.0.0.1:${NEXT_PORT}`], SIGNAL_DIR, {
    WRANGLER_SEND_METRICS: "false",
  });
  await waitFor(
    "wrangler dev",
    async () => {
      try {
        const res = await fetch(`${SIGNAL_URL}/turn`, { headers: { Origin: `http://127.0.0.1:${NEXT_PORT}` }, signal: AbortSignal.timeout(1000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    READY_TIMEOUT_MS,
    () => p.child.exitCode !== null,
  );
  return p;
}

async function startApi(): Promise<{ proc: Proc; port: number }> {
  const port = freePort();
  const proc = start("api", "cargo", ["run", "-q", "--release", "--manifest-path", join(REPO_DIR, "api/Cargo.toml")], REPO_DIR, {
    INVERSA_DATA_DIR: join(scratch, "data"),
    INVERSA_SOURCES: "off",
    INVERSA_BIND: `127.0.0.1:${port}`,
    RUST_LOG: "info",
  });
  await waitFor(
    "axum",
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    READY_TIMEOUT_MS,
    () => proc.child.exitCode !== null,
  );
  return { proc, port };
}

async function startNext(apiPort: number): Promise<Proc> {
  // What `predev` does; then bind next to 127.0.0.1 itself, or Next 16 blocks its own dev chunks as cross-origin.
  for (const script of ["cesium:copy", "sqlite:copy"]) {
    const res = Bun.spawnSync(["bun", "run", script], { cwd: APP_DIR, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) fail(`${script}: ${res.stderr.toString()}`);
  }
  const proc = start("next", "bun", ["x", "next", "dev", "-p", String(NEXT_PORT), "-H", "127.0.0.1"], APP_DIR, {
    INVERSA_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    NEXT_PUBLIC_INVERSA_WS_URL: `ws://127.0.0.1:${apiPort}/v1/graphql`,
    NEXT_PUBLIC_SIGNAL_URL: SIGNAL_URL,
    NEXT_TELEMETRY_DISABLED: "1",
    BROWSER: "none",
  });
  await waitFor(
    "next dev",
    async () => {
      try {
        const res = await fetch(PAGE, { signal: AbortSignal.timeout(20_000) });
        return res.ok && (await res.text()).includes("data-shell");
      } catch {
        return false;
      }
    },
    READY_TIMEOUT_MS,
    () => proc.child.exitCode !== null,
  );
  return proc;
}

// ---- page helpers -----------------------------------------------------------------------------------

// `window.__team` is declared by client/hud/missions/team.ts (the same tsconfig program).
declare global {
  interface Window {
    __t0?: number;
  }
}

const pageErrors = new Map<string, string[]>();
/** Pages whose browser refused to transfer the RTCDataChannel and relayed through main instead. */
const relayed = new Set<string>();

async function open(ctx: BrowserContext, name: string): Promise<Page> {
  const page = await ctx.newPage();
  const errs: string[] = [];
  pageErrors.set(name, errs);
  page.on("pageerror", (err) => errs.push(err.message));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
    if (/relaying through main/.test(m.text())) relayed.add(name);
  });
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  // The board lives in the chat column's Missions tab (T40); the session starts with the page either way.
  await page.click('[data-tab="board"]', { timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.__team) && document.querySelector('[data-testid="team-panel"][data-ready="1"]') !== null, null, { timeout: 120_000 });
  return page;
}

const nodeId = (page: Page) => page.evaluate(() => window.__team!.nodeId);

async function waitRtc(page: Page, peer: string): Promise<void> {
  await page.waitForFunction((id) => window.__team!.peers().some((p) => p.peerId === id && p.link === "open"), peer, { timeout: RTC_TIMEOUT_MS, polling: 250 });
}

/** Resolve with the observer's Date.now() once `text` appears inside `selector`. Started before the edit. */
function watchFor(page: Page, selector: string, text: string, timeoutMs = 30_000): Promise<number> {
  return page.evaluate(
    ({ selector, text, timeoutMs }) =>
      new Promise<number>((resolve, reject) => {
        const root = document.querySelector(selector);
        if (!root) {
          reject(new Error(`no ${selector}`));
          return;
        }
        const hit = () => (root.textContent ?? "").includes(text);
        if (hit()) {
          resolve(Date.now());
          return;
        }
        const timer = setTimeout(() => {
          mo.disconnect();
          reject(new Error(`timed out waiting for ${JSON.stringify(text)}`));
        }, timeoutMs);
        const mo = new MutationObserver(() => {
          if (!hit()) return;
          clearTimeout(timer);
          mo.disconnect();
          resolve(Date.now());
        });
        mo.observe(root, { subtree: true, childList: true, characterData: true });
      }),
    { selector, text, timeoutMs },
  );
}

/** Type into the chat box and press Enter; `__t0` is stamped by a capture-phase submit listener in the page. */
async function sayViaUi(page: Page, text: string): Promise<number> {
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="chat-input"]')!.closest("form")!;
    form.addEventListener("submit", () => (window.__t0 = Date.now()), { capture: true, once: true });
  });
  await page.fill('[data-testid="chat-input"]', text);
  await page.press('[data-testid="chat-input"]', "Enter");
  return page.evaluate(() => window.__t0!);
}

async function measure(a: Page, b: Page, tag: string): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < EDITS; i++) {
    const text = `${tag}-${i}-${Math.random().toString(36).slice(2, 6)}`;
    const seen = watchFor(b, '[data-testid="chat-log"]', text);
    const t0 = await sayViaUi(a, text);
    const t1 = await seen;
    samples.push(t1 - t0);
  }
  return samples;
}

const p50 = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

async function board(page: Page) {
  return (await page.evaluate(() => window.__team!.board()))!;
}

async function waitBoard(page: Page, pred: (b: Awaited<ReturnType<typeof board>>) => boolean, what: string, timeoutMs = CONVERGE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const b = await board(page);
    last = b;
    if (pred(b)) return;
    await sleep(200);
  }
  fail(`${what}: ${JSON.stringify(last).slice(0, 600)}`);
}

async function serverBoard(apiPort: number): Promise<{ missions: { id: string; fields: Record<string, unknown> }[]; messages: { body: string }[]; removals: Record<string, number> }> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/v1/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: 'query { board(id: "everglades") { missions { id fields } messages { body } removals } }' }),
  });
  const json = (await res.json()) as { data?: { board: { missions: { id: string; fields: Record<string, unknown> }[]; messages: { body: string }[]; removals: Record<string, number> } }; errors?: unknown };
  if (!json.data) fail(`board query: ${JSON.stringify(json.errors)}`);
  return json.data.board;
}

// ---- scenario ---------------------------------------------------------------------------------------

async function scenario(apiPort: number): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const a = await open(ctxA, "A");
    const b = await open(ctxB, "B");
    const [idA, idB] = await Promise.all([nodeId(a), nodeId(b)]);
    if (!idA || !idB || idA === idB) fail(`identities: ${idA} ${idB}`);
    log(`A=${idA.slice(0, 8)} B=${idB.slice(0, 8)}; waiting for the data channel`);
    await Promise.all([waitRtc(a, idB), waitRtc(b, idA)]);
    log(`rtc open both ways; channel ${relayed.size ? `relayed through main on ${[...relayed].join(",")}` : "transferred to the rtc worker"}`);

    // A mission from a hotspot cell, through the real form: B must see it.
    const at = Date.now() - 3_600_000;
    await a.evaluate((id) => window.__team!.select(id), `hotspot:python:120:80:${at}`);
    await a.waitForSelector('[data-testid="mission-form"]');
    const cell = await a.textContent('[data-testid="mission-cell"]');
    if (cell !== "120:80") fail(`form cell: ${cell}`);
    await a.fill('[data-testid="mission-title"]', "Python sweep 120:80");
    await a.click('[data-testid="mission-create"]');
    await waitBoard(a, (m) => m.missions.some((x) => x.title === "Python sweep 120:80"), "mission on A");
    await waitBoard(b, (m) => m.missions.some((x) => x.title === "Python sweep 120:80"), "mission on B");
    const missionId = (await board(a)).missions.find((x) => x.title === "Python sweep 120:80")!.id;
    await b.waitForSelector(`[data-mission-id="${missionId}"]`);
    log(`mission ${missionId.slice(0, 8)} on both`);

    // Latency over RTC: A types in the chat, B's chat log changes.
    const rtc = await measure(a, b, "rtc");
    const rtcP50 = p50(rtc);
    log(`rtc samples ms: ${rtc.join(" ")} p50=${rtcP50}`);

    // Latency over the WebSocket: peer traffic blocked on both sides.
    await Promise.all([a, b].map((p) => p.evaluate(() => window.__team!.blockRtc(true))));
    const ws = await measure(a, b, "ws");
    const wsP50 = p50(ws);
    log(`ws samples ms: ${ws.join(" ")} p50=${wsP50}`);

    // Concurrent removals, still over the WebSocket: a grow-only counter per node must sum on both sides.
    for (const p of [a, b]) {
      // A focused the mission when it created it; B has it collapsed.
      if ((await p.$(`[data-mission-id="${missionId}"] [data-testid="removal-add"]`)) === null) await p.click(`[data-mission-id="${missionId}"] button[aria-expanded="false"]`);
      await p.waitForSelector(`[data-mission-id="${missionId}"] [data-testid="removal-add"]`);
    }
    const clicks = async (p: Page) => {
      for (let i = 0; i < REMOVALS_EACH; i++) await p.click(`[data-mission-id="${missionId}"] [data-testid="removal-add"]`);
    };
    await Promise.all([clicks(a), clicks(b)]);
    const expected = 2 * REMOVALS_EACH;
    await waitBoard(a, (m) => m.removals[missionId] === expected, `A removals=${expected}`);
    await waitBoard(b, (m) => m.removals[missionId] === expected, `B removals=${expected}`);
    for (const [name, p] of [
      ["A", a],
      ["B", b],
    ] as const) {
      const shown = await p.textContent(`[data-mission-id="${missionId}"] [data-testid="removal-total"]`);
      if (shown !== String(expected)) fail(`${name} shows removal total ${shown}, expected ${expected}`);
      const overall = await p.textContent('[data-testid="totals-overall"]');
      if (overall !== String(expected)) fail(`${name} overall total ${overall}, expected ${expected}`);
    }
    const server1 = await serverBoard(apiPort);
    if (server1.removals[missionId] !== expected) fail(`server removals ${JSON.stringify(server1.removals)}`);
    log(`counters: ${expected} on A, B and the server`);

    // Offline: B edits while cut off (WebSocket and HTTP), A edits too, then B reconnects and both converge.
    await ctxB.setOffline(true);
    await b.selectOption(`[data-mission-id="${missionId}"] [data-testid="mission-status"]`, "in_progress");
    await waitBoard(b, (m) => m.missions.find((x) => x.id === missionId)?.status === "in_progress", "B local status");
    await sayViaUi(a, "while-B-was-offline");
    await sayViaUi(b, "from-offline-B");
    await sleep(1_500);
    if ((await board(a)).missions.find((x) => x.id === missionId)?.status === "in_progress") fail("A saw B's offline edit before B reconnected");
    await ctxB.setOffline(false);
    await waitBoard(a, (m) => m.missions.find((x) => x.id === missionId)?.status === "in_progress" && m.messages.some((x) => x.body === "from-offline-B"), "A converged after B reconnected");
    await waitBoard(b, (m) => m.messages.some((x) => x.body === "while-B-was-offline"), "B caught up on A's edit");
    const [fa, fb] = await Promise.all([board(a), board(b)]);
    const canon = (x: Awaited<ReturnType<typeof board>>) => JSON.stringify({ m: x.missions, r: x.removals, msgs: x.messages.map((y) => y.id).sort() });
    if (canon(fa) !== canon(fb)) fail(`boards differ after reconnect:\nA ${canon(fa)}\nB ${canon(fb)}`);
    const server2 = await serverBoard(apiPort);
    if (server2.missions.find((x) => x.id === missionId)?.fields.status !== "in_progress") fail("server did not get B's offline status change");
    if (server2.messages.length !== fa.messages.length) fail(`server has ${server2.messages.length} messages, clients ${fa.messages.length}`);
    log("offline edit converged on A, B and the server");

    const fatal = [...pageErrors.entries()].flatMap(([n, errs]) => errs.filter((e) => /\[rtc\]|\[team\]|\[missions\]|Uncaught/.test(e)).map((e) => `${n}: ${e}`));
    if (fatal.length) fail(`page errors:\n${fatal.join("\n")}`);

    return [`TEAM rtc_p50=${rtcP50} ws_p50=${wsP50} converged=1`, "COUNTERS-OK OFFLINE-OK"];
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  for (const port of [SIGNAL_PORT, NEXT_PORT]) {
    if (await portBusy(port)) {
      console.log(`port ${port} is already in use; stop that process first`);
      return 1;
    }
  }
  const procs: Proc[] = [];
  try {
    log("starting wrangler dev, axum and next dev");
    const [signal, api] = await Promise.all([startSignal(), startApi()]);
    procs.push(signal, api.proc);
    procs.push(await startNext(api.port));
    log(`signal ${SIGNAL_URL}, api :${api.port}, next ${PAGE}`);
    const lines = await scenario(api.port);
    for (const l of lines) console.log(l);
    return 0;
  } catch (err) {
    for (const p of procs) console.log(`---- ${p.name} log ----\n${tail(p)}`);
    for (const [name, errs] of pageErrors) if (errs.length) console.log(`---- page ${name} errors ----\n${errs.slice(-20).join("\n")}`);
    console.log(`TEAM-FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await Promise.all(procs.map((p) => p.stop()));
    rmSync(scratch, { recursive: true, force: true });
  }
}

const code = await main();
process.exit(code);
