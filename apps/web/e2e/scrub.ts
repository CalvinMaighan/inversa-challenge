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
 *
 * Per app (rubric `scrub-speed`, `timeline-replay/scrub-frames`):
 *
 *   bun run e2e:scrub -- --app <id>   the app's own page on the real stack (e2e/stack.ts: Axum over the app's fixture
 *                                    backfill, the production e2e build, the signal Worker, the proxy)
 *
 * The same per-step measurement on the timeline the app shows, over 96 positions an hour apart (python and lionfish:
 * the HUD scrubber, four 15-minute steps per position; carp: the stage chart's "what we knew" scrubber), each
 * checked against what the app draws after that display frame: python, the globe's sightings layer is on the
 * cursor's frame; lionfish, the survey overlay's as-of is the cursor's time; carp, the chart's cursor moved to the
 * new position. Requests: every HTTP request and every WebSocket message the page sends while scrubbing.
 * Line: `SCRUB app=<id> median=<ms> requests=<n> p95=<ms> work_median=<ms> frames=<verified distinct frames>
 * steps=<n>`; exit 0 only when median < 16 ms, p95 <= 33.3 ms, requests = 0 and every step drew its frame.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

import type { AppId } from "../shared/apps";
import { appArg } from "./args";
import { buildApi, buildWeb, startStack } from "./stack";

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

// ---- per app, on the real stack ------------------------------------------------------------------------

const POSITIONS = 96;

type AppScrub = { latencies: number[]; work: number[]; drawn: string[]; verified: boolean[] };

/** Runs inside the page: one input per position, timed to the next animation frame, then what the app drew checked. */
async function scrubAppInPage({ kind, positions }: { kind: AppId; positions: number }): Promise<AppScrub> {
  const input = document.querySelector<HTMLInputElement>(kind === "carp" ? "[data-carp-scrubber]" : "[data-hud-scrubber]");
  if (!input) throw new Error("no scrubber");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const d = window.__inversa!;
  const cursorMs = () => {
    const t = d.state("TIME") as { at?: string; to: string };
    return Date.parse(t.at ?? t.to);
  };
  // What the app drew, and whether it is the cursor's.
  const drawn = (): { value: string; ok: (before: string) => boolean } => {
    if (kind === "python") {
      const frame = d.globe()?.layers.find((l) => l.id === "sightings")?.frame ?? -1;
      const want = d.snapshot().frame;
      return { value: String(frame), ok: () => frame >= 0 && frame === want };
    }
    if (kind === "lionfish") {
      const asof = document.querySelector('[data-testid="lionfish-overlay"]')?.getAttribute("data-asof") ?? "";
      return { value: asof, ok: () => asof === String(cursorMs()) };
    }
    const cursor = document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')?.dataset.cursor ?? "";
    return { value: cursor, ok: (before) => cursor !== "" && cursor !== before };
  };
  // The live edge is the scrubber's current value (carp: now inside a window that runs a week ahead).
  const top = kind === "carp" ? Number(input.value) : Number(input.max);
  const stride = kind === "carp" ? 1 : 4;
  const latencies: number[] = [];
  const work: number[] = [];
  const values: string[] = [];
  const verified: boolean[] = [];
  await nextFrame();
  await nextFrame();
  for (let i = positions; i >= 1; i--) {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 16));
    const before = drawn().value;
    // The wall clock throughout: a Playwright clock would replace requestAnimationFrame and performance.now.
    const t0 = performance.now();
    setValue.call(input, String(top - i * stride));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    work.push(performance.now() - t0);
    await nextFrame();
    latencies.push(performance.now() - t0);
    const after = drawn();
    values.push(after.value);
    verified.push(after.ok(before));
  }
  return { latencies, work, drawn: values, verified };
}

