/**
 * Browser check for the gql and db workers (gates/leaf-T19.md G2, G3).
 *
 * Runs `next dev` on its own port behind a stub that owns `/v1/<app>/graphql` (HTTP + graphql-transport-ws)
 * and `/v1/<app>/frames` (EVF2 from the test encoder, gzip; any other `/v1` path is a 404 and fails the run) and
 * proxies everything else to Next. Drives it with
 * Playwright's bundled Chromium:
 *   1. a cached `gqlRequest` round trip, timed in-page;
 *   2. a reload, which must be answered from the OPFS-backed cache without a network call;
 *   3. a second tab, which must proxy through the leader; then the leader closes and the follower takes over.
 * Prints `DBWORKER cached=<ms> opfs=1 proxy=1` on success.
 *
 * `--no-isolation` strips COOP/COEP at the proxy, so the page is not cross-origin isolated: the workers
 * must pick the postMessage transport and the grid must still arrive; prints `FALLBACK-OK` last.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { copySqliteWasm } from "../scripts/copy-sqlite-wasm";
import { APP_IDS } from "../shared/apps";
import { encodeEvf2 } from "../tests/client/threads/evf-fixture";

const NO_ISOLATION = process.argv.includes("--no-isolation");
export { NO_ISOLATION };
const NEXT_PORT = Number(process.env.E2E_NEXT_PORT ?? 3062);
const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 3061);
const NEXT_ORIGIN = `http://127.0.0.1:${NEXT_PORT}`;
const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;
/** The threads dev page in the python app (the scenario predates the apps; any app exercises the same workers). */
export const PAGE = `${STUB_ORIGIN}/dev/threads?app=python`;
const READY_TIMEOUT_MS = 180_000;
const FEEDS_QUERY = "{ feeds { source mode state } }";

const appDir = join(import.meta.dir, "..");

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  throw new Error(msg);
}

// ---- stub: /v1/* plus a proxy to Next ---------------------------------------------------------

const graphqlHits = new Map<string, number>();
/** `/v1/<app>/<route>` (PLAN.md C-A2); anything else under `/v1` is answered 404 and recorded here. */
const API_PATH = new RegExp(`^/v1/(${APP_IDS.join("|")})/(graphql|frames)$`);
export const unprefixed: string[] = [];
const feed = (source: string, mode: "PUSH" | "POLL") => ({ source, mode, state: "NOMINAL", newestObservedAt: new Date().toISOString(), lastFetchAt: new Date().toISOString(), lagSeconds: 3, note: null });

