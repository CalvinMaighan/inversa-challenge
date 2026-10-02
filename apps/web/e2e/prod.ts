/**
 * Production readiness check (gates/leaf-T31.md G5, gates/leaf-H1.md G2 and G3). Boots what the release ships:
 * a plain `next build` (no e2e hook, `NEXT_PUBLIC_SIGNAL_URL=/signal` as release.yml sets it) run as the
 * standalone server with NODE_ENV=production, and the release Axum binary with `INVERSA_SOURCES=off`, over a
 * temp data dir holding each app's fixtures. Neither process gets a credential: the env is rebuilt from PATH and
 * HOME only, so no OpenRouter, xAI, hook, nudge, NWWS, AWS, USGS, R2 or Worker setting can leak in from the shell.
 *
 * Prints, then exits 0 only when every line is all ok:
 *
 *   HEADERS coop=ok coep=ok csp=ok nosniff=ok referrer=ok     Next's response headers, and deploy/Caddyfile sets the same
 *   PROD app=<id> health=ok ratelimit=ok costcap=ok errors=ok degraded=ok    one line per app
 *   PROD-SURFACE-OK dev=404 hook=absent headers=ok           /dev/* is 404, window.__inversa is not shipped
 *
 * Per app:
 * - health: Axum `/health` lists the app with its feeds; web `/api/health` says the API is up and the app's
 *   databases open.
 * - ratelimit: the 11th agent request from one address inside a minute is 429 `rate_limited` with Retry-After.
 * - costcap: on a second web server (`AGENT_APP_DAILY_USD=1`) whose day already holds $1.50 per app, the app's
 *   agent request is 429 `cost_cap` (`app_usd`) with Retry-After, before any key check.
 * - errors: bad JSON, an unknown app, the missing model key, a GraphQL syntax error and an unknown app's API path
 *   all answer typed JSON, and no body carries a stack trace, a source path or a module path.
 * - degraded: with no credentials every feed whose credential is missing is `down` with a reason naming it, in
 *   Axum's `/health` and in web `/api/health`; the signal Worker and the agent are `down` with reasons; the status
 *   is `degraded` (200); the app's stored data still serves; and after Axum is killed web `/api/health` is 503
 *   `down` with the reason while the page itself still serves.
 *
 *   cd apps/web && bun run e2e:prod [-- --app <id>]     E2E_SKIP_BUILD=1 reuses the last plain build
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { APP_IDS, type AppId } from "../shared/apps";

import { APP_DIR, REPO_DIR, buildApi, freePort } from "./stack";

const SERVER = path.join(APP_DIR, ".next/standalone/apps/web/server.js");
const E2E_MARKER = path.join(APP_DIR, ".next/standalone/apps/web/.e2e-build");
const STATIC = path.join(APP_DIR, ".next/static");
const API_BIN = path.join(process.env.CARGO_TARGET_DIR ?? path.join(REPO_DIR, "api/target"), "release/inversa-api");
const DEV_PATHS = ["/dev/agent", "/dev/globe", "/dev/hud", "/dev/threads", "/dev/globe/sample-evf"];

/** What every page response must carry (G3), with the deploy/Caddyfile line that must say the same. */
const HEADERS = {
  coop: { header: "cross-origin-opener-policy", want: "same-origin", caddy: "Cross-Origin-Opener-Policy same-origin" },
  coep: { header: "cross-origin-embedder-policy", want: "require-corp", caddy: "Cross-Origin-Embedder-Policy require-corp" },
  csp: {
    header: "content-security-policy",
    want: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    caddy: `Content-Security-Policy "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"`,
  },
  nosniff: { header: "x-content-type-options", want: "nosniff", caddy: "X-Content-Type-Options nosniff" },
  referrer: { header: "referrer-policy", want: "strict-origin-when-cross-origin", caddy: "Referrer-Policy strict-origin-when-cross-origin" },
} as const;

/** Text that means an internal leaked into a response body. */
const LEAK = /\n\s+at |node_modules|\/src\/[\w/]+\.(rs|ts)|\.tsx?:\d+|panicked at|RUST_BACKTRACE/;

const log = (...a: unknown[]) => console.error("[e2e:prod]", ...a);

/** `--app <id>` checks and prints one app (the grader runs one per app); the default is all three. */
const APPS: AppId[] = (() => {
  const i = process.argv.indexOf("--app");
  if (i < 0) return [...APP_IDS];
  const id = process.argv[i + 1] as AppId;
  if (!APP_IDS.includes(id)) throw new Error(`--app must be one of ${APP_IDS.join(", ")}`);
  return [id];
})();

