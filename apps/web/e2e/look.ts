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
  scope: { shape: string; size: number; feather: number };
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

const SHAPE = (s: string) => `[data-testid=scope-shape] button[data-shape="${s}"]`;
const SIZE = "[data-testid=scope-size]";
/** Hides the HUD and the chat card while the window is measured, so only the masked globe is on the page. */
const HIDE_HUD = '[data-slot="hud"], [data-slot="side"] { visibility: hidden !important; }';
const DRAWER = '[data-testid="hud-drawer"]';
const M_PER_DEG = 111_320;
const pct = (n: number) => Math.round(n);

/** Sets the soft edge (0..100) through the popover's slider and waits for the shell to follow. */
async function setFeatherPct(page: Page, value: number): Promise<void> {
  await openPopover(page);
  await page.locator(FEATHER).fill(String(value));
  await page.waitForFunction((want) => window.__look!.state().scope.feather === want, value, { timeout: 10_000 });
}

async function setShape(page: Page, shape: string): Promise<void> {
  await openPopover(page);
  await page.locator(SHAPE(shape)).click();
  await page.waitForFunction((want) => window.__look!.state().scope.shape === want, shape, { timeout: 10_000 });
}

async function setSizePct(page: Page, value: number): Promise<void> {
  await openPopover(page);
  await page.locator(SIZE).fill(String(value));
  await page.waitForFunction((want) => window.__look!.state().scope.size === want, value, { timeout: 10_000 });
}

/** A screenshot of the masked globe alone: popover closed, HUD hidden, the mask settled. */
async function shot(page: Page, name?: string): Promise<Buffer> {
  await closePopover(page);
  const style = await page.addStyleTag({ content: HIDE_HUD });
  await page.waitForTimeout(450);
  const png = await page.screenshot(name ? { path: path.join(SHOT_DIR, `look-${name}.png`) } : {});
  await style.evaluate((el) => (el as HTMLElement).remove());
  return png;
}

/**
 * Mean visibility (masked brightness over unmasked, percent) in rings around the window's centre, as multiples of its
 * radius `R`; pixels whose unmasked brightness is under 24 are too dark to judge and left out. `-1` for a ring with
 * nothing to judge.
 */
async function ringRatios(page: Page, on: Buffer, off: Buffer, c: { x: number; y: number; r: number }, pane: Rect, rings: [number, number][]): Promise<number[]> {
  return page.evaluate(
    async ({ a, b, c, pane, rings }) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const g = cv.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return { w: cv.width, d: g.getImageData(0, 0, cv.width, cv.height).data };
      };
      const on = await load(a);
      const off = await load(b);
      const sumOn = rings.map(() => 0);
      const sumOff = rings.map(() => 0);
      for (let y = Math.max(0, Math.floor(pane.y)); y < pane.y + pane.height; y += 2) {
        for (let x = Math.max(0, Math.floor(pane.x)); x < pane.x + pane.width; x += 2) {
          const i = (y * on.w + x) * 4;
          const o = Math.max(off.d[i]!, off.d[i + 1]!, off.d[i + 2]!);
          if (o < 24) continue;
          const r = Math.hypot(x - c.x, y - c.y) / c.r;
          rings.forEach(([r0, r1], k) => {
            if (r >= r0 && r < r1) {
              sumOn[k] += Math.max(on.d[i]!, on.d[i + 1]!, on.d[i + 2]!);
              sumOff[k] += o;
            }
          });
        }
      }
      return sumOn.map((v, k) => (sumOff[k]! > 0 ? (100 * v) / sumOff[k]! : -1));
    },
    { a: on.toString("base64"), b: off.toString("base64"), c, pane, rings },
  );
}

