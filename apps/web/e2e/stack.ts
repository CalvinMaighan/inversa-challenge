/**
 * The real stack for the integration e2e scripts (client, convo, live): Axum over a fresh temp data dir filled
 * by `backfill --fixtures` (and optionally the cold-snap scene), the production Next build (`next start`,
 * standalone), and a front proxy that does what Caddy does in production: `/v1/*` (HTTP and the
 * graphql-transport-ws socket) to Axum, everything else to Next. The page therefore talks to one origin, as
 * it does when deployed.
 *
 * The web build is made with `NEXT_PUBLIC_INVERSA_E2E=1`, which turns on the `window.__inversa` diagnostics
 * hook (client/debug.ts). `E2E_SKIP_BUILD=1` reuses the last build when it was an e2e build.
 *
 * Axum runs with `INVERSA_SOURCES=off` (no pollers: the data is the fixtures, so runs are repeatable) and a
 * random `INGEST_HOOK_SECRET`, so a script can inject rows through the signed hook (PLAN.md C10).
 *
 * Apps (PLAN.md C-A1/C-A2): the API serves every app under `/v1/<app>/...` and `/health` lists them. A stack is
 * opened for one app (`StackOptions.app`, python by default: the fixtures are the Everglades data): `graphql` and
 * `hook` talk to that app's routes, and the page opens in it (the proxy sends a bare `/` to `/?app=<app>`, as
 * a link from that app would), so scripts written before the apps keep working.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppId } from "../shared/apps";

export const APP_DIR = path.resolve(import.meta.dir, "..");
export const REPO_DIR = path.resolve(APP_DIR, "../..");
const SERVER = path.join(APP_DIR, ".next/standalone/apps/web/server.js");
/** Written next to the standalone server by an e2e build; a plain build does not have it. */
const E2E_MARKER = path.join(APP_DIR, ".next/standalone/apps/web/.e2e-build");
/** The Axum binary, run directly so a SIGTERM reaches it (cargo run would not forward it). */
const API_BIN = path.join(process.env.CARGO_TARGET_DIR ?? path.join(REPO_DIR, "api/target"), "release/inversa-api");

export const COLD_SNAP_SCENE = "cold-snap-2026-02-01";
const WRANGLER = "wrangler@4.145.0";
/** Same-origin path the e2e build points `NEXT_PUBLIC_SIGNAL_URL` at; the proxy forwards it to the Worker. */
const SIGNAL_PREFIX = "/signal";

export type StackOptions = {
  /** Also load the cold-snap scene (2026-01-30..2026-02-04). */
  scene?: boolean;
  /** Log prefix. */
  name: string;
  /** Command prefix for the Next server, e.g. `doppler run ... --` to hand it secrets without printing them. */
  nextPrefix?: string[];
  /**
   * Also run a network backfill of this many days of iNaturalist (with a one-year NAS and GBIF baseline) on top
   * of the fixtures, so the stack holds real, current sightings of every introduced species (T44). Needs the
   * network; the taxon enrichment runs with it.
   */
  backfillDays?: number;
  /** The app the page opens in and `graphql`/`hook` talk to (C-A2 `/v1/<app>/...`). Default python. */
  app?: AppId;
};

export type Stack = {
  /** The page origin (the front proxy). */
  origin: string;
  /** The stack's app. */
  app: AppId;
  /** Axum, direct. */
  api: string;
  /** POST rows (model::Row serde form) through the signed hook; returns the parsed 202 body. */
  hook(rows: unknown[]): Promise<Record<string, unknown>>;
  /** POST any body through the signed hook, whatever the answer (a body that does not normalize is a 422). */
  hookRaw(body: string): Promise<{ status: number; text: string }>;
  /** POST a GraphQL query to Axum. */
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Tail of the Axum and Next logs, for failures. */
  logs(): string;
  stop(): Promise<void>;
};