const surfaceFailures: string[] = [];

/** PATH and HOME only: no credential reaches a child from the shell or from Doppler. */
function bareEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: tmpdir() };
  return { ...env, ...extra };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function buildPlainWeb(): void {
  if (process.env.E2E_SKIP_BUILD === "1" && existsSync(SERVER) && !existsSync(E2E_MARKER)) return;
  log("next build (plain, NEXT_PUBLIC_SIGNAL_URL=/signal as release.yml) …");
  const env: Record<string, string | undefined> = { ...process.env, NEXT_PUBLIC_SIGNAL_URL: "/signal", NEXT_TELEMETRY_DISABLED: "1" };
  delete env.NEXT_PUBLIC_INVERSA_E2E;
  const res = Bun.spawnSync(["bun", "run", "build"], { cwd: APP_DIR, env, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    console.error(res.stdout.toString().slice(-4000), res.stderr.toString().slice(-4000));
    throw new Error(`next build failed (${res.exitCode})`);
  }
  rmSync(E2E_MARKER, { force: true });
}

type Proc = { origin: string; proc: ReturnType<typeof Bun.spawn>; stop: () => Promise<void> };

async function waitUp(what: string, url: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500 || res.status === 503) return;
    } catch {
      // Not up yet.
    }
    if (i > 600 || proc.exitCode !== null) throw new Error(`${what} did not come up on ${url}`);
    await Bun.sleep(100);
  }
}

async function spawnServer(what: string, cmd: string[], cwd: string, env: Record<string, string>, origin: string, probe: string): Promise<Proc> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "ignore", stderr: process.env.E2E_VERBOSE ? "inherit" : "ignore" });
  await waitUp(what, origin + probe, proc);
  return {
    origin,
    proc,
    stop: async () => {
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
    },
  };
}

function startWeb(apiOrigin: string, dataDir: string, extra: Record<string, string> = {}): Promise<Proc> {
  const port = freePort();
  const env = bareEnv({ HOSTNAME: "127.0.0.1", PORT: String(port), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", INVERSA_API_ORIGIN: apiOrigin, INVERSA_DATA_DIR: dataDir, ...extra });
  return spawnServer("next start", ["bun", SERVER], path.dirname(SERVER), env, `http://127.0.0.1:${port}`, "/");
}

function backfillFixtures(dataDir: string, app: AppId): void {
  const res = Bun.spawnSync([API_BIN, "backfill", "--fixtures", "--app", app], { cwd: REPO_DIR, env: bareEnv({ INVERSA_DATA_DIR: dataDir, INVERSA_SOURCES: "off" }), stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0 || !/BACKFILL-OK/.test(res.stdout.toString())) {
    console.error(res.stdout.toString().slice(-2000), res.stderr.toString().slice(-2000));
    throw new Error(`backfill --fixtures --app ${app} failed (${res.exitCode})`);
  }
}

async function json(res: Response): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: the caller's check fails on the missing fields.
  }
  return { status: res.status, text, body };
}

function agentPost(origin: string, ip: string, body: string): Promise<Response> {
  return fetch(`${origin}/api/agent/stream`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body });
}

const question = (app: AppId, n: number) => JSON.stringify({ app, sessionId: `prod-${app}-${n}`, question: "Any alerts right now?" });

type Checks = Record<"health" | "ratelimit" | "costcap" | "errors" | "degraded", string[]>;