/** Visibility (percent) in a small square around each point: masked over unmasked. */
async function pointRatios(page: Page, on: Buffer, off: Buffer, pts: { x: number; y: number }[], half = 4): Promise<number[]> {
  return page.evaluate(
    async ({ a, b, pts, half }) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const g = cv.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return { w: cv.width, d: g.getImageData(0, 0, cv.width, cv.height).data };
      };
      const on = await load(a);
      const off = await load(b);
      return pts.map((p) => {
        let sOn = 0;
        let sOff = 0;
        for (let y = Math.round(p.y) - half; y <= Math.round(p.y) + half; y++) {
          for (let x = Math.round(p.x) - half; x <= Math.round(p.x) + half; x++) {
            const i = (y * on.w + x) * 4;
            const o = Math.max(off.d[i]!, off.d[i + 1]!, off.d[i + 2]!);
            if (o < 24) continue;
            sOn += Math.max(on.d[i]!, on.d[i + 1]!, on.d[i + 2]!);
            sOff += o;
          }
        }
        return sOff > 0 ? (100 * sOn) / sOff : -1;
      });
    },
    { a: on.toString("base64"), b: off.toString("base64"), pts, half },
  );
}

type WindowArea = { area: number; eligible: number; cx: number; cy: number };

/** The visible window on a screenshot at soft edge 0: the sampled pixels at least half as bright as unmasked, as an area in px². */
async function windowArea(page: Page, on: Buffer, off: Buffer): Promise<WindowArea> {
  return page.evaluate(
    async ({ a, b }) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const g = cv.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return { w: cv.width, h: cv.height, d: g.getImageData(0, 0, cv.width, cv.height).data };
      };
      const on = await load(a);
      const off = await load(b);
      let visible = 0;
      let judged = 0;
      let total = 0;
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let y = 0; y < on.h; y += 2) {
        for (let x = 0; x < on.w; x += 2) {
          const i = (y * on.w + x) * 4;
          const o = Math.max(off.d[i]!, off.d[i + 1]!, off.d[i + 2]!);
          total += 1;
          if (o < 24) continue;
          judged += 1;
          if (Math.max(on.d[i]!, on.d[i + 1]!, on.d[i + 2]!) / o >= 0.5) {
            visible += 1;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
      }
      return { area: visible * 4, eligible: judged / total, cx: (x0 + x1 + 2) / 2, cy: (y0 + y1 + 2) / 2 };
    },
    { a: on.toString("base64"), b: off.toString("base64") },
  );
}

async function flyTo(page: Page, lat: number, lon: number, altitudeM: number): Promise<void> {
  await page.evaluate(
    ([la, lo, alt]) => {
      location.hash = `#v=1&c=${la.toFixed(5)},${lo.toFixed(5)},${alt},0,-90&t=2026-09-09T20:00Z`;
    },
    [lat, lon, altitudeM] as const,
  );
  await page.waitForFunction(
    ([la, lo]) => {
      const v = window.__inversa?.state("VIEW") as { lat: number; lon: number } | undefined;
      return !!v && Math.abs(v.lat - la) < 0.01 && Math.abs(v.lon - lo) < 0.01 && !!window.__inversa?.project(lo, la);
    },
    [lat, lon] as const,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1_500);
}

/**
 * GE11 (gates/leaf-GE11.md G2): the circle is always fully visible; the soft edge fades the map out OUTSIDE it. Visibility
 * (masked over unmasked pixels, HUD hidden) inside, just outside and far outside the circle at soft edge 0, the default and
 * 100 (100 is the unmasked baseline: no vignette). Prints `SCOPE-FEATHER inside_f0=<%> inside_f40=<%> inside_f100=<%>
 * outside_f0=<%> near_default=<%> far_default=<%> outside_f100=<%> default=<n>`.
 */
