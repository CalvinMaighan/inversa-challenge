/**
 * Wave-1 integration e2e (gates/node-wave1.md G2): the real stack serves every app end to end. One Axum process
 * with all three apps (each data dir filled by `backfill --fixtures --app <id>`), the production e2e build, the
 * signal Worker and the Caddy-like proxy (e2e/stack.ts). For each app it opens `/?app=<id>` and checks:
 *
 *   health    `GET /health` is 200 and parses as the contract body (client/hud/appselect/health.ts
 *             `healthBodySchema`, strict), status ok, the app listed with its config's regions and taxa;
 *   graphql   the page's own GraphQL requests all went to `/v1/<id>/graphql` (none to another app or unprefixed)
 *             and a direct `{ feeds }` query through the proxy answers without errors;
 *   frames    `/v1/<id>/frames` answers EVF2 whose header carries the config's region count, region-0 grid and
 *             species count (`ok`); a conditions app (carp) answers 404 `no_frames` (`none`);
 *   console   no console error and no page error while the app loads and settles.
 *
 *   bun run e2e:stack          build, run, print one line per app
 *   E2E_SKIP_BUILD=1 …         reuse the last e2e build
 *
 * Output: `STACK app=<id> health=ok graphql=ok frames=<ok|none> console_errors=0` per app, then `STACK-OK apps=3`.
 */
import { chromium, type Browser } from "playwright";

import { healthBodySchema } from "../client/hud/appselect/health";
import { APP_IDS, getApp, type AppId } from "../shared/apps";
import { evfRegions, readEvfHeader } from "../shared/frames";
import { buildApi, buildWeb, startStack, type Stack } from "./stack";

const LOAD_TIMEOUT_MS = 120_000;
/** Settle time after the page is ready, so late requests and their errors are counted. */
const SETTLE_MS = 5_000;

const log = (...a: unknown[]) => console.error("[e2e:stack]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

async function checkHealth(stack: Stack, id: AppId): Promise<string> {
  const res = await fetch(`${stack.origin}/health`);
  if (res.status !== 200) return `status-${res.status}`;
  const parsed = healthBodySchema.safeParse(await res.json());
  if (!parsed.success) return `shape:${parsed.error.issues[0]?.path.join(".")}`;
  if (parsed.data.status !== "ok") return parsed.data.status;
  const entry = parsed.data.apps.find((a) => a.id === id);
  if (!entry) return "missing";
  const app = getApp(id);
  if (entry.regions.join() !== app.regions.map((r) => r.id).join() || entry.taxa.join() !== app.taxa.map((t) => t.id).join()) return "config-mismatch";
  return "ok";
}

async function checkFrames(stack: Stack, id: AppId): Promise<string> {
  const to = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const res = await fetch(`${stack.origin}/v1/${id}/frames?from=${to - 3 * 3_600_000}&to=${to}`);
  const app = getApp(id);
  if (app.kind === "conditions") {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return res.status === 404 && body?.error === "no_frames" ? "none" : `unexpected-${res.status}`;
  }
  if (res.status !== 200) return `status-${res.status}`;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const header = readEvfHeader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const regions = evfRegions(header);
  if (header.speciesCount !== app.taxa.length) return `species-${header.speciesCount}`;
  if (regions.length !== app.regions.length) return `regions-${regions.length}`;
  for (const [i, r] of app.regions.entries()) {
    const got = regions[i]!;
    const cols = Math.round((r.bbox.east - r.bbox.west) / (2 * r.cellDeg));
    if (Math.abs(got.west - r.bbox.west) > 1e-9 || Math.abs(got.south - r.bbox.south) > 1e-9 || got.hsCols !== cols) return `region-${r.id}`;
  }
  return "ok";
}

async function checkApp(browser: Browser, stack: Stack, id: AppId): Promise<string> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  const gql: { url: string; status: number }[] = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.includes("/graphql")) gql.push({ url: new URL(r.url()).pathname, status: r.status() });
  });
  const first = stack.apiPaths.length;
  try {
    await page.goto(`${stack.origin}/?app=${id}`, { waitUntil: "load" });
    await page.locator(`[data-testid="app-select-button"][data-app="${id}"]`).waitFor({ timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-app-pending"), undefined, { timeout: LOAD_TIMEOUT_MS });
    // The feed subscription answered: the page has talked to its app's GraphQL.
    await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const paths = stack.apiPaths.slice(first).filter((p) => p.startsWith("/v1/"));
    const foreign = paths.filter((p) => !p.startsWith(`/v1/${id}/`));
    const pageGql = paths.filter((p) => p === `/v1/${id}/graphql`);
    const badStatus = gql.filter((g) => g.status >= 400);
    const direct = await fetch(`${stack.origin}/v1/${id}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ feeds { source state } }" }) });
    const directBody = (await direct.json()) as { data?: { feeds: unknown[] }; errors?: unknown[] };
    const graphql =
      foreign.length === 0 && pageGql.length > 0 && badStatus.length === 0 && direct.ok && !directBody.errors && Array.isArray(directBody.data?.feeds)
        ? "ok"
        : `bad(foreign=${foreign.length},page=${pageGql.length},status=${badStatus.map((b) => b.status).join("/")},direct=${direct.status})`;
    if (foreign.length) log(`${id}: requests outside its prefix: ${[...new Set(foreign)].join(", ")}`);
    const health = await checkHealth(stack, id);
    const frames = await checkFrames(stack, id);
    if (errors.length) log(`${id}: ${errors.length} errors:\n  ${errors.slice(0, 10).join("\n  ")}`);
    log(`${id}: ${paths.length} API requests (${pageGql.length} graphql)`);
    return `STACK app=${id} health=${health} graphql=${graphql} frames=${frames} console_errors=${errors.length}`;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "stack", app: "carp", apps: APP_IDS, pinApp: false });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let ok = 0;
  try {
    for (const id of APP_IDS) {
      const line = await checkApp(browser, stack, id);
      console.log(line);
      if (/health=ok graphql=ok frames=(ok|none) console_errors=0$/.test(line)) ok += 1;
    }
    if (ok !== APP_IDS.length) fail(`${APP_IDS.length - ok} app(s) failed`);
    console.log(`STACK-OK apps=${ok}`);
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
    process.exitCode = 1;
  } finally {
    await browser.close();
    await stack.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
