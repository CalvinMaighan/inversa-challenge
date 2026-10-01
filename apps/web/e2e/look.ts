/**
 * GE2 e2e (gates/leaf-GE2.md): the seven visual presets, the crossfade, the scope mask and the frame cost, on
 * the real stack (e2e/stack.ts: Axum with the fixture backfill, `next start`, the signal Worker, one proxy
 * origin) in headless Chromium with a real WebGL2 context: ANGLE over Metal on a Mac (the machine's GPU, so
 * the fade and the frame cost are what a user sees), SwiftShader elsewhere or with `E2E_SOFTWARE_GL=1`. The
 * renderer string is logged.
 *
 *   bun run e2e:look             build, run, print the LOOK and SCOPE lines, save the screenshots
 *   E2E_SKIP_BUILD=1 …           reuse the last e2e build
 *
 * The page opens over the Florida Keys and the lower Everglades at 2026-09-09T20:00Z, where the fixtures hold
 * Burmese python sightings, and drives the Look popover through its real buttons:
 *
 * 1. Each preset in turn (its button, `aria-pressed`): the stage renders without a render error (`compiled`),
 *    and a screenshot's centre is not black and differs from `normal`. `LOOK presets=7 compiled=7 nonblack=7`,
 *    screenshots docs/evidence/look-<preset>.png.
 * 2. normal → nvg while sampling both stage intensities on every animation frame: the incoming one only rises,
 *    the outgoing one only falls, they never sum above one, and the ramp takes about 500 ms.
 *    `LOOK fade ms=<n> monotonic=1`.
 * 3. The scope, measured on the page as the user sees it (GE7: one scope, the stage shell's CSS circle on
 *    `[data-stage]`): with it off the far edge shows imagery; on, the centre is untouched and the edge is black;
 *    the feather slider (Home = 0, End = 100) widens the soft edge, measured as the pixels along rays from the
 *    stage centre whose brightness lies between the unmasked value and black. The circle's edge lies as far
 *    from the stage centre to the right as upwards (within 3 px) and at the stage's radius: it is centred on
 *    `[data-stage]`. `SCOPE on=1 off=1 feather0_edge=<px> feather60_edge=<px> centred=1 radius=<px>`, screenshots
 *    look-scope-*.png.
 * 4. Keyboard: the arrow keys move between preset buttons, Enter picks one, Escape closes the popover and
 *    hands focus back to the Look button. `LOOK keyboard=ok`.
 * 5. The share link carries `look`, `scope` and `feather`, and reopening it restores them. `LOOK link=ok`.
 * 6. Frame cost: 30 back-to-back frames with normal and with nvg; the medians. `LOOK perf normal=<ms> nvg=<ms>`,
 *    nvg within 1.5x of normal.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
/** The Axum fixtures were recorded 2026-09-30T20:40Z; the browser clock sits just after them. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
/** The Keys and the lower Everglades, looking straight down, in the fixtures' python window. */
const LINK = "#v=2&app=python&c=25.05,-80.95,230000,0,-90&t=2026-09-09T20:00Z";
const PRESETS = ["normal", "crt", "nvg", "flir", "noir", "anime", "snow"] as const;
const LOAD_TIMEOUT_MS = 120_000;
const PYTHON_TAXON = "1";
const BUTTON = "[data-testid=look-button]";
const POPOVER = "[data-testid=look-popover]";
const SWITCH = "[data-testid=scope-switch]";
const FEATHER = "[data-testid=scope-feather]";
const BENCH_FRAMES = 30;
const SOFTWARE_GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const METAL_GL = ["--use-angle=metal", "--ignore-gpu-blocklist"];
const GL_ARGS = process.platform === "darwin" && process.env.E2E_SOFTWARE_GL !== "1" ? METAL_GL : SOFTWARE_GL;