async function featherChecks(page: Page, pane: Rect, stage: Rect): Promise<boolean> {
  const c = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2, r: stage.width / 2 };
  const initial = await lookState(page);
  const def = initial.scope.feather;
  const rings: [number, number][] = [
    [0, 0.9],
    [1.1, 1.2],
    [1.5, 99],
    [1.05, 99],
  ];
  await setFeatherPct(page, 100);
  const off = await shot(page, "feather-100");
  const f100 = await ringRatios(page, await shot(page), off, c, pane, rings);
  await setFeatherPct(page, 0);
  const f0 = await ringRatios(page, await shot(page, "feather-0"), off, c, pane, rings);
  await setFeatherPct(page, 70);
  await shot(page, "feather-70");
  await setFeatherPct(page, def);
  const fd = await ringRatios(page, await shot(page, "feather-default"), off, c, pane, rings);
  console.log(
    `SCOPE-FEATHER inside_f0=${pct(f0[0]!)} inside_f40=${pct(fd[0]!)} inside_f100=${pct(f100[0]!)} outside_f0=${pct(f0[3]!)} near_default=${pct(fd[1]!)} far_default=${pct(fd[2]!)} outside_f100=${pct(f100[3]!)} default=${def}`,
  );
  return (
    f0[0]! >= 99 && fd[0]! >= 99 && f100[0]! >= 99 && f0[3]! <= 2 && fd[1]! >= 60 && fd[1]! <= 95 && fd[2]! >= 5 && fd[2]! <= 60 && fd[2]! < fd[1]! && f100[3]! >= 97 && def >= 30 && def <= 50
  );
}

/**
 * GE11 G3: oval, rounded and frame at size 70 and the default soft edge: fully visible inside, and the fade runs outward
 * from each shape's own edge (measured along the horizontal and the vertical through the centre). `SCOPE-SHAPES oval=ok
 * rounded=ok frame=ok`; also the four shapes' areas at soft edge 0 (`SCOPE-SHAPE`, as GE9).
 */
async function shapeChecks(page: Page, pane: Rect): Promise<boolean> {
  const verdict: Record<string, boolean> = {};
  const def = (await lookState(page)).scope.feather;
  await setFeatherPct(page, 100);
  await setShape(page, "circle");
  await setSizePct(page, 100);
  const off = await shot(page);

  // The four shapes' areas at a hard edge, and size 50 about a quarter of size 100.
  await setFeatherPct(page, 0);
  const areas: Record<string, WindowArea> = {};
  for (const shape of ["circle", "oval", "rounded", "frame"]) {
    await setShape(page, shape);
    areas[shape] = await windowArea(page, await shot(page, `shape-${shape}`), off);
  }
  await setShape(page, "circle");
  await setSizePct(page, 50);
  const half = await windowArea(page, await shot(page, "shape-circle-size50"), off);
  await setSizePct(page, 100);
  const cx = pane.x + pane.width / 2;
  const cy = pane.y + pane.height / 2;
  const centred = Object.values({ ...areas, size50: half }).every((a) => Math.abs(a.cx - cx) <= 3 && Math.abs(a.cy - cy) <= 3);
  const ratio = half.area / areas.circle!.area;
  const distinct = new Set(Object.values(areas).map((a) => Math.round(a.area / 1000))).size === 4;
  console.log(
    `SCOPE-SHAPE circle=${areas.circle!.area} oval=${areas.oval!.area} rounded=${areas.rounded!.area} frame=${areas.frame!.area} size50_over_size100=${ratio.toFixed(2)} centred=${centred ? 1 : 0}`,
  );

  // The fade outside each shape at the default soft edge.
  await setFeatherPct(page, def);
  await setSizePct(page, 70);
  for (const shape of ["oval", "rounded", "frame"]) {
    await setShape(page, shape);
    const png = await shot(page, `shape-${shape}-default`);
    const st = await rectOf(page, "[data-stage]");
    const hw = st.width / 2;
    const hh = st.height / 2;
    const w = (def / 100) * Math.min(hw, hh);
    const sx = st.x + hw;
    const sy = st.y + hh;
    const pts = [
      { x: sx + 0.9 * hw, y: sy },
      { x: sx + hw + 0.3 * w, y: sy },
      { x: sx + hw + 1.1 * w, y: sy },
      { x: sx, y: sy - 0.9 * hh },
      { x: sx, y: sy - hh - 0.3 * w },
      { x: sx, y: sy - hh - 1.1 * w },
    ];
    const v = await pointRatios(page, png, off, pts);
    const fadeX = v[0]! >= 97 && v[1]! < v[0]! - 1 && v[2]! < v[1]! - 3 && v[2]! >= 0;
    const fadeY = v[3]! >= 97 && v[4]! < v[3]! - 1 && v[5]! < v[4]! - 3 && v[5]! >= 0;
    log(`${shape} size 70: along x ${v.slice(0, 3).map((n) => n.toFixed(0)).join(" > ")}, along y ${v.slice(3).map((n) => n.toFixed(0)).join(" > ")}`);
    verdict[shape] = fadeX && fadeY;
  }
  await setSizePct(page, 100);
  await setShape(page, "circle");
  console.log(`SCOPE-SHAPES oval=${verdict.oval ? "ok" : "no"} rounded=${verdict.rounded ? "ok" : "no"} frame=${verdict.frame ? "ok" : "no"}`);
  return distinct && ratio >= 0.2 && ratio <= 0.3 && centred && Object.values(verdict).every(Boolean);
}