function graphql(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const q = body.query.replace(/\s+/g, " ").trim();
  graphqlHits.set(q, (graphqlHits.get(q) ?? 0) + 1);
  if (/^(query\b[^{]*)?\{ feeds\b/.test(q)) return { data: { feeds: [feed("goes", "PUSH"), feed("inat", "POLL"), feed("nws", "PUSH")] } };
  if (/opsSince/.test(q)) return { data: { opsSince: [] } };
  if (/applyOps/.test(q)) {
    const ops = (body.variables?.ops as unknown[] | undefined) ?? [];
    return { data: { applyOps: { applied: ops.length, duplicates: 0, lastSeq: ops.length } } };
  }
  return { data: null, errors: [{ message: `stub: unhandled ${q.slice(0, 40)}` }] };
}

function framesResponse(url: URL): Response {
  const from = Date.parse(url.searchParams.get("from") ?? "");
  const to = Date.parse(url.searchParams.get("to") ?? "");
  const step = Number(url.searchParams.get("step") ?? "60");
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(step > 0)) return new Response("bad range", { status: 400 });
  const frameCount = Math.min(744, Math.floor((to - from) / (step * 60_000)) + 1);
  // A quarter of the production grid (170x160 / 68x64): ~5 KB per frame, ~4 MB for 30 days, same code paths.
  const body = encodeEvf2({ frame0UnixMs: from, stepMinutes: step, frameCount, hsCols: 34, hsRows: 32, envCols: 17, envRows: 16, sightingsPerFrame: 3 });
  const gz = Bun.gzipSync(body.slice().buffer as ArrayBuffer);
  return new Response(gz, { status: 200, headers: { "content-type": "application/x-evf", "content-encoding": "gzip", etag: `"${from}-${to}-${step}"`, "cache-control": "no-store" } });
}

type WsData = { kind: "gql"; subs: Map<string, string> } | { kind: "relay"; upstream: WebSocket; queue: (string | ArrayBuffer)[] };

export const startStub = () =>
  Bun.serve<WsData>({
  port: STUB_PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (API_PATH.exec(url.pathname)?.[2] === "graphql") {
        const ok = server.upgrade(req, { data: { kind: "gql", subs: new Map() }, headers: { "sec-websocket-protocol": "graphql-transport-ws" } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      // Next's HMR socket. Turbopack's dev client loads lazy chunks (the workers) only once it is connected,
      // so the proxy relays it instead of letting it fail.
      const upstream = new WebSocket(`ws://127.0.0.1:${NEXT_PORT}${url.pathname}${url.search}`);
      const ok = server.upgrade(req, { data: { kind: "relay", upstream, queue: [] } });
      if (!ok) upstream.close();
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/v1/") && !API_PATH.test(url.pathname)) {
      unprefixed.push(url.pathname);
      return Response.json({ error: "unknown_app", apps: APP_IDS }, { status: 404 });
    }
    if (API_PATH.exec(url.pathname)?.[2] === "graphql") {
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      const body = (await req.json()) as { query: string; variables?: Record<string, unknown> };
      return Response.json(graphql(body));
    }
    if (API_PATH.exec(url.pathname)?.[2] === "frames") return framesResponse(url);
    // Everything else is Next. Drop hop-by-hop headers; strip isolation when asked.
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("connection");
    headers.delete("accept-encoding");
    let upstream: Response;
    try {
      upstream = await fetch(NEXT_ORIGIN + url.pathname + url.search, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body, redirect: "manual" });
    } catch {
      return new Response("next dev not up yet", { status: 503 });
    }
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    out.delete("transfer-encoding");
    if (NO_ISOLATION) {
      out.delete("cross-origin-opener-policy");
      out.delete("cross-origin-embedder-policy");
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind !== "relay") return;
      const { upstream, queue } = ws.data;
      upstream.onopen = () => {
        for (const m of queue) upstream.send(m);
        queue.length = 0;
      };
      upstream.onmessage = (ev) => ws.send(ev.data as string | ArrayBuffer);
      upstream.onclose = () => ws.close();
      upstream.onerror = () => ws.close();
    },
    close(ws) {
      if (ws.data.kind === "relay") ws.data.upstream.close();
    },
    message(ws, raw) {
      if (ws.data.kind === "relay") {
        const data = typeof raw === "string" ? raw : (new Uint8Array(raw).slice().buffer as ArrayBuffer);
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(data);
        else ws.data.queue.push(data);
        return;
      }
      const msg = JSON.parse(String(raw)) as { id?: string; type: string; payload?: { query?: string } };
      if (msg.type === "connection_init") ws.send(JSON.stringify({ type: "connection_ack" }));
      else if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      else if (msg.type === "subscribe" && msg.id) {
        const q = msg.payload?.query ?? "";
        ws.data.subs.set(msg.id, q);
        if (/feeds/.test(q)) ws.send(JSON.stringify({ id: msg.id, type: "next", payload: { data: { feeds: feed("usgs", "POLL") } } }));
      } else if (msg.type === "complete" && msg.id) ws.data.subs.delete(msg.id);
    },
  },
  });

// ---- next dev ---------------------------------------------------------------------------------

let next: ChildProcess | null = null;
export const nextLog: string[] = [];

export function startNext(): ChildProcess {
  const child = spawn("bun", ["x", "next", "dev", "-p", String(NEXT_PORT), "-H", "127.0.0.1"], {
    cwd: appDir,
    env: {
      ...process.env,
      // An origin: the gql worker adds `/v1/<app>/graphql` for the app it serves.
      NEXT_PUBLIC_INVERSA_WS_URL: `ws://127.0.0.1:${STUB_PORT}`,
      INVERSA_API_ORIGIN: STUB_ORIGIN,
      NEXT_TELEMETRY_DISABLED: "1",
      BROWSER: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) nextLog.push(line);
    if (nextLog.length > 200) nextLog.splice(0, nextLog.length - 200);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return child;
}

export async function waitForPage(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(PAGE, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 200) {
        const html = await res.text();
        if (html.includes("threads-status")) return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`next dev not serving ${PAGE} after ${READY_TIMEOUT_MS} ms\n${nextLog.slice(-30).join("\n")}`);
}

export async function stopNext(child: ChildProcess | null = next): Promise<void> {
  if (child === next) next = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
  });
}