const log = (...a: unknown[]) => console.error("[e2e:look]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type Rect = { x: number; y: number; width: number; height: number };
type LookState = {
  target: string;
  shown: string | null;
  fading: boolean;
  intensity: Record<string, number>;
  compiled: string[];
  errors: string[];
  lastFade: { requestedAt: number; startedAt: number | null; endedAt: number | null; ticks: number[] } | null;
  scope: { on: boolean; feather: number };
};

const lookState = (page: Page) => page.evaluate(() => window.__look!.state() as unknown as LookState);

const rectOf = (page: Page, selector: string): Promise<Rect> =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
const paneRect = (page: Page) => rectOf(page, '[data-slot="globe-pane"]');
/** The stage circle (GE1's `[data-stage]`): the scope is centred on it. */
const stageRect = (page: Page) => rectOf(page, "[data-stage]");

async function openPopover(page: Page): Promise<void> {
  if ((await page.locator(POPOVER).count()) > 0) return;
  await page.locator(BUTTON).click();
  await page.locator(POPOVER).waitFor({ timeout: 10_000 });
}

async function closePopover(page: Page): Promise<void> {
  if ((await page.locator(POPOVER).count()) === 0) return;
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), POPOVER, { timeout: 10_000 });
}

/** Pick a preset through its button and wait until it is fully on screen and rendered. */
async function pick(page: Page, id: string): Promise<void> {
  await openPopover(page);
  await page.locator(`${POPOVER} button[data-look="${id}"]`).click();
  await page.waitForFunction((want) => window.__look!.state().shown === want && !window.__look!.state().fading, id, { timeout: 10_000 });
  await page.waitForFunction((want) => document.querySelector(`button[data-look="${want}"]`)?.getAttribute("aria-pressed") === "true", id);
  // A frame with the stage at full intensity, then the compositor.
  await page.evaluate(() => new Promise<void>((resolve) => window.__look!.bench(1).then(() => requestAnimationFrame(() => resolve()))));
  await page.waitForTimeout(250);
}

type Analysis = { centre: { bright: number; total: number; mean: [number, number, number] }; rays: number[][] };

/**
 * Decode a screenshot inside the page and sample it: the share of bright pixels and the mean colour of the
 * centre square, and the brightest channel of every pixel along each ray from the stage centre to the pane's
 * edge (right, left, up: down would cross the Look popover).
 */
async function analyze(page: Page, png: Buffer, pane: Rect, centreHalf: number, stage: Rect): Promise<Analysis> {
  return page.evaluate(
    async ({ b64, pane, centreHalf, stage }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height).data;
      const at = (x: number, y: number) => {
        const i = (Math.round(y) * c.width + Math.round(x)) * 4;
        return [data[i]!, data[i + 1]!, data[i + 2]!] as [number, number, number];
      };
      const cx = stage.x + stage.width / 2;
      const cy = stage.y + stage.height / 2;
      let bright = 0;
      let total = 0;
      const sum = [0, 0, 0];
      for (let y = cy - centreHalf; y < cy + centreHalf; y += 2) {
        for (let x = cx - centreHalf; x < cx + centreHalf; x += 2) {
          const p = at(x, y);
          total += 1;
          if (Math.max(...p) >= 16) bright += 1;
          sum[0] += p[0];
          sum[1] += p[1];
          sum[2] += p[2];
        }
      }
      const ray = (dx: number, dy: number) => {
        const out: number[] = [];
        for (let x = cx, y = cy; x >= pane.x && x < pane.x + pane.width && y >= pane.y && y < pane.y + pane.height; x += dx, y += dy) out.push(Math.max(...at(x, y)));
        return out;
      };
      return { centre: { bright, total, mean: sum.map((v) => v / total) as [number, number, number] }, rays: [ray(1, 0), ray(-1, 0), ray(0, -1)] };
    },
    { b64: png.toString("base64"), pane, centreHalf, stage },
  );
}

/** Pixels along a ray whose brightness sits strictly between the unmasked value and black: the soft edge. */
function edgeWidth(on: number[], off: number[]): number {
  let n = 0;
  for (let i = 0; i < Math.min(on.length, off.length); i++) {
    const o = off[i]!;
    if (o < 24) continue;
    const ratio = on[i]! / o;
    if (ratio > 0.08 && ratio < 0.92) n += 1;
  }
  return n;
}