/**
 * GE11 G4: where the map is visible outside the circle it is interactive: nothing clips the pointer to the circle, the globe
 * can be dragged from there, and a sighting marker drawn in the fade can be clicked. `SCOPE-INPUT outside_marker_click=ok
 * drag=ok`.
 */
async function inputChecks(page: Page, pane: Rect, stage: Rect, list: { id: string; lat: number; lon: number }[]): Promise<boolean> {
  await setShape(page, "circle");
  await setSizePct(page, 100);
  await setFeatherPct(page, (await lookState(page)).scope.feather);
  await closePopover(page);
  const cx = stage.x + stage.width / 2;
  const cy = stage.y + stage.height / 2;
  const reach = Math.min(1.15 * (stage.width / 2), pane.x + pane.width - cx - 20);
  const probe = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x!, y!);
      const canvas = document.querySelector("[data-globe] canvas");
      return { inGlobe: !!el?.closest('[data-slot="globe"]'), clip: canvas ? getComputedStyle(canvas).clipPath : "?" };
    },
    [cx + reach, cy],
  );
  // Where a fixed place is on screen before and after a drag that starts outside the circle.
  const anchor = { lon: -80.95, lat: 25.05 };
  const where = () => page.evaluate(([lo, la]) => window.__inversa!.project(lo!, la!), [anchor.lon, anchor.lat]);
  const before = await where();
  await page.mouse.move(cx + reach, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + reach - i * 15, cy, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await where();
  const drag = !!before && !!after && Math.hypot(after.x - before.x, after.y - before.y) > 20;
  log(`drag from outside the circle moved the map ${before && after ? Math.round(Math.hypot(after.x - before.x, after.y - before.y)) : "?"} px`);

  // A marker in the fade: fly so a python sighting sits 1.15 radii right of the centre, then click it.
  const vp = page.viewportSize()!;
  const altitudeM = 4_000;
  const mpp = (altitudeM * 2 * Math.tan(Math.PI / 6)) / Math.max(vp.width, vp.height);
  const dx = 1.15 * (stage.width / 2);
  let marker = false;
  for (const sg of list.slice(0, 12)) {
    await flyTo(page, sg.lat, sg.lon - (dx * mpp) / (M_PER_DEG * Math.cos((sg.lat * Math.PI) / 180)), altitudeM);
    const pt = await page.evaluate(([lo, la]) => window.__inversa!.project(lo!, la!), [sg.lon, sg.lat]);
    if (!pt) continue;
    if ((await page.evaluate(([x, y]) => window.__inversa!.pick(x!, y!), [pt.x, pt.y])) !== `sighting:${sg.id}`) continue;
    log(`marker sighting:${sg.id} at x=${Math.round(pt.x)} (${((pt.x - cx) / (stage.width / 2)).toFixed(2)} radii right of the centre)`);
    await page.mouse.click(pt.x, pt.y);
    marker = await page
      .locator(DRAWER)
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    break;
  }
  log(`outside the circle: element under the pointer in the globe ${probe.inGlobe}, canvas clip-path ${probe.clip}`);
  console.log(`SCOPE-INPUT outside_marker_click=${marker ? "ok" : "no"} drag=${drag && probe.inGlobe && probe.clip === "none" ? "ok" : "no"}`);
  return marker && drag && probe.inGlobe && probe.clip === "none";
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
    if (initial.target !== "normal" || initial.scope.feather !== 40 || initial.scope.shape !== "circle" || initial.scope.size !== 100) fail(`initial look ${JSON.stringify(initial)}; want normal, a circle at size 100 and soft edge 40`);

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

    // ---- 3. the map window (GE11): always there; the soft edge fades outside it -----------------------------------
    await pick(page, "normal");
    await closePopover(page);
    if (!(await featherChecks(page, pane, stage))) failed = true;
    if (!(await shapeChecks(page, pane))) failed = true;
    const atMs = Date.parse("2026-09-09T20:00:00.000Z");
    const found = await stack.graphql<{ sightings: { id: string; lat: number; lon: number; canonicalId: string | null }[] }>(
      "query($bbox: BBox!, $from: Time!, $to: Time!, $taxa: [ID!]) { sightings(bbox: $bbox, from: $from, to: $to, taxa: $taxa) { id lat lon canonicalId } }",
      { bbox: { west: -83.2, south: 24.3, east: -79.8, north: 27.5 }, from: new Date(atMs - 168 * 3_600_000 + 3_600_000).toISOString(), to: new Date(atMs).toISOString(), taxa: [PYTHON_TAXON] },
    );
    if (!(await inputChecks(page, pane, stage, found.sightings.filter((x) => x.canonicalId === null)))) failed = true;

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
    await setFeatherPct(page, 60);
    // GE9: a shape and a size ride along.
    await page.locator(SHAPE("rounded")).click();
    await page.locator(SIZE).focus();
    await page.keyboard.press("Home");
    for (let s = 30; s < 70; s += 5) await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => /look=flir/.test(location.hash) && !/scope=/.test(location.hash) && /feather=60/.test(location.hash) && /shape=rounded/.test(location.hash) && /size=70/.test(location.hash),
      undefined,
      { timeout: 10_000 },
    );
    const hash = await page.evaluate(() => location.hash);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__look) && window.__look!.state().shown === "flir", undefined, { timeout: LOAD_TIMEOUT_MS });
    const restored = await lookState(page);
    const link = restored.target === "flir" && restored.scope.feather === 60 && restored.scope.shape === "rounded" && restored.scope.size === 70;
    log(`share link ${hash.replace(/^#/, "").split("&").filter((f) => /^(look|scope|shape|size|feather)=/.test(f)).join("&")} → reopened as ${restored.target}, shape ${restored.scope.shape}, size ${restored.scope.size}, feather ${restored.scope.feather}`);
    console.log(`LOOK link=${link ? "ok" : "fail"}`);
    if (!link) failed = true;

    // ---- 6. frame cost ------------------------------------------------------------------------------------
    await page.waitForFunction((id) => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.breakdown?.[id] ?? 0) > 0, PYTHON_TAXON, { timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(4_000);
    await page.locator(BUTTON).click();
    await page.locator(POPOVER).waitFor({ timeout: 10_000 });
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

    // GE9 evidence: the four shapes at 1440×900 with the Look popover open top right (docs/evidence/ge9-shape-*.png).
    const wide = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await wide.clock.install({ time: new Date(FIXTURE_CLOCK) });
    for (const [name, extra] of [
      ["circle", ""],
      ["oval", "&shape=oval"],
      ["rounded-70", "&shape=rounded&size=70"],
      ["frame", "&shape=frame"],
    ] as const) {
      const shots = await wide.newPage();
      await shots.goto(`${stack.origin}/?app=python${LINK}${extra}`, { waitUntil: "load" });
      await shots.waitForFunction(() => Boolean(window.__look) && window.__inversa?.globe() !== null, undefined, { timeout: LOAD_TIMEOUT_MS });
      await shots.waitForTimeout(5_000);
      await shots.locator(BUTTON).click();
      await shots.locator(POPOVER).waitFor({ timeout: 10_000 });
      await shots.waitForTimeout(400);
      await shots.screenshot({ path: path.join(SHOT_DIR, `ge9-shape-${name}-1440.png`) });
      log(`screenshot ge9-shape-${name}-1440.png (${JSON.stringify((await lookState(shots)).scope)})`);
      await shots.close();
    }
    await wide.close();
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
