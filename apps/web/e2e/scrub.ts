/**
 * Scrub benchmark (T18 gate G2): drag the HUD timeline across all 96 fixture frames and prove that a frame
 * change costs no network and lands within one display frame.
 *
 *   bun run e2e:scrub            build, start `next start` (standalone), run, print the SCRUB line
 *   bun run e2e:scrub --shot     also save the gap-hatching screenshot to docs/evidence/t18-gaps.png
 *   E2E_SKIP_BUILD=1 …           reuse the last build
 *
 * The page is the dev route `/dev/hud`: the real `Hud` over a SAB FrameGrid of 96 EVF2 frames (built with
 * `allocFrameGrid`, published with `publishFrameGrid`) and a stand-in globe that renders each frame from the
 * grid on the next animation frame, as Cesium does in request-render mode.
 *
 * Per step, in the page: wait a random 0–16 ms (so input lands at a random point of the display frame, not
 * right after a vsync), mark, set the scrubber's value and dispatch `input` (the path a drag takes), then
 * mark again in the next `requestAnimationFrame` callback. That span is the frame-change latency: HUD
 * re-render, TIME fan-out, the globe reading the frame from the SAB and redrawing, overlays re-projected.
 * Every request and WebSocket opened between the first and last step is counted.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

const APP_DIR = path.resolve(import.meta.dir, "..");
const REPO_DIR = path.resolve(APP_DIR, "../..");
const SERVER = path.join(APP_DIR, ".next/standalone/apps/web/server.js");
const SHOT = path.join(REPO_DIR, "docs/evidence/t18-gaps.png");
const FRAMES = 96;

const log = (...args: unknown[]) => console.error("[e2e:scrub]", ...args);

function build() {
  if (process.env.E2E_SKIP_BUILD === "1" && existsSync(SERVER)) return;
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
      // Nothing listens here: a stray /v1 call fails fast instead of reaching a real API.
      INVERSA_API_ORIGIN: "http://127.0.0.1:9",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}/dev/hud`;
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

type ScrubResult = { latencies: number[]; work: number[]; rendered: number[]; max: number };

/** Runs inside the page. */
async function scrubInPage(): Promise<ScrubResult> {
  const input = document.querySelector<HTMLInputElement>("[data-hud-scrubber]");
  const globe = document.querySelector<HTMLCanvasElement>("[data-testid=fixture-globe]");
  if (!input || !globe) throw new Error("scrubber or fixture globe missing");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const max = Number(input.max);
  const latencies: number[] = [];
  const work: number[] = [];
  const rendered: number[] = [];
  await nextFrame();
  await nextFrame();
  for (let i = 0; i <= max; i++) {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 16));
    const start = `scrub-${i}-start`;
    const end = `scrub-${i}-end`;
    performance.mark(start);
    setValue.call(input, String(i));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    work.push(performance.now() - performance.getEntriesByName(start, "mark")[0]!.startTime);
    await nextFrame();
    performance.mark(end);
    latencies.push(performance.measure(`scrub-${i}`, start, end).duration);
    rendered.push(Number(globe.dataset.frame ?? -1));
  }
  return { latencies, work, rendered, max };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

async function screenshot(page: Page) {
  // A frame inside the scripted cloud deck, so the globe shows masked cells as well as the timeline hatching.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("[data-hud-scrubber]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "60");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const track = page.locator("[data-testid=hud-timeline-canvas]");
  const box = await track.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * (76 / 95), box.y + box.height / 2);
  await page.waitForTimeout(300);
  mkdirSync(path.dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT });
  log(`screenshot → ${path.relative(REPO_DIR, SHOT)}`);
}

async function main() {
  const shot = process.argv.includes("--shot");
  build();
  const port = freePort();
  const { proc, url } = await startServer(port);
  const browser = await chromium.launch({ headless: true });
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const consoleErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-hud-scrubber]", { timeout: 30_000 });
    const isolated = await page.evaluate(() => window.crossOriginIsolated);
    if (!isolated) throw new Error("page is not cross-origin isolated; SharedArrayBuffer unavailable");
    await page.waitForTimeout(600); // let mount effects and the first share-link write settle

    let recording = false;
    const requests: string[] = [];
    page.on("request", (r) => recording && requests.push(`${r.method()} ${r.url()}`));
    page.on("websocket", (ws) => recording && requests.push(`WS ${ws.url()}`));
    recording = true;
    const result = await page.evaluate(scrubInPage);
    recording = false;

    const steps = result.max + 1;
    const verified = result.rendered.filter((f, i) => f === i).length;
    const med = median(result.latencies);
    console.log(
      `SCRUB median=${med.toFixed(2)} requests=${requests.length} p95=${p95(result.latencies).toFixed(2)} work_median=${median(result.work).toFixed(2)} frames=${steps} verified=${verified}`,
    );
    if (requests.length) log("requests during scrub:", requests);
    if (consoleErrors.length) log("console errors:", consoleErrors);
    if (steps !== FRAMES) {
      log(`expected ${FRAMES} scrubber positions, found ${steps}`);
      failed = true;
    }
    if (verified !== steps) {
      log(`globe rendered the wrong frame on ${steps - verified} steps: ${JSON.stringify(result.rendered)}`);
      failed = true;
    }
    if (requests.length > 0 || med >= 16) failed = true;
    if (shot) await screenshot(page);
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