async function appMain(app: AppId): Promise<void> {
  const alog = (...a: unknown[]) => console.error(`[e2e:scrub ${app}]`, ...a);
  buildApi(alog);
  buildWeb(alog);
  const stack = await startStack({ name: `scrub-${app}`, app, apps: [app] });
  // The GPU, as a user's browser has one (Metal on macOS); software GL elsewhere, where a frame of the real globe
  // costs the CPU tens of milliseconds and the latency measures the emulator, not the app.
  const defaultArgs = process.platform === "darwin" ? "--use-angle=metal" : "--use-angle=swiftshader --enable-unsafe-swiftshader";
  const gpuArgs = (process.env.SCRUB_CHROMIUM_ARGS ?? defaultArgs).split(/\s+/).filter(Boolean);
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  alog(`chromium ${gpuArgs.join(" ")}`);
  let failed = true;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Listening from the start: a socket opened at load reports the frames it sends later.
    let recording = false;
    const requests: string[] = [];
    page.on("request", (r) => {
      if (recording) requests.push(`${r.method()} ${r.url()} ${(/"operationName":"(\w+)"|query\s+(\w+)/.exec(r.postData() ?? "") ?? []).slice(1).find(Boolean) ?? ""}`);
    });
    page.on("websocket", (ws) => {
      if (recording) requests.push(`WS open ${ws.url()}`);
      ws.on("framesent", (f) => recording && requests.push(`WS send ${ws.url()} ${String(f.payload).slice(0, 80)}`));
    });
    await page.goto(`${stack.origin}/?app=${app}`, { waitUntil: "load" });
    if (app === "python") {
      await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.frame ?? -1) >= 0, undefined, { timeout: 120_000 });
    } else if (app === "lionfish") {
      await page.locator('[data-testid="lionfish-hud"][data-replay-ready="1"]').waitFor({ state: "attached", timeout: 120_000 });
      if (await page.locator('[data-testid="lionfish-banner-dismiss"]').count()) await page.click('[data-testid="lionfish-banner-dismiss"]');
    } else {
      // A site's chart: the scrubber repaints its cursor.
      await page.waitForFunction(() => document.querySelectorAll("[data-carp-row]").length > 0, undefined, { timeout: 120_000 });
      await page.click('[data-carp-row="KRZL1"]');
      await page.waitForFunction(() => /forecast:[1-9]/.test(document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')?.dataset.series ?? ""), undefined, { timeout: 60_000 });
    }
    // Loaded: the feed states answered (the HUD's one-time feeds query), then mount effects, the first frame grid
    // and the feed subscription settle before recording.
    await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: 120_000 });
    await page.waitForTimeout(3_000);
    // The renderer's own pace with nothing changing, for reading the latencies on this machine.
    const idle = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const out: number[] = [];
          let last = performance.now();
          const tick = (now: number) => {
            out.push(now - last);
            last = now;
            if (out.length < 60) requestAnimationFrame(tick);
            else resolve(out.slice(1));
          };
          requestAnimationFrame(tick);
        }),
    );
    alog(`idle animation frame interval: median ${median(idle).toFixed(2)} ms, p95 ${p95(idle).toFixed(2)} ms`);
    recording = true;
    const r = await page.evaluate(scrubAppInPage, { kind: app, positions: POSITIONS });
    // Anything the last steps set off.
    await page.waitForTimeout(500);
    recording = false;

    const verified = r.verified.filter(Boolean).length;
    const frames = new Set(r.drawn.filter((v, i) => r.verified[i])).size;
    const med = median(r.latencies);
    const p = p95(r.latencies);
    console.log(`SCRUB app=${app} median=${med.toFixed(2)} requests=${requests.length} p95=${p.toFixed(2)} work_median=${median(r.work).toFixed(2)} frames=${frames} steps=${r.latencies.length} verified=${verified}`);
    if (requests.length) alog("requests during scrub:", requests.slice(0, 20));
    if (verified !== r.latencies.length) alog(`drawn frame not the cursor's on ${r.latencies.length - verified} steps: ${JSON.stringify(r.drawn)}`);
    if (errors.length) alog("page errors:", errors);
    failed = requests.length > 0 || med >= 16 || p > 33.3 || verified !== r.latencies.length || errors.length > 0;
    await context.close();
  } catch (err) {
    alog(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    alog(stack.logs());
  } finally {
    await browser.close();
    await stack.stop();
  }
  process.exit(failed ? 1 : 0);
}

async function main() {
  if (process.argv.some((a) => a === "--app" || a.startsWith("--app="))) return appMain(appArg());
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