// ---- browser ----------------------------------------------------------------------------------

type Info = {
  transport: string;
  isolated: boolean;
  leader: boolean;
  leaderState: string;
  grid: { frameCount: number; version: number; shared: boolean } | null;
  meta: { frame0UnixMs: number; stepMinutes: number; frameCount: number; geometry: { west: number; south: number; hsCellDeg: number; envCellDeg: number } } | null;
  sightings: number;
  proxied: number;
};

const pageErrors: string[] = [];
const consoleLog: string[] = [];
const wired = new WeakSet<Page>();

async function open(page: Page): Promise<void> {
  if (!wired.has(page)) {
    wired.add(page);
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      consoleLog.push(`[${msg.type()}] ${msg.text()}`);
      if (msg.type() === "error") pageErrors.push(msg.text());
    });
  }
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => window.__threads?.status === "ready" || window.__threads?.status === "error", null, { timeout: 60_000 });
  } catch {
    const line = await page.textContent("[data-testid=threads-status]").catch(() => null);
    fail(`threads never became ready; status line: ${line}\nconsole:\n${consoleLog.slice(-40).join("\n")}`);
  }
  const status = await page.evaluate(() => ({ status: window.__threads?.status, error: window.__threads?.error }));
  if (status.status !== "ready") fail(`threads boot: ${status.error ?? "unknown"}\n${pageErrors.join("\n")}`);
}

const info = (page: Page) => page.evaluate(() => window.__threads!.info()) as Promise<Info>;
const stats = (page: Page) => page.evaluate(() => window.__threads!.stats());