export function buildWeb(log: (...a: unknown[]) => void): void {
  if (process.env.E2E_SKIP_BUILD === "1" && existsSync(SERVER) && existsSync(E2E_MARKER)) return;
  log("next build (NEXT_PUBLIC_INVERSA_E2E=1) …");
  const res = Bun.spawnSync(["bun", "run", "build"], {
    cwd: APP_DIR,
    env: { ...process.env, NEXT_PUBLIC_INVERSA_E2E: "1", NEXT_PUBLIC_SIGNAL_URL: SIGNAL_PREFIX, NEXT_TELEMETRY_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    console.error(res.stdout.toString().slice(-4000), res.stderr.toString().slice(-4000));
    throw new Error(`build failed with exit code ${res.exitCode}`);
  }
  writeFileSync(E2E_MARKER, new Date().toISOString());
}

export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

export function buildApi(log: (...a: unknown[]) => void): void {
  log("cargo build --release (api) …");
  const res = Bun.spawnSync(["cargo", "build", "-q", "--release", "--manifest-path", path.join(REPO_DIR, "api/Cargo.toml")], { cwd: REPO_DIR, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0 || !existsSync(API_BIN)) {
    console.error(res.stderr.toString().slice(-4000));
    throw new Error(`cargo build failed (${res.exitCode}); expected ${API_BIN}`);
  }
}

function backfill(args: string[], env: Record<string, string>, log: (...a: unknown[]) => void): void {
  const res = Bun.spawnSync([API_BIN, "backfill", ...args], { cwd: REPO_DIR, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = res.stdout.toString();
  if (res.exitCode !== 0 || !/BACKFILL-OK/.test(out)) {
    console.error(out.slice(-3000), res.stderr.toString().slice(-3000));
    throw new Error(`backfill ${args.join(" ")} failed (${res.exitCode})`);
  }
  log(`backfill ${args.join(" ")}: ${out.trim().split("\n").at(-2) ?? "ok"}`);
}

function keepTail(child: ChildProcess, into: string[]): void {
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) into.push(line);
    if (into.length > 400) into.splice(0, into.length - 400);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
}

async function waitFor(what: string, probe: () => Promise<boolean>, child: ChildProcess, timeoutMs: number, tail: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${what} exited (${child.exitCode}):\n${tail()}`);
    try {
      if (await probe()) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`${what} did not come up in ${timeoutMs / 1000}s:\n${tail()}`);
    await Bun.sleep(250);
  }
}

type WsData = { upstream: WebSocket; queue: (string | ArrayBuffer)[] };

/**
 * Caddy stand-in: `/v1/*` to Axum (HTTP and WebSocket), `/signal/*` to the signal Worker (prefix stripped),
 * the rest to Next.
 */
function startProxy(port: number, up: { api: string; next: string; signal: string; app: AppId }) {
  const apiWs = up.api.replace(/^http/, "ws");
  return Bun.serve<WsData>({
    port,
    hostname: "127.0.0.1",
    // The agent stream can sit quiet longer than Bun's 10 s default while the model thinks (Caddy has no such cap).
    idleTimeout: 255,
    async fetch(req, server) {
      const url = new URL(req.url);
      // A bare page load opens in the stack's app (the hash, never sent, survives the redirect).
      if (req.method === "GET" && url.pathname === "/" && !url.searchParams.has("app")) {
        url.searchParams.set("app", up.app);
        return Response.redirect(url.toString(), 302);
      }
      const toApi = url.pathname.startsWith("/v1/") || url.pathname === "/health";
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!toApi) return new Response("no websocket here", { status: 404 });
        const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
        const upstream = new WebSocket(`${apiWs}${url.pathname}${url.search}`, protocols);
        upstream.binaryType = "arraybuffer";
        const headers = protocols[0] ? { "sec-websocket-protocol": protocols[0] } : undefined;
        if (server.upgrade(req, { data: { upstream, queue: [] }, headers })) return undefined;
        upstream.close();
        return new Response("upgrade failed", { status: 400 });
      }
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("connection");
      headers.delete("accept-encoding");
      let upstream: Response;
      try {
        const target = toApi
          ? up.api + url.pathname
          : url.pathname.startsWith(SIGNAL_PREFIX + "/")
            ? up.signal + url.pathname.slice(SIGNAL_PREFIX.length)
            : up.next + url.pathname;
        upstream = await fetch(target + url.search, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          redirect: "manual",
          // Streamed request bodies (the agent's POST) need half-duplex.
          ...(req.body ? { duplex: "half" } : {}),
        } as RequestInit);
      } catch (err) {
        return new Response(`upstream unreachable: ${String(err)}`, { status: 502 });
      }
      // fetch decoded the body; the length and encoding headers no longer describe it.
      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      out.delete("transfer-encoding");
      return new Response(upstream.body, { status: upstream.status, headers: out });
    },
    websocket: {
      open(ws) {
        const { upstream, queue } = ws.data;
        upstream.onopen = () => {
          for (const m of queue) upstream.send(m);
          queue.length = 0;
        };
        upstream.onmessage = (ev) => ws.send(ev.data as string | ArrayBuffer);
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
      },
      message(ws, raw) {
        const data = typeof raw === "string" ? raw : (new Uint8Array(raw).slice().buffer as ArrayBuffer);
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(data);
        else ws.data.queue.push(data);
      },
      close(ws) {
        ws.data.upstream.close();
      },
    },
  });
}

export async function startStack(opts: StackOptions): Promise<Stack> {
  const log = (...a: unknown[]) => console.error(`[e2e:${opts.name}]`, ...a);
  const app: AppId = opts.app ?? "python";
  if (!existsSync(SERVER)) throw new Error("no standalone build; call buildWeb first");
  const dataDir = mkdtempSync(path.join(tmpdir(), `inversa-e2e-${opts.name}-`));
  const secret = randomBytes(24).toString("hex");
  const apiPort = freePort();
  const api = `http://127.0.0.1:${apiPort}`;
  const axumEnv = { INVERSA_DATA_DIR: dataDir, INVERSA_BIND: `127.0.0.1:${apiPort}`, INVERSA_SOURCES: "off", INGEST_HOOK_SECRET: secret };

  if (!existsSync(API_BIN)) throw new Error(`no Axum binary at ${API_BIN}; call buildApi first`);
  backfill(["--fixtures"], axumEnv, log);
  if (opts.scene) backfill(["--scene", COLD_SNAP_SCENE], axumEnv, log);
  if (opts.backfillDays) backfill(["--days", String(opts.backfillDays), "--baseline-years", "1"], axumEnv, log);

  const axumLog: string[] = [];
  const nextLog: string[] = [];
  const signalLog: string[] = [];
  const tail = () =>
    ["axum", axumLog, "next", nextLog, "signal", signalLog].map((x) => (Array.isArray(x) ? x.slice(-30).join("\n") : `--- ${x} ---`)).join("\n");
  const children: ChildProcess[] = [];
  let proxy: ReturnType<typeof startProxy> | null = null;
  const stop = async () => {
    proxy?.stop(true);
    // Each child leads its own process group (wrangler runs workerd under bunx): signal the whole group.
    const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
    const signalAll = (signal: NodeJS.Signals) => {
      for (const child of children.filter(running)) {
        try {
          process.kill(-child.pid!, signal);
        } catch {
          // Already gone.
        }
      }
    };
    signalAll("SIGTERM");
    const exited = Promise.all(children.map((c) => (running(c) ? new Promise((r) => c.once("exit", r)) : null)));
    await Promise.race([exited, Bun.sleep(10_000)]);
    signalAll("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  };
  const run = (cmd: string[], cwd: string, env: Record<string, string>, into: string[]) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.push(child);
    keepTail(child, into);
    return child;
  };

  try {
    const axum = run([API_BIN], REPO_DIR, axumEnv, axumLog);
    const graphql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const res = await fetch(`${api}/v1/${app}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
      const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (body.errors?.length || body.data === undefined) throw new Error(`graphql: ${JSON.stringify(body.errors ?? body)}`);
      return body.data;
    };
    await waitFor("axum", async () => Array.isArray((await graphql<{ feeds: unknown[] }>("{ feeds { source } }")).feeds), axum, 120_000, tail);

    const proxyPort = freePort();
    const origin = `http://127.0.0.1:${proxyPort}`;

    // The signal Worker (PLAN.md C9) under Miniflare, allowing the page origin only.
    const signalPort = freePort();
    const signalOrigin = `http://127.0.0.1:${signalPort}`;
    const signal = run(
      ["bunx", WRANGLER, "dev", "--local", "--env", "dev", "--port", String(signalPort), "--ip", "127.0.0.1", "--persist-to", path.join(dataDir, "wrangler"), "--var", `ALLOWED_ORIGIN:${origin}`],
      path.join(REPO_DIR, "apps/signal-worker"),
      { WRANGLER_SEND_METRICS: "false" },
      signalLog,
    );

    const nextPort = freePort();
    const nextOrigin = `http://127.0.0.1:${nextPort}`;
    const next = run(
      [...(opts.nextPrefix ?? []), "bun", SERVER],
      path.dirname(SERVER),
      { HOSTNAME: "127.0.0.1", PORT: String(nextPort), INVERSA_API_ORIGIN: api, INVERSA_DATA_DIR: dataDir, NEXT_TELEMETRY_DISABLED: "1" },
      nextLog,
    );
    await waitFor("next start", async () => (await fetch(nextOrigin)).ok, next, 60_000, tail);
    await waitFor("wrangler dev", async () => (await fetch(`${signalOrigin}/turn`, { headers: { origin } })).ok, signal, 120_000, tail);

    proxy = startProxy(proxyPort, { api, next: nextOrigin, signal: signalOrigin, app });
    log(`axum ${api} (data ${dataDir}), next ${nextOrigin}, signal ${signalOrigin}, page origin ${origin}`);

    const hookRaw = async (body: string) => {
      const ts = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
      const res = await fetch(`${api}/v1/${app}/ingest/hook/web`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": signature },
        body,
      });
      return { status: res.status, text: await res.text() };
    };
    return {
      origin,
      app,
      api,
      graphql,
      hookRaw,
      async hook(rows) {
        const { status, text } = await hookRaw(JSON.stringify(rows));
        if (status !== 202) throw new Error(`hook answered ${status}: ${text}`);
        return JSON.parse(text) as Record<string, unknown>;
      },
      logs: tail,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

