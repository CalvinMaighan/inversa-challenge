/**
 * Globe browser gates (T17 G3 and G4) against a production build:
 *
 *   bun run e2e:globe            build, start `next start` (standalone), run, print the GLOBE and IDLE-FRAMES lines
 *   bun run e2e:globe --shot     also save a screenshot to docs/evidence/t17-globe.png
 *   E2E_SKIP_BUILD=1 …           reuse the last build
 *
 * The page is the dev route `/dev/globe` (the real Cesium globe, keyless imagery; production builds show no
 * fixture frames). The script checks that the page is cross-origin isolated, that no request is blocked by
 * COEP/CORP (console messages and failed requests), that imagery tiles and Cesium's workers load, and then,
 * after the scene settles, counts `scene.postRender` events over 5 s of idle. Animation frames are counted
 * alongside, to prove the page was live (a hidden page would also render nothing).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

const APP_DIR = path.resolve(import.meta.dir, "..");
const REPO_DIR = path.resolve(APP_DIR, "../..");
const SERVER = path.join(APP_DIR, ".next/standalone/apps/web/server.js");
const SHOT = path.join(REPO_DIR, "docs/evidence/t17-globe.png");
const IDLE_MS = 5_000;
const SETTLE_MS = 4_000;

const log = (...args: unknown[]) => console.error("[e2e:globe]", ...args);

/** Console or network messages that mean COEP / CORP blocked something. */
const ISOLATION_ERROR = /cross-origin-(embedder|resource)-policy|\bCOEP\b|\bCORP\b|ERR_BLOCKED_BY_RESPONSE|NotSameOrigin|require-corp/i;

function build() {
  if (process.env.E2E_SKIP_BUILD === "1" && Bun.file(SERVER).size > 0) return;
  log("next build …");
  const res = Bun.spawnSync(["bun", "run", "build"], { cwd: APP_DIR, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    console.error(res.stdout.toString(), res.stderr.toString());
    throw new Error(`build failed with exit code ${res.exitCode}`);
  }
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function startServer(port: number) {
  const proc = Bun.spawn(["bun", SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      INVERSA_DEV_ROUTES: "1",
      // Nothing listens here: the layers' GraphQL calls fail fast instead of reaching a real API.
      INVERSA_API_ORIGIN: "http://127.0.0.1:9",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}/dev/globe`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return { proc, url };
      if (res.status === 404) throw new Error("dev route is off (INVERSA_DEV_ROUTES not seen by the server)");
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("dev route")) throw err;
    }
    if (Date.now() > deadline || proc.exitCode !== null) {
      proc.kill();
      throw new Error(`server did not come up on ${url}`);
    }
    await Bun.sleep(250);
  }
}

type IdleResult = { postRenders: number; animationFrames: number; requestRenderMode: boolean; governor: string; imagery: string | null };

/** Runs inside the page, after the scene settled. */
async function measureIdle(ms: number): Promise<IdleResult> {
  const handle = window.__globe!;
  let postRenders = 0;
  let animationFrames = 0;
  let live = true;
  const tick = () => {
    animationFrames += 1;
    if (live) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const off = handle.api.onPostRender(() => {
    postRenders += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  live = false;
  off();
  const d = handle.diagnostics();
  return { postRenders, animationFrames, requestRenderMode: d.requestRenderMode, governor: d.governor.mode, imagery: d.imagery.base };
}

async function main() {
  const shot = process.argv.includes("--shot");
  build();
  const port = freePort();
  const { proc, url } = await startServer(port);
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const consoleErrors: string[] = [];
    const isolationErrors: string[] = [];
    const failedRequests: string[] = [];
    const responses = { tiles: 0, workers: 0, cesium: 0 };
    page.on("console", (m) => {
      if (m.type() !== "error" && m.type() !== "warning") return;
      if (m.type() === "error") consoleErrors.push(m.text());
      if (ISOLATION_ERROR.test(m.text())) isolationErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    page.on("requestfailed", (r) => {
      const reason = r.failure()?.errorText ?? "";
      failedRequests.push(`${r.url()} ${reason}`);
      if (ISOLATION_ERROR.test(reason)) isolationErrors.push(`${r.url()} ${reason}`);
    });
    page.on("response", (r) => {
      if (!r.ok()) return;
      const u = r.url();
      if (u.includes("arcgisonline.com") && u.includes("/tile/")) responses.tiles += 1;
      else if (u.includes("openstreetmap.org")) responses.tiles += 1;
      else if (u.includes("/cesium/Workers/")) responses.workers += 1;
      else if (u.endsWith("/cesium/index.js")) responses.cesium += 1;
    });

    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__globe), undefined, { timeout: 60_000 });
    const isolated = await page.evaluate(() => window.crossOriginIsolated);
    await page.waitForTimeout(SETTLE_MS);
    const idle = await page.evaluate(measureIdle, IDLE_MS);

    const apiErrors = consoleErrors.filter((e) => /status of 5\d\d|graphql/i.test(e)).length;
    console.log(
      `GLOBE coi=${isolated} isolation_errors=${isolationErrors.length} imagery=${idle.imagery} tiles=${responses.tiles} workers=${responses.workers} cesium=${responses.cesium} console_errors=${consoleErrors.length} (api_5xx=${apiErrors})`,
    );
    console.log(`IDLE-FRAMES ${idle.postRenders} raf=${idle.animationFrames} requestRenderMode=${idle.requestRenderMode} governor=${idle.governor}`);
    if (isolationErrors.length) log("isolation errors:", isolationErrors);
    if (consoleErrors.length) log("console errors:", consoleErrors);
    if (failedRequests.length) log("failed requests:", failedRequests);

    if (!isolated || isolationErrors.length > 0) failed = true;
    if (responses.cesium === 0 || responses.tiles === 0) failed = true;
    if (idle.postRenders !== 0 || !idle.requestRenderMode || idle.animationFrames < 30) failed = true;
    if (shot) {
      mkdirSync(path.dirname(SHOT), { recursive: true });
      await page.screenshot({ path: SHOT });
      log(`screenshot → ${path.relative(REPO_DIR, SHOT)}`);
    }
  } finally {
    await browser.close();
    proc.kill();
    await proc.exited;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