async function waitInfo(page: Page, pred: (i: Info) => boolean, what: string, timeoutMs = 60_000): Promise<Info> {
  const deadline = Date.now() + timeoutMs;
  let last: Info | null = null;
  while (Date.now() < deadline) {
    last = await info(page);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

/** Median of five cached round trips, measured in-page around `gqlRequest`. */
async function timedCached(page: Page): Promise<number> {
  return page.evaluate(async (q) => {
    const t = window.__threads!;
    await t.gqlRequest(q); // warm: first call goes to the network and caches
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await t.gqlRequest(q);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return samples[2]!;
  }, FEEDS_QUERY);
}

const feedsHits = () => graphqlHits.get(FEEDS_QUERY.replace(/\s+/g, " ").trim()) ?? 0;

async function run(): Promise<string> {
  copySqliteWasm(appDir);
  next = startNext();
  await waitForPage();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await open(page);

    const first = await info(page);
    if (NO_ISOLATION) {
      if (first.isolated) fail("page is cross-origin isolated with --no-isolation");
      if (first.transport !== "message") fail(`expected the postMessage transport, got ${first.transport}`);
    } else {
      if (!first.isolated) fail("page is not cross-origin isolated (COOP/COEP missing)");
      if (first.transport !== "sab") fail(`expected the SAB transport, got ${first.transport}`);
    }
    if (!first.leader) fail("first tab did not become leader");

    // Frames: the grid arrives from the db worker (SAB or transferred buffer) and holds the whole window.
    const withGrid = await waitInfo(page, (i) => i.grid !== null && i.grid.version > 0, "frame grid");
    const expectShared = !NO_ISOLATION;
    if (withGrid.grid!.shared !== expectShared) fail(`grid shared=${withGrid.grid!.shared}, expected ${expectShared}`);
    const s0 = await stats(page);
    if (!s0.opfs) fail("db worker is not on OPFS (opfs-sahpool failed to install)");
    if (s0.frames < 700) fail(`only ${s0.frames} frames cached`);
    const m = withGrid.meta;
    if (!m || m.stepMinutes !== 60 || m.frameCount !== withGrid.grid!.frameCount || m.geometry.west !== -83.2) fail(`bad frame meta ${JSON.stringify(m)}`);
    const withSightings = await waitInfo(page, (i) => i.sightings > 0, "frame sightings");
    if (withSightings.sightings !== 3 * m.frameCount) fail(`expected ${3 * m.frameCount} sightings, got ${withSightings.sightings}`);

    // 1. Cached round trip.
    const cachedMs = await timedCached(page);
    const s1 = await stats(page);
    if (s1.lastQuerySource !== "cache") fail(`expected a cache hit, got ${s1.lastQuerySource}`);
    if (feedsHits() !== 1) fail(`feeds query hit the stub ${feedsHits()} times, expected 1`);

    // 2. Reload: the row must come back from OPFS with no network call.
    await page.reload({ waitUntil: "domcontentloaded" });
    await open(page);
    await page.evaluate((q) => window.__threads!.gqlRequest(q), FEEDS_QUERY);
    const s2 = await stats(page);
    if (s2.lastQuerySource !== "cache") fail(`after reload expected a cache hit, got ${s2.lastQuerySource}`);
    if (feedsHits() !== 1) fail(`feeds query hit the stub ${feedsHits()} times after reload, expected 1`);
    if (!s2.opfs) fail("not on OPFS after reload");
    await waitInfo(page, (i) => i.grid !== null, "frame grid after reload");

    // 3. Second tab: follower, proxied through the leader, with a grid copied from it.
    const page2 = await context.newPage();
    await open(page2);
    const i2 = await waitInfo(page2, (i) => i.leaderState === "follower", "follower election");
    if (i2.leader) fail("second tab claims leadership");
    const res2 = (await page2.evaluate((q) => window.__threads!.gqlRequest(q), FEEDS_QUERY)) as { feeds: unknown[] };
    if (!Array.isArray(res2.feeds) || res2.feeds.length !== 3) fail(`follower query returned ${JSON.stringify(res2)}`);
    const leaderInfo = await waitInfo(page, (i) => i.proxied > 0, "a proxied call at the leader");
    const s3 = await stats(page2);
    if (!s3.opfs) fail("follower stats did not come from the leader's OPFS worker");
    await waitInfo(page2, (i) => i.grid !== null && i.grid.frameCount === withGrid.grid!.frameCount && i.sightings === withSightings.sightings, "follower grid and sightings snapshot");
    if (feedsHits() !== 1) fail(`feeds query hit the stub ${feedsHits()} times via the follower, expected 1`);

    // 4. Failover: the leader closes, the follower takes the lock and its own worker.
    await page.close();
    const i4 = await waitInfo(page2, (i) => i.leader, "failover to the second tab");
    if (i4.leaderState !== "leader") fail(`after failover state is ${i4.leaderState}`);
    await page2.evaluate((q) => window.__threads!.gqlRequest(q), FEEDS_QUERY);
    const s4 = await stats(page2);
    if (s4.lastQuerySource !== "cache" || !s4.opfs) fail(`after failover expected an OPFS cache hit, got ${s4.lastQuerySource} opfs=${s4.opfs}`);

    const fatal = pageErrors.filter((e) => !/Failed to load resource|webpack-hmr|HMR|hot-reloader|WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/_next/.test(e));
    if (fatal.length) fail(`page errors:\n${fatal.join("\n")}`);
    if (unprefixed.length) fail(`requests outside /v1/<app>/: ${[...new Set(unprefixed)].join(", ")}`);

    console.log(`  ok  transport=${first.transport} isolated=${first.isolated} frames=${s0.frames} sightings=${withSightings.sightings} proxied=${leaderInfo.proxied} failover=1`);
    return NO_ISOLATION ? "FALLBACK-OK" : `DBWORKER cached=${cachedMs.toFixed(1)} opfs=1 proxy=1`;
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const stub = startStub();
  let line: string;
  try {
    line = await run();
  } catch (err) {
    await stopNext();
    stub.stop(true);
    console.error(err instanceof Error ? err.message : String(err));
    if (nextLog.length) console.error(nextLog.slice(-20).join("\n"));
    process.exit(1);
  }
  await stopNext();
  stub.stop(true);
  console.log(line);
  process.exit(0);
}
