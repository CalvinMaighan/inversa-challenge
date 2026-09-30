/**
 * Production surface check (gates/leaf-T31.md, docs/security.md) against a plain `bun run build` (not an e2e
 * build): runs the standalone server with NODE_ENV=production and checks
 * 1. `/dev/*` pages and route handlers answer 404, and 200 once the server runs with INVERSA_DEV_ROUTES=1;
 * 2. the `window.__inversa` diagnostics hook is not in the page or any client chunk;
 * 3. responses carry the isolation and hardening headers (COOP, COEP, CORP, nosniff, CSP) and no X-Powered-By.
 *
 *   cd apps/web && bun run build && bun e2e/prod.ts      prints PROD-SURFACE-OK last
 *
 * Only pages are requested, never `/v1/*`, so no API needs to run.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { APP_DIR, freePort } from "./stack";

const SERVER = path.join(APP_DIR, ".next/standalone/apps/web/server.js");
const E2E_MARKER = path.join(APP_DIR, ".next/standalone/apps/web/.e2e-build");
const STATIC = path.join(APP_DIR, ".next/static");
const DEV_PATHS = ["/dev/agent", "/dev/globe", "/dev/hud", "/dev/threads", "/dev/globe/sample-evf"];
const HEADERS: Record<string, string> = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
};

const log = (...a: unknown[]) => console.error("[e2e:prod]", ...a);
const failures: string[] = [];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

async function serve(devRoutes: boolean): Promise<{ origin: string; stop: () => Promise<void> }> {
  const port = freePort();
  const env: Record<string, string | undefined> = { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
  delete env.INVERSA_DEV_ROUTES;
  if (devRoutes) env.INVERSA_DEV_ROUTES = "1";
  const proc = Bun.spawn(["bun", SERVER], { cwd: path.dirname(SERVER), env, stdout: "ignore", stderr: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${origin}/`)).ok) break;
    } catch {
      // Not up yet.
    }
    if (i > 300 || proc.exitCode !== null) throw new Error(`next start did not come up on ${origin}`);
    await Bun.sleep(200);
  }
  return {
    origin,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

async function main() {
  if (!existsSync(SERVER)) throw new Error("no standalone build: run `bun run build` first");
  if (existsSync(E2E_MARKER)) throw new Error("the last build is an e2e build (window.__inversa on): run a plain `bun run build` first");

  const chunks = files(STATIC).filter((f) => f.endsWith(".js"));
  const hooked = chunks.filter((f) => readFileSync(f, "utf8").includes("__inversa"));
  log(`${chunks.length} client chunks, ${hooked.length} mention __inversa`);
  if (chunks.length === 0) failures.push("no client chunks found");
  if (hooked.length) failures.push(`__inversa in ${hooked.map((f) => path.relative(APP_DIR, f)).join(", ")}`);

  const off = await serve(false);
  try {
    const statuses = await Promise.all(DEV_PATHS.map(async (p) => [p, (await fetch(off.origin + p)).status] as const));
    log(`INVERSA_DEV_ROUTES unset: ${statuses.map(([p, s]) => `${p}=${s}`).join(" ")}`);
    for (const [p, s] of statuses) if (s !== 404) failures.push(`${p} answered ${s} in production without INVERSA_DEV_ROUTES`);
    const res = await fetch(`${off.origin}/`);
    const html = await res.text();
    if (html.includes("__inversa")) failures.push("the page HTML mentions __inversa");
    for (const [k, v] of Object.entries(HEADERS)) if (res.headers.get(k) !== v) failures.push(`${k}: ${res.headers.get(k)} (want ${v})`);
    if (res.headers.get("x-powered-by")) failures.push(`x-powered-by: ${res.headers.get("x-powered-by")}`);
    log(`headers on /: ${Object.keys(HEADERS).map((k) => `${k}=${res.headers.get(k)}`).join(" | ")}`);
  } finally {
    await off.stop();
  }

  const on = await serve(true);
  try {
    const statuses = await Promise.all(DEV_PATHS.map(async (p) => [p, (await fetch(on.origin + p)).status] as const));
    log(`INVERSA_DEV_ROUTES=1: ${statuses.map(([p, s]) => `${p}=${s}`).join(" ")}`);
    for (const [p, s] of statuses) if (s !== 200) failures.push(`${p} answered ${s} with INVERSA_DEV_ROUTES=1`);
  } finally {
    await on.stop();
  }

  for (const f of failures) log(`FAIL ${f}`);
  console.log(failures.length ? `PROD-SURFACE-FAIL ${failures.length}` : "PROD-SURFACE-OK dev=404 hook=absent headers=ok");
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