async function main() {
  buildPlainWeb();
  if (!existsSync(SERVER)) throw new Error("no standalone build");
  if (existsSync(E2E_MARKER)) throw new Error("the last build is an e2e build (window.__inversa on)");
  if (!existsSync(API_BIN) || process.env.E2E_SKIP_BUILD !== "1") buildApi(log);

  // Shipped bundle: no diagnostics hook.
  const chunks = files(STATIC).filter((f) => f.endsWith(".js"));
  const hooked = chunks.filter((f) => readFileSync(f, "utf8").includes("__inversa"));
  log(`${chunks.length} client chunks, ${hooked.length} mention __inversa`);
  if (chunks.length === 0) surfaceFailures.push("no client chunks found");
  if (hooked.length) surfaceFailures.push(`__inversa in ${hooked.map((f) => path.relative(APP_DIR, f)).join(", ")}`);

  const root = mkdtempSync(path.join(tmpdir(), "inversa-e2e-prod-"));
  const apiData = path.join(root, "api");
  const webData = path.join(root, "web");
  const cappedData = path.join(root, "web-capped");
  for (const d of [apiData, webData, cappedData]) mkdirSync(d, { recursive: true });
  for (const app of APP_IDS) backfillFixtures(apiData, app);

  // The costcap server runs with a $1 per-app cap (`AGENT_APP_DAILY_USD`) on a day that already holds $1.50 per
  // app: every app is over its own cap while the total stays under the default $5 global cap.
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(cappedData, "agent-budget.json"), JSON.stringify({ day: today, used: 0, usd: 4.5, apps: { carp: 1.5, lionfish: 1.5, python: 1.5 } }));

  const apiPort = freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const procs: Proc[] = [];
  const checks = Object.fromEntries(APPS.map((id) => [id, { health: [], ratelimit: [], costcap: [], errors: [], degraded: [] } as Checks])) as Record<AppId, Checks>;
  const fail = (app: AppId, check: keyof Checks, why: string) => {
    checks[app][check].push(why);
    log(`FAIL ${app} ${check}: ${why}`);
  };
  let headerLine = "HEADERS coop=fail coep=fail csp=fail nosniff=fail referrer=fail";

  try {
    const api = await spawnServer("axum", [API_BIN], REPO_DIR, bareEnv({ INVERSA_DATA_DIR: apiData, INVERSA_BIND: `127.0.0.1:${apiPort}`, INVERSA_SOURCES: "off" }), apiOrigin, "/health");
    procs.push(api);
    const web = await startWeb(apiOrigin, webData);
    procs.push(web);
    const capped = await startWeb(apiOrigin, cappedData, { AGENT_APP_DAILY_USD: "1" });
    procs.push(capped);
    log(`axum ${apiOrigin}, next ${web.origin}, next (capped day) ${capped.origin}, data ${root}`);

    // HEADERS: the page and an API route, and the Caddyfile sets the same values.
    const caddyfile = readFileSync(path.join(REPO_DIR, "deploy/Caddyfile"), "utf8");
    const page = await fetch(`${web.origin}/`);
    const apiRoute = await fetch(`${web.origin}/api/health`);
    const parts = Object.entries(HEADERS).map(([name, h]) => {
      const ok = page.headers.get(h.header) === h.want && apiRoute.headers.get(h.header) === h.want && caddyfile.includes(h.caddy);
      if (!ok) log(`header ${h.header}: page=${page.headers.get(h.header)} api=${apiRoute.headers.get(h.header)} caddyfile=${caddyfile.includes(h.caddy)}`);
      return `${name}=${ok ? "ok" : "fail"}`;
    });
    headerLine = `HEADERS ${parts.join(" ")}`;
    if (page.headers.get("x-powered-by")) surfaceFailures.push(`x-powered-by: ${page.headers.get("x-powered-by")}`);
    const html = await page.text();
    if (html.includes("__inversa")) surfaceFailures.push("the page HTML mentions __inversa");

    // Dev surfaces are off in production.
    const devStatuses = await Promise.all(DEV_PATHS.map(async (p) => [p, (await fetch(web.origin + p)).status] as const));
    log(`INVERSA_DEV_ROUTES unset: ${devStatuses.map(([p, s]) => `${p}=${s}`).join(" ")}`);
    for (const [p, s] of devStatuses) if (s !== 404) surfaceFailures.push(`${p} answered ${s} in production without INVERSA_DEV_ROUTES`);

    const axumHealth = await json(await fetch(`${apiOrigin}/health`));
    const webHealth = await json(await fetch(`${web.origin}/api/health`));
    log(`axum /health ${axumHealth.status} ${String(axumHealth.body.status)}; web /api/health ${webHealth.status} ${String(webHealth.body.status)}`);
    type ApiApp = { id: string; feeds: { source: string; state: string; note: string | null }[] | { error: string } };
    type WebApp = { id: string; db: string; reason?: string; downFeeds: { source: string; reason: string }[] };
    const apiApps = (axumHealth.body.apps ?? []) as ApiApp[];
    const webApps = (webHealth.body.apps ?? []) as WebApp[];
    const dep = (name: string) => (webHealth.body[name] ?? {}) as { state?: string; reason?: string };

    let ipSeq = 0;
    for (const app of APPS) {
      // health
      const a = apiApps.find((x) => x.id === app);
      const w = webApps.find((x) => x.id === app);
      if (axumHealth.status !== 200 || axumHealth.body.status !== "ok") fail(app, "health", `axum /health ${axumHealth.status} ${String(axumHealth.body.status)}`);
      if (!a || !Array.isArray(a.feeds)) fail(app, "health", `axum /health has no feed list for ${app}`);
      if (dep("api").state !== "up") fail(app, "health", `web /api/health api ${dep("api").state}`);
      if (w?.db !== "ok") fail(app, "health", `web /api/health db ${w?.db} ${w?.reason ?? ""}`);

      // ratelimit: one address, 11 requests.
      const ip = `198.18.${APP_IDS.indexOf(app)}.${++ipSeq}`;
      const first: number[] = [];
      for (let i = 0; i < 10; i++) first.push((await agentPost(web.origin, ip, question(app, i))).status);
      const eleventh = await json(await agentPost(web.origin, ip, question(app, 10)));
      if (first.some((s) => s === 429)) fail(app, "ratelimit", `a request under the limit was refused: ${first.join(",")}`);
      if (eleventh.status !== 429 || eleventh.body.code !== "rate_limited") fail(app, "ratelimit", `11th answered ${eleventh.status} ${eleventh.text.slice(0, 120)}`);
      if (!(Number((await agentPost(web.origin, ip, question(app, 11))).headers.get("retry-after")) > 0)) fail(app, "ratelimit", "no Retry-After");

      // costcap: the capped day refuses this app before the key check.
      const capRes = await agentPost(capped.origin, `198.19.${APP_IDS.indexOf(app)}.1`, question(app, 0));
      const cap = await json(capRes);
      if (cap.status !== 429 || cap.body.code !== "cost_cap" || cap.body.cap !== "app_usd") fail(app, "costcap", `answered ${cap.status} ${cap.text.slice(0, 160)}`);
      if (!(Number(capRes.headers.get("retry-after")) > 0)) fail(app, "costcap", "no Retry-After");
      if (!String(cap.body.error ?? "").includes("resets at 00:00 UTC")) fail(app, "costcap", `message: ${String(cap.body.error)}`);

      // errors: typed JSON, no internals.
      const errIp = `198.20.${APP_IDS.indexOf(app)}.`;
      const cases: [string, Response, number, (b: Record<string, unknown>) => boolean][] = [
        ["bad json", await agentPost(web.origin, `${errIp}1`, "{nope"), 400, (b) => b.code === "invalid_request"],
        [
          "text/plain body",
          await fetch(`${web.origin}/api/agent/stream`, { method: "POST", headers: { "content-type": "text/plain", "x-forwarded-for": `${errIp}4` }, body: question(app, 98) }),
          415,
          (b) => b.code === "invalid_request",
        ],
        ["unknown app", await agentPost(web.origin, `${errIp}2`, JSON.stringify({ app: "otter", sessionId: "x", question: "hi" })), 400, (b) => b.code === "invalid_request"],
        ["no model key", await agentPost(web.origin, `${errIp}3`, question(app, 99)), 503, (b) => b.code === "agent_unavailable" && b.error === "agent unavailable: OPENROUTER_API_KEY not set"],
        [
          "graphql syntax",
          await fetch(`${apiOrigin}/v1/${app}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ feeds { source " }) }),
          200,
          (b) => Array.isArray(b.errors) && b.errors.length > 0,
        ],
        ["graphql bad body", await fetch(`${apiOrigin}/v1/${app}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), 400, () => true],
        ["unknown api app", await fetch(`${apiOrigin}/v1/otter-${app}/graphql`, { method: "POST", body: "{}" }), 404, (b) => b.error === "unknown_app"],
        ["bad media id", await fetch(`${apiOrigin}/v1/${app}/media/..%2F..%2Fetc%2Fpasswd`), 400, () => true],
      ];
      for (const [name, res, want, ok] of cases) {
        const r = await json(res);
        if (r.status !== want && !(name === "graphql syntax" && r.status === 400)) fail(app, "errors", `${name}: ${r.status} (want ${want}) ${r.text.slice(0, 120)}`);
        else if (!ok(r.body) && name !== "graphql bad body" && name !== "bad media id") fail(app, "errors", `${name}: body ${r.text.slice(0, 160)}`);
        if (LEAK.test(r.text)) fail(app, "errors", `${name}: body leaks internals: ${r.text.slice(0, 200)}`);
      }

      // degraded: missing credentials are down with reasons; stored data still serves.
      const feeds = a && Array.isArray(a.feeds) ? a.feeds : [];
      const credentialDown = feeds.filter((f) => f.state === "down" && /not set/.test(f.note ?? ""));
      if (credentialDown.length === 0) fail(app, "degraded", "no feed reports a missing credential as down with a reason");
      if (feeds.some((f) => f.state === "down" && !f.note)) fail(app, "degraded", "a down feed has no reason");
      for (const f of credentialDown) {
        if (!w?.downFeeds.some((d) => d.source === f.source && d.reason === f.note)) fail(app, "degraded", `web /api/health lacks ${f.source}'s reason`);
      }
      if (webHealth.status !== 200 || webHealth.body.status !== "degraded") fail(app, "degraded", `web /api/health ${webHealth.status} ${String(webHealth.body.status)}`);
      if (dep("signal").state !== "down" || !dep("signal").reason?.includes("SIGNAL_WORKER_URL")) fail(app, "degraded", `signal ${JSON.stringify(dep("signal"))}`);
      if (dep("agent").state !== "down" || !dep("agent").reason?.includes("OPENROUTER_API_KEY")) fail(app, "degraded", `agent ${JSON.stringify(dep("agent"))}`);
      const stored = await json(await fetch(`${apiOrigin}/v1/${app}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ feeds { source newestObservedAt } }" }) }));
      const served = ((stored.body.data as { feeds?: { newestObservedAt: string | null }[] } | undefined)?.feeds ?? []).filter((f) => f.newestObservedAt);
      if (served.length === 0) fail(app, "degraded", `no stored observations served: ${stored.text.slice(0, 160)}`);
      log(`${app}: ${feeds.length} feeds, ${credentialDown.length} down for a missing credential (${credentialDown.map((f) => f.source).join(", ")}), ${served.length} with stored data`);
    }

    // Dead upstream: kill Axum; web health is down with the reason and the page still serves.
    await api.stop();
    const dead = await json(await fetch(`${web.origin}/api/health?after-kill`));
    // The 5 s health cache may still hold the live answer: wait it out once.
    const deadNow = dead.body.status === "down" ? dead : (await Bun.sleep(5_200), await json(await fetch(`${web.origin}/api/health`)));
    const pageAfter = await fetch(`${web.origin}/`);
    const apiDep = (deadNow.body.api ?? {}) as { state?: string; reason?: string };
    log(`axum killed: web /api/health ${deadNow.status} ${String(deadNow.body.status)} (${apiDep.reason ?? ""}); page ${pageAfter.status}`);
    for (const app of APPS) {
      if (deadNow.status !== 503 || deadNow.body.status !== "down" || apiDep.state !== "down" || !apiDep.reason?.startsWith("API unreachable")) fail(app, "degraded", `after killing Axum: ${deadNow.text.slice(0, 200)}`);
      if (!pageAfter.ok) fail(app, "degraded", `page ${pageAfter.status} after killing Axum`);
      if (LEAK.test(deadNow.text)) fail(app, "degraded", "health body leaks internals");
    }
  } finally {
    for (const p of procs.reverse()) await p.stop();
  }

  // Dev routes come back with the flag (the e2e scripts rely on it).
  const devApiPort = freePort();
  const devOn = await startWeb(`http://127.0.0.1:${devApiPort}`, webData, { INVERSA_DEV_ROUTES: "1" });
  try {
    const statuses = await Promise.all(DEV_PATHS.map(async (p) => [p, (await fetch(devOn.origin + p)).status] as const));
    log(`INVERSA_DEV_ROUTES=1: ${statuses.map(([p, s]) => `${p}=${s}`).join(" ")}`);
    for (const [p, s] of statuses) if (s !== 200) surfaceFailures.push(`${p} answered ${s} with INVERSA_DEV_ROUTES=1`);
  } finally {
    await devOn.stop();
  }
  rmSync(root, { recursive: true, force: true });

  console.log(headerLine);
  let bad = headerLine.includes("=fail") ? 1 : 0;
  for (const app of APPS) {
    const c = checks[app];
    const word = (k: keyof Checks) => `${k}=${c[k].length ? "fail" : "ok"}`;
    const line = `PROD app=${app} ${word("health")} ${word("ratelimit")} ${word("costcap")} ${word("errors")} ${word("degraded")}`;
    if (line.includes("=fail")) bad += 1;
    console.log(line);
  }
  for (const f of surfaceFailures) log(`FAIL ${f}`);
  console.log(surfaceFailures.length ? `PROD-SURFACE-FAIL ${surfaceFailures.length}` : "PROD-SURFACE-OK dev=404 hook=absent headers=ok");
  process.exit(bad || surfaceFailures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