/** Distance from the centre to the first pixel along a ray that is darker than half its unmasked value. */
function edgeAt(on: number[], off: number[]): number {
  for (let i = 0; i < Math.min(on.length, off.length); i++) {
    const o = off[i]!;
    if (o >= 24 && on[i]! / o < 0.5) return i;
  }
  return -1;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  buildWeb(log);
  buildApi(log);
  const stack = await startStack({ name: "look", app: "python" });
  const browser = await chromium.launch({ headless: true, args: GL_ARGS });
  let failed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await context.clock.install({ time: new Date(FIXTURE_CLOCK) });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${stack.origin}/${LINK}`, { waitUntil: "load" });
    await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction(() => Boolean(window.__look) && window.__inversa?.globe() !== null, undefined, { timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction((id) => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.breakdown?.[id] ?? 0) > 0, PYTHON_TAXON, { timeout: LOAD_TIMEOUT_MS });
    // Imagery tiles and the markers settle.
    await page.waitForTimeout(6_000);
    const pane = await paneRect(page);
    const stage = await stageRect(page);
    if (stage.width < 100) fail(`no stage circle at 1280 px: ${JSON.stringify(stage)}`);
    const drawn = await page.evaluate(() => window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.count ?? 0);
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return gl ? String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : "no webgl2";
    });
    log(`webgl2 renderer: ${renderer}`);
    log(`pane ${Math.round(pane.width)}×${Math.round(pane.height)} at ${Math.round(pane.x)},${Math.round(pane.y)}; ${drawn} sightings drawn`);
    const initial = await lookState(page);
    if (initial.target !== "normal" || !initial.scope.on || initial.scope.feather !== 11) fail(`initial look ${JSON.stringify(initial)}; want normal, scope on, feather 11`);

    // ---- 1. presets ---------------------------------------------------------------------------------------
    let nonblack = 0;
    let normalMean: [number, number, number] | null = null;
    for (const id of PRESETS) {
      await pick(page, id);
      await closePopover(page);
      await page.waitForTimeout(150);
      const png = await page.screenshot({ path: path.join(SHOT_DIR, `look-${id}.png`) });
      const a = await analyze(page, png, pane, 150, stage);
      const share = a.centre.bright / a.centre.total;
      const diff = normalMean ? a.centre.mean.reduce((acc, v, i) => acc + Math.abs(v - normalMean![i]!), 0) / 3 : 0;
      const ok = share >= 0.25 && (id === "normal" || diff >= 2);
      if (ok) nonblack += 1;
      if (id === "normal") normalMean = a.centre.mean;
      const s = await lookState(page);
      log(`${id}: centre bright ${(share * 100).toFixed(0)}%, mean ${a.centre.mean.map((v) => v.toFixed(0)).join(",")}, vs normal ${diff.toFixed(1)}, compiled ${s.compiled.length}, errors ${s.errors.length}${ok ? "" : "  <- NOT OK"}`);
    }
    const afterAll = await lookState(page);
    if (afterAll.errors.length) log(`render errors: ${afterAll.errors.join(" | ")}`);
    console.log(`LOOK presets=${PRESETS.length} compiled=${afterAll.compiled.length} nonblack=${nonblack}`);
    if (afterAll.compiled.length !== 7 || nonblack !== 7 || afterAll.errors.length) failed = true;

    // ---- 2. crossfade -------------------------------------------------------------------------------------
    await pick(page, "normal");
    await page.evaluate(() => {
      const w = window as unknown as { __fadeSamples: { t: number; to: number; from: number; sum: number }[] };
      w.__fadeSamples = [];
      const tick = () => {
        const s = window.__look!.state();
        w.__fadeSamples.push({ t: performance.now(), to: s.intensity.nvg, from: s.intensity.normal, sum: s.intensity.nvg + s.intensity.normal });
        if (w.__fadeSamples.length < 400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.locator(`${POPOVER} button[data-look="nvg"]`).click();
    await page.waitForFunction(() => window.__look!.state().shown === "nvg", undefined, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const samples = await page.evaluate(() => (window as unknown as { __fadeSamples: { t: number; to: number; from: number; sum: number }[] }).__fadeSamples);
    const firstMoving = samples.findIndex((s) => s.to > 0);
    const firstDone = samples.findIndex((s) => s.to >= 1);
    const lastStill = firstMoving > 0 ? firstMoving - 1 : 0;
    let monotonic = firstMoving > 0 && firstDone > firstMoving;
    let between = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      if (b.to < a.to - 1e-6 || b.from > a.from + 1e-6 || b.sum > 1 + 1e-6) monotonic = false;
      if (b.to > 0 && b.to < 1) between += 1;
    }
    if (between < 3) monotonic = false;
    const fadeMs = firstDone > 0 ? samples[firstDone]!.t - samples[lastStill]!.t : -1;
    const fade = (await lookState(page)).lastFade;
    const internalMs = fade?.endedAt != null && fade.startedAt != null ? fade.endedAt - fade.startedAt : -1;
    const warmMs = fade?.startedAt != null ? fade.startedAt - fade.requestedAt : -1;
    const ticks = fade?.ticks ?? [];
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]!);
    log(`fade: ${samples.length} samples, ${between} mid-ramp, sampled ${fadeMs.toFixed(0)} ms; the module's own clock ${internalMs.toFixed(0)} ms over ${ticks.length} ticks after a ${warmMs.toFixed(0)} ms warm-up frame (tick gaps ms: ${gaps.map((g) => g.toFixed(0)).join(" ")})`);
    console.log(`LOOK fade ms=${Math.round(fadeMs)} monotonic=${monotonic ? 1 : 0}`);
    if (!monotonic || fadeMs < 350 || fadeMs > 700) failed = true;

    // ---- 3. scope -----------------------------------------------------------------------------------------
    await pick(page, "normal");
    const slider = page.locator(FEATHER);
    const setFeather = async (pct: number) => {
      await slider.focus();
      await page.keyboard.press("Home");
      for (let i = 0; i < pct; i++) await page.keyboard.press("ArrowRight");
      await page.waitForFunction((want) => window.__look!.state().scope.feather === want, pct, { timeout: 10_000 });
      await page.waitForTimeout(400);
    };
    const scopeShot = async (name: string) => {
      const png = await page.screenshot({ path: path.join(SHOT_DIR, `look-scope-${name}.png`) });
      return analyze(page, png, pane, 60, stage);
    };
    await page.locator(SWITCH).click();
    await page.waitForFunction(() => !window.__look!.state().scope.on, undefined, { timeout: 10_000 });
    await page.waitForTimeout(400);
    const off = await scopeShot("off");
    await page.locator(SWITCH).click();
    await page.waitForFunction(() => window.__look!.state().scope.on, undefined, { timeout: 10_000 });
    await setFeather(0);
    const f0 = await scopeShot("feather-0");
    await setFeather(60);
    const f60 = await scopeShot("feather-60");
    // The right-hand ray leaves the circle (the pane is wider than tall): its last pixels are outside.
    const edgeOff = off.rays[0]!.at(-3)!;
    const edgeOn = f0.rays[0]!.at(-3)!;
    const centreOff = off.rays[0]![0]!;
    const centreOn = f0.rays[0]![0]!;
    const scopeOn = Math.abs(centreOn - centreOff) <= 8 && edgeOn <= 6 && edgeOff >= 24;
    const scopeOff = edgeOff >= 24 && off.centre.bright / off.centre.total >= 0.25;
    // The right and upward rays only: the left one runs under the chat card, whose glass shows the mask through it.
    const clear = [0, 2];
    const e0 = Math.max(...clear.map((i) => edgeWidth(f0.rays[i]!, off.rays[i]!)));
    const e60 = Math.max(...clear.map((i) => edgeWidth(f60.rays[i]!, off.rays[i]!)));
    // Centred on [data-stage]: the hard edge (feather 0) as far to the right as upwards, at the stage's radius.
    const radius = stage.width / 2;
    const [edgeRight, edgeUp] = clear.map((i) => edgeAt(f0.rays[i]!, off.rays[i]!));
    const centred = edgeRight > 0 && edgeUp > 0 && Math.abs(edgeRight - edgeUp) <= 3 && Math.abs(edgeRight - radius) <= 3;
    log(`scope: centre off ${centreOff} on ${centreOn}; edge off ${edgeOff} on ${edgeOn}; stage ${JSON.stringify(stage)} radius ${radius} px, edge right ${edgeRight} up ${edgeUp}`);
    console.log(`SCOPE on=${scopeOn ? 1 : 0} off=${scopeOff ? 1 : 0} feather0_edge=${e0} feather60_edge=${e60} centred=${centred ? 1 : 0} radius=${Math.round(radius)}`);
    if (!scopeOn || !scopeOff || e60 <= e0 || e0 > 4 || !centred) failed = true;
    await setFeather(11);

    // ---- 4. keyboard --------------------------------------------------------------------------------------
    await closePopover(page);
    await page.locator(BUTTON).focus();
    await page.keyboard.press("Enter");
    await page.locator(POPOVER).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Tab");
    const onFirst = await page.evaluate(() => document.activeElement?.getAttribute("data-look"));
    await page.keyboard.press("ArrowRight");
    const onSecond = await page.evaluate(() => document.activeElement?.getAttribute("data-look"));
    await page.keyboard.press("Enter");
    await page.waitForFunction((want) => window.__look!.state().target === want, onSecond, { timeout: 10_000 });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__look!.state().target === "normal", undefined, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction((sel) => !document.querySelector(sel), POPOVER, { timeout: 10_000 });
    const backOnButton = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, BUTTON);
    const keyboard = onFirst === "normal" && onSecond === "crt" && backOnButton;
    log(`keyboard: Tab → ${onFirst}, ArrowRight → ${onSecond}, Enter picked it, ArrowLeft+Enter back to normal, Esc → button focused ${backOnButton}`);
    console.log(`LOOK keyboard=${keyboard ? "ok" : "fail"}`);
    if (!keyboard) failed = true;

    // ---- 5. share link ------------------------------------------------------------------------------------
    await pick(page, "flir");
    await setFeather(60);
    await page.locator(SWITCH).click();
    await page.waitForFunction(() => /look=flir/.test(location.hash) && /scope=0/.test(location.hash) && /feather=60/.test(location.hash), undefined, { timeout: 10_000 });
    const hash = await page.evaluate(() => location.hash);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__look) && window.__look!.state().shown === "flir", undefined, { timeout: LOAD_TIMEOUT_MS });
    const restored = await lookState(page);
    const link = restored.target === "flir" && !restored.scope.on && restored.scope.feather === 60;
    log(`share link ${hash.replace(/^#/, "").split("&").filter((f) => /^(look|scope|feather)=/.test(f)).join("&")} → reopened as ${restored.target}, scope ${restored.scope.on ? "on" : "off"}, feather ${restored.scope.feather}`);
    console.log(`LOOK link=${link ? "ok" : "fail"}`);
    if (!link) failed = true;

    // ---- 6. frame cost ------------------------------------------------------------------------------------
    await page.waitForFunction((id) => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.breakdown?.[id] ?? 0) > 0, PYTHON_TAXON, { timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(4_000);
    await page.locator(BUTTON).click();
    await page.locator(POPOVER).waitFor({ timeout: 10_000 });
    await page.locator(SWITCH).click();
    await page.waitForFunction(() => window.__look!.state().scope.on, undefined, { timeout: 10_000 });
    const bench = async (id: string) => {
      await pick(page, id);
      await page.evaluate((n) => window.__look!.bench(n), 5);
      return median(await page.evaluate((n) => window.__look!.bench(n), BENCH_FRAMES));
    };
    const normalMs = await bench("normal");
    const nvgMs = await bench("nvg");
    log(`perf: ${BENCH_FRAMES} frames each, nvg/normal ${(nvgMs / normalMs).toFixed(2)}x`);
    console.log(`LOOK perf normal=${normalMs.toFixed(1)} nvg=${nvgMs.toFixed(1)}`);
    if (nvgMs > normalMs * 1.5) failed = true;
    await pick(page, "normal");

    if (errors.length) {
      log(`page errors: ${errors.join(" | ")}`);
      failed = true;
    }
    await context.close();
  } finally {
    await browser.close();
    await stack.stop();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
