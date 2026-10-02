/**
 * Zoom (gates/leaf-GE8.md G2-G5, G7) on the real stack (e2e/stack.ts: Axum over the python fixtures, the production
 * e2e build, the Caddy-like proxy). Every number is measured from the camera's real altitude, read each animation
 * frame through `window.__inversa.globe().zoom` while the script drives the page with the mouse, keyboard and
 * touch; nothing is driven through the debug hook.
 *
 *   bun run e2e:zoom                  build (when the e2e build is older than the sources), run, print the lines
 *   bun run e2e:zoom -- --live        also over Google 3D with the real browser keys (run under Doppler:
 *                                     `doppler run --project inversa --config dev -- bun run e2e:zoom -- --live`);
 *                                     the keys go into the page's localStorage for the run only, never printed,
 *                                     never written to a file. Opens a few billed Google 3D sessions.
 *
 * Without `--live` the page has no browser keys (route `keyless`, flat imagery): the 3D limit and the tilt are
 * covered by the unit tests with a stubbed route, and the tilt line reports the flat route staying top down.
 *
 * Lines:
 *   ZOOM controls buttons=ok slider=ok keys=ok reset=ok fit=ok overlap=0 mobile=ok
 *   ZOOMSTRIP placed=ok gap=12 right=12 bottom=12 leftmost_track=1 height_le_bar=1 apps=python,carp,lionfish   (GE10)
 *   ZOOMSTRIP icon_stops=7 click_stop=ok drag=ok
 *   ZOOM motion step_ms=<n> end_err_pct=<n> wheel_pct=<n> dblclick_px=<n>
 *   ZOOM limits min_3d_m=<n> min_flat_m=<n> max_km=<n> underground=0 3d=<measured|config>
 *   ZOOM tilt route=<route> tilt_deg=<n> hint=<0|1>
 *   ZOOM touch pinch_ratio=<n> collapsed=1 overlap=0
 *   ZOOM idle=ok requests_delta=0
 * Screenshots (docs/evidence/): zoom-region.png, zoom-controls.png, zoom-card-1024.png (sighting card open),
 * zoom-city.png (Miami at street scale), zoom-mobile.png, and with --live zoom-city-3d.png.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { getApp } from "../shared/apps";
import { browserKeyStorageKey } from "../shared/keys";
import { APP_DIR, buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const APP = "python" as const;
const LIVE = process.argv.includes("--live");
const EVIDENCE = path.join(REPO_DIR, "docs/evidence");
const LOAD_TIMEOUT_MS = 120_000;
/** Miami (inside the Google 3D zone) and the Everglades interior (outside it, flat imagery). */
const MIAMI = { lat: 25.7743, lon: -80.1937 };
const EVERGLADES = { lat: 25.62, lon: -80.85 };

/**
 * The browser keys, taken out of the environment before anything is built or started: a build would bake
 * `NEXT_PUBLIC_*` values into its output files. With --live they reach the page through localStorage only.
 */
const BROWSER_KEY_VARS = ["NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_API_KEY", "NEXT_PUBLIC_CESIUM_ION_TOKEN"] as const;
const liveKeys: Record<(typeof BROWSER_KEY_VARS)[number], string> = Object.fromEntries(BROWSER_KEY_VARS.map((name) => [name, LIVE ? (process.env[name] ?? "") : ""])) as Record<(typeof BROWSER_KEY_VARS)[number], string>;
for (const name of BROWSER_KEY_VARS) delete process.env[name];

const log = (...a: unknown[]) => console.error("[e2e:zoom]", ...a);
const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) {
    fails.push(what);
    log(`FAIL ${what}`);
  }
  return ok;
};
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// ---- build freshness ----------------------------------------------------------------------------------------

/** Reuse the e2e build when it is newer than every source file the page is built from. */
function buildIsFresh(): boolean {
  const marker = path.join(APP_DIR, ".next/standalone/apps/web/.e2e-build");
  if (!existsSync(marker)) return false;
  const built = statSync(marker).mtimeMs;
  for (const dir of ["app", "client", "shared", "public"]) {
    for (const file of new Bun.Glob("**/*").scanSync({ cwd: path.join(APP_DIR, dir), onlyFiles: true })) {
      if (statSync(path.join(APP_DIR, dir, file)).mtimeMs > built) return false;
    }
  }
  return true;
}

// ---- page helpers -------------------------------------------------------------------------------------------

type Zoom = { altitudeM: number; clearanceM: number | null; groundM: number | null; minM: number; maxM: number; route: string; google3d: string; threeD: boolean; pitchDeg: number; animating: boolean; lifts: number };
type Rec = { t0: number | null; samples: [number, number, number | null, number][] };

const zoomState = (page: Page) => page.evaluate(() => (window.__inversa!.globe() as unknown as { zoom: Zoom }).zoom);

/** In-page recorder: the camera's altitude, clearance and pitch every animation frame, and the first input's time. */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __zoomRec?: unknown };
    if (w.__zoomRec) return;
    const z = () => (window.__inversa!.globe() as unknown as { zoom: Zoom }).zoom;
    let rec: (Rec & { raf: number }) | null = null;
    const onInput = () => {
      if (rec && rec.t0 === null) rec.t0 = performance.now();
    };
    for (const type of ["pointerdown", "keydown", "wheel", "dblclick", "touchstart"]) document.addEventListener(type, onInput, true);
    w.__zoomRec = {
      start() {
        rec = { t0: null, samples: [], raf: 0 };
        const tick = () => {
          if (!rec) return;
          const s = z();
          rec.samples.push([performance.now(), s.altitudeM, s.clearanceM, s.pitchDeg]);
          rec.raf = requestAnimationFrame(tick);
        };
        tick();
      },
      idleFor() {
        if (!rec || rec.samples.length < 2) return 0;
        const s = rec.samples;
        let last = s[0]![0];
        for (let i = 1; i < s.length; i += 1) if (Math.abs(s[i]![1] - s[i - 1]![1]) > 1e-6 * s[i - 1]![1] || Math.abs(s[i]![3] - s[i - 1]![3]) > 1e-4) last = s[i]![0];
        return performance.now() - last;
      },
      stop() {
        if (!rec) return null;
        cancelAnimationFrame(rec.raf);
        const out = { t0: rec.t0, samples: rec.samples };
        rec = null;
        return out;
      },
    };
  });
}

type Motion = { a0: number; a1: number; ms: number; t0: number; samples: Rec["samples"]; minClearance: number };

/** Record while `act` runs, until the camera has rested `restMs` (and nothing animates). */
async function recorded(page: Page, act: () => Promise<void>, restMs = 600, timeoutMs = 20_000): Promise<Motion> {
  await page.evaluate(() => (window as unknown as { __zoomRec: { start(): void } }).__zoomRec.start());
  await act();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.waitForTimeout(100);
    const [idle, animating] = await page.evaluate(() => [(window as unknown as { __zoomRec: { idleFor(): number } }).__zoomRec.idleFor(), (window.__inversa!.globe() as unknown as { zoom: Zoom }).zoom.animating] as const);
    if (idle >= restMs && !animating) break;
    if (Date.now() > deadline) {
      log("recorder: camera never rested");
      break;
    }
  }
  const rec = (await page.evaluate(() => (window as unknown as { __zoomRec: { stop(): Rec | null } }).__zoomRec.stop()))!;
  const s = rec.samples;
  let lastChange = s[0]![0];
  for (let i = 1; i < s.length; i += 1) if (Math.abs(s[i]![1] - s[i - 1]![1]) > 1e-6 * s[i - 1]![1]) lastChange = s[i]![0];
  const firstChange = s.find((x, i) => i > 0 && Math.abs(x[1] - s[i - 1]![1]) > 1e-6 * s[i - 1]![1]);
  const t0 = rec.t0 ?? firstChange?.[0] ?? s[0]![0];
  const clear = s.map((x) => x[2]).filter((c): c is number => c !== null);
  return { a0: s[0]![1], a1: s.at(-1)![1], ms: Math.max(0, lastChange - t0), t0, samples: s, minClearance: clear.length ? Math.min(...clear) : Number.NaN };
}

/** Fly through a share link (the same path an opened link takes), then wait for the camera to rest. */
async function goTo(page: Page, at: { lat: number; lon: number }, altitudeM: number, extra = ""): Promise<void> {
  await recorded(
    page,
    () =>
      page.evaluate(
        (h) => {
          window.location.hash = h;
        },
        `v=2&app=${APP}&c=${at.lat},${at.lon},${altitudeM},0,-90${extra}`,
      ),
    800,
  );
}

async function openApp(browser: Browser, stack: Stack, viewport: { width: number; height: number }, mobile = false, hash = ""): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  if (LIVE) {
    const keys = {
      [browserKeyStorageKey("google-maps")]: liveKeys.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || liveKeys.GOOGLE_MAPS_API_KEY,
      [browserKeyStorageKey("cesium-ion")]: liveKeys.NEXT_PUBLIC_CESIUM_ION_TOKEN,
    };
    await context.addInitScript((k) => {
      for (const [name, value] of Object.entries(k)) if (value) localStorage.setItem(name, value);
    }, keys);
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${stack.origin}/?app=${APP}${hash ? `#${hash}` : ""}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-testid=hud-topbar]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.globe() as unknown as { zoom?: Zoom } | null)?.zoom != null, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.locator("[data-testid=zoom-controls]").waitFor({ timeout: 30_000 });
  await installRecorder(page);
  return { page, context, errors };
}

type Box = { left: number; top: number; right: number; bottom: number };
const boxOf = (r: { x: number; y: number; width: number; height: number }): Box => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
type Placement = { name: string; gap: number; right: number; bottom: number; trackLeftmost: boolean; heightLeBar: boolean; stops: number };

/**
 * GE10: the strip sits in the timeline's row at its right end: its left edge `--gap-m` from the timeline's right edge
 * (the timeline gives it room), its right and bottom edges `--gap-m` from the pane, the drag track its leftmost element,
 * and no taller than the timeline's bar. Measured on the page.
 */
async function stripPlacement(page: Page, name: string): Promise<Placement> {
  const m = await page.evaluate(() => {
    const q = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
    const strip = q("[data-testid=zoom-controls]")!;
    const bar = q("[data-testid=hud-timeline], [data-testid=carp-timeline]")!;
    const track = q("[data-testid=zoom-slider]")!;
    const lefts = [...document.querySelectorAll("[data-testid=zoom-controls] button")].map((b) => b.getBoundingClientRect().left);
    return {
      gap: strip.left - bar.right,
      right: innerWidth - strip.right,
      bottom: innerHeight - strip.bottom,
      trackLeftmost: track.left <= Math.min(...lefts) + 0.5,
      heightLeBar: strip.height <= bar.height + 0.5,
      stops: document.querySelectorAll("[data-testid=zoom-stop]").length,
    };
  });
  return { name, ...m };
}
const placementOk = (p: Placement) => Math.abs(p.gap - 12) <= 0.5 && Math.abs(p.right - 12) <= 0.5 && Math.abs(p.bottom - 12) <= 0.5 && p.trackLeftmost && p.heightLeBar && p.stops === 7;

const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

/** Rects of the controls and of what they must keep clear of; overlapping pairs by name. */
async function overlapsAt(page: Page, label: string): Promise<string[]> {
  const rects = await page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const named = (sel: string) => [...document.querySelectorAll(sel)].map((el) => ({ sel, r: rect(el) })).filter((x) => x.r);
    return {
      zoom: [...named("[data-testid=zoom-controls]"), ...named("[data-testid=zoom-hint]")],
      obstacles: [
        ...named("[data-slot=side] > *"),
        ...named("[data-testid=hud-drawer]"),
        ...named("[data-testid=bottom-bar] > *"),
        ...named("[data-testid=look-bar] > *"),
        ...named("[data-testid=hud-timeline]"),
        ...named("[data-testid=hud-topbar]"),
        // Every other card the HUD marks (the species chip, an app's own panels and banners).
        ...[...document.querySelectorAll("[data-hud-obstacle]")].filter((el) => !el.closest("[data-testid=zoom-controls]")).map((el) => ({ sel: `[data-hud-obstacle] ${el.getAttribute("data-testid") ?? el.tagName.toLowerCase()}`, r: rect(el) })).filter((x) => x.r),
      ],
    };
  });
  const out: string[] = [];
  const fmt = (b: Box) => `${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)}`;
  for (const z of rects.zoom) for (const o of rects.obstacles) if (overlaps(boxOf(z.r!), boxOf(o.r!))) out.push(`${label}: ${z.sel} ${fmt(boxOf(z.r!))} × ${o.sel} ${fmt(boxOf(o.r!))}`);
  return out;
}

/** A fixture sighting (id, time) of the app; the API caps a window at 31 days, so walk back a month at a time. */
async function aSighting(stack: Stack): Promise<{ id: string; observedAt: string }> {
  const MONTH = 30 * 86_400_000;
  for (let to = Date.now(), i = 0; i < 24; i++, to -= MONTH) {
    const res = await stack.graphql<{ sightings: { id: string; observedAt: string }[] }>("query($b: BBox!, $f: Time!, $t: Time!) { sightings(bbox: $b, from: $f, to: $t) { id observedAt } }", {
      b: getApp(APP).regions[0]!.bbox,
      f: new Date(to - MONTH).toISOString(),
      t: new Date(to).toISOString(),
    });
    if (res.sightings[0]) return res.sightings[0];
  }
  throw new Error("no fixture sighting");
}

/** The sightings the map shows: the trailing window at the time cursor, through the debug hook's frame reader. */
async function visibleSightings(page: Page): Promise<{ lon: number; lat: number }[]> {
  return page.evaluate(() => {
    const dbg = window.__inversa!;
    const meta = dbg.snapshot().meta;
    const time = dbg.state("TIME") as { at: string };
    const layers = dbg.state("LAYERS") as { sightingHours?: number; species?: Record<string, boolean> } | undefined;
    if (!meta) return [];
    const step = meta.stepMinutes * 60_000;
    const at = Date.parse(time.at);
    const frames = Math.max(1, Math.ceil(((layers?.sightingHours ?? 168) * 3_600_000) / step));
    const seen = new Map<number, { lon: number; lat: number }>();
    for (let i = 0; i < frames; i += 1) for (const r of dbg.sightingRecords(new Date(at - i * step).toISOString())) seen.set(r.id, { lon: r.lon, lat: r.lat });
    return [...seen.values()];
  });
}

/** Centre of the globe canvas, page px. */
const centreOf = async (page: Page) => {
  const r = boxOf(
    await page.evaluate(() => {
      const b = (document.querySelector("[data-globe] canvas") ?? document.querySelector("canvas")!).getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }),
  );
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
};

// ---- main ---------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  if (LIVE && !liveKeys.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY && !liveKeys.GOOGLE_MAPS_API_KEY) throw new Error("--live needs the Google Maps browser key in the environment (run under doppler)");
  buildApi(log);
  // Freshness decides, whatever E2E_SKIP_BUILD the caller passed (a stale build would test old code).
  process.env.E2E_SKIP_BUILD = buildIsFresh() ? "1" : "";
  buildWeb(log);
  const stack = await startStack({ name: "zoom", app: APP });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  mkdirSync(EVIDENCE, { recursive: true });
  try {
    const sighting = await aSighting(stack);
    const at = new Date(Date.parse(sighting.observedAt) + 3_600_000).toISOString();
    const { page, context, errors } = await openApp(browser, stack, { width: 1440, height: 900 }, false, `v=2&app=${APP}&t=${at}`);
    await page.waitForFunction(() => (window.__inversa!.globe()?.layers.find((l) => l.id === "sightings")?.count ?? 0) > 0, undefined, { timeout: 60_000 }).catch(() => log("no sightings drawn at the link's time"));
    await page.waitForTimeout(1500);
    const start = await zoomState(page);
    log(`start: ${round(start.altitudeM / 1000)} km, route ${start.route}, limits ${start.minM}..${start.maxM} m`);
    await page.screenshot({ path: path.join(EVIDENCE, "zoom-region.png") });
    const controls = page.locator("[data-testid=zoom-controls]");
    await controls.screenshot({ path: path.join(EVIDENCE, "zoom-controls.png") });

    // ---- G2 controls -------------------------------------------------------------------------------------
    const names = await page.evaluate(() => ["zoom-in", "zoom-out", "zoom-reset", "zoom-fit"].map((id) => document.querySelector(`[data-testid=${id}]`)?.getAttribute("aria-label") ?? ""));
    let buttons = check(names.every(Boolean), `button names ${JSON.stringify(names)}`);
    const plus = await recorded(page, () => page.locator("[data-testid=zoom-in]").click());
    buttons = check(Math.abs(plus.a1 / plus.a0 - 0.5) < 0.015, `+ button ratio ${round(plus.a1 / plus.a0, 3)}`) && buttons;
    const minus = await recorded(page, () => page.locator("[data-testid=zoom-out]").click());
    buttons = check(Math.abs(minus.a1 / minus.a0 - 2) < 0.03, `- button ratio ${round(minus.a1 / minus.a0, 3)}`) && buttons;

    const slider = page.locator("[data-testid=zoom-slider]");
    const valueText = (await slider.getAttribute("aria-valuetext")) ?? "";
    let sliderOk = check(/^(World|Country|State or region|County|City|Neighbourhood|Street), [\d,.]+ (m|km) up$/.test(valueText), `slider valuetext "${valueText}"`);
    sliderOk = check((await slider.getAttribute("aria-orientation")) === "horizontal" && (await slider.getAttribute("role")) === "slider", "slider role/orientation") && sliderOk;
    // A click three quarters of the way along the track (far on the left, near on the right) goes to that altitude (log scale).
    const track = boxOf((await slider.boundingBox())!);
    const clickX = track.left + 7 + (track.right - track.left - 14) * 0.75;
    const clickY = (track.top + track.bottom) / 2;
    const z0 = await zoomState(page);
    const want = z0.maxM * (z0.minM / z0.maxM) ** 0.75;
    const sliderMove = await recorded(page, () => page.mouse.click(clickX, clickY));
    sliderOk = check(Math.abs(sliderMove.a1 / want - 1) < 0.03, `slider click ${round(sliderMove.a1)} m, want ${round(want)} m`) && sliderOk;
    // A drag moves continuously: to the left zooms out.
    const dragFrom = await zoomState(page);
    await recorded(page, async () => {
      await page.mouse.move(clickX, clickY);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) await page.mouse.move(clickX - i * 6, clickY);
      await page.mouse.up();
    });
    const dragOk = check((await zoomState(page)).altitudeM > dragFrom.altitudeM * 1.5, "slider drag left zooms out");
    sliderOk = dragOk && sliderOk;
    const valueNow = Number(await slider.getAttribute("aria-valuenow"));
    sliderOk = check(Number.isFinite(valueNow) && valueNow >= 0 && valueNow <= 100, `aria-valuenow ${valueNow}`) && sliderOk;

    // GE10: the strip's placement on python, and the seven icon stops: a click on one flies to that scale.
    const placements: Placement[] = [await stripPlacement(page, "python 1440")];
    await goTo(page, EVERGLADES, 60_000);
    const cityStop = page.locator("[data-testid=zoom-stop][data-scale=City]");
    const stopCount = await page.locator("[data-testid=zoom-stop]").count();
    const stopMove = await recorded(page, () => cityStop.click());
    const stopOk = check(stopCount === 7 && stopMove.a1 > 8_000 && stopMove.a1 < 60_000, `City icon: ${stopCount} stops, altitude after the click ${round(stopMove.a1)} m (City is 8 to 60 km)`);
    const noWords = check(
      (await page.evaluate(() => [...document.querySelectorAll("[data-testid=zoom-stop]")].every((b) => (b.textContent ?? "").trim() === "" && !!b.getAttribute("aria-label") && !!b.getAttribute("title")))) === true,
      "icon stops carry no visible words, only a name and a tooltip",
    );

    // Keys: + and - anywhere outside a field, arrows on the slider, Home resets.
    await goTo(page, EVERGLADES, 60_000);
    await page.locator("body").focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const keyPlus = await recorded(page, () => page.keyboard.press("+"));
    let keys = check(Math.abs(keyPlus.a1 / keyPlus.a0 - 0.5) < 0.015, `+ key ratio ${round(keyPlus.a1 / keyPlus.a0, 3)}`);
    const keyMinus = await recorded(page, () => page.keyboard.press("-"));
    keys = check(Math.abs(keyMinus.a1 / keyMinus.a0 - 2) < 0.03, `- key ratio ${round(keyMinus.a1 / keyMinus.a0, 3)}`) && keys;
    await slider.focus();
    const up = await recorded(page, () => page.keyboard.press("ArrowUp"));
    keys = check(Math.abs(up.a1 / up.a0 - 0.5) < 0.015, `ArrowUp ratio ${round(up.a1 / up.a0, 3)}`) && keys;
    const down = await recorded(page, () => page.keyboard.press("ArrowDown"));
    keys = check(Math.abs(down.a1 / down.a0 - 2) < 0.03, `ArrowDown ratio ${round(down.a1 / down.a0, 3)}`) && keys;
    // Typing + in the chat box types, it does not zoom.
    const composer = page.locator("textarea").first();
    if (await composer.count()) {
      const before = (await zoomState(page)).altitudeM;
      await composer.focus();
      await page.keyboard.press("+");
      await page.waitForTimeout(500);
      keys = check(Math.abs((await zoomState(page)).altitudeM / before - 1) < 0.001, "+ typed in the composer zoomed") && keys;
      await composer.fill("");
    }
    const preset = (await page.evaluate(() => window.__inversa!.state("VIEW"))) as { seq: number };
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await recorded(page, () => page.keyboard.press("Home"), 800);
    const afterHome = (await page.evaluate(() => window.__inversa!.state("VIEW"))) as { seq: number; altitudeM: number };
    keys = check(afterHome.seq > preset.seq, "Home did not reset") && keys;

    // Reset view: back to the app's preset (VIEW's own default altitude) from anywhere.
    await goTo(page, MIAMI, 3_000);
    await recorded(page, () => page.locator("[data-testid=zoom-reset]").click(), 800);
    const presetView = (await page.evaluate(() => window.__inversa!.state("VIEW"))) as { lat: number; lon: number; altitudeM: number };
    const afterReset = await zoomState(page);
    const reset = check(Math.abs(afterReset.altitudeM / presetView.altitudeM - 1) < 0.03, `reset altitude ${round(afterReset.altitudeM)} vs preset ${presetView.altitudeM}`);

    // Fit sightings: every sighting the map shows lands on screen, clear of the cards.
    const shown = await visibleSightings(page);
    await goTo(page, MIAMI, 2_000);
    await recorded(page, () => page.locator("[data-testid=zoom-fit]").click(), 800);
    const canvas = await centreOf(page);
    const chatRight = await page.evaluate(() => document.querySelector("[data-slot=side]")?.getBoundingClientRect().right ?? 0);
    const projected = await page.evaluate((pts) => pts.map((p) => window.__inversa!.project(p.lon, p.lat)), shown);
    const inside = projected.filter((p) => p && p.x > chatRight && p.x < canvas.x * 2 && p.y > 0 && p.y < canvas.y * 2).length;
    const fit = check(shown.length > 0 && inside === shown.length, `fit: ${inside} of ${shown.length} sightings on screen`);
    log(`fit: ${inside}/${shown.length} visible sightings inside after Fit sightings`);

    // Overlap: closed and open sighting card at 1440×900 and 1024×768.
    const overlapList: string[] = [];
    overlapList.push(...(await overlapsAt(page, "1440 closed")));
    await page.evaluate((h) => (window.location.hash = h), `v=2&app=${APP}&t=${at}&e=sighting:${sighting.id}`);
    await page.locator("[data-testid=hud-drawer]").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    overlapList.push(...(await overlapsAt(page, "1440 open")));
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(800);
    overlapList.push(...(await overlapsAt(page, "1024 open")));
    await page.screenshot({ path: path.join(EVIDENCE, "zoom-card-1024.png") });
    await page.locator('[data-testid=hud-drawer] button[title="Clear selection"]').click();
    await page.locator("[data-testid=hud-drawer]").waitFor({ state: "detached", timeout: 10_000 }).catch(() => check(false, "the sighting card did not close"));
    await page.waitForTimeout(600);
    overlapList.push(...(await overlapsAt(page, "1024 closed")));
    for (const o of overlapList) log(`overlap ${o}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(600);

    // ---- G3 motion ---------------------------------------------------------------------------------------
    await goTo(page, EVERGLADES, 80_000);
    const step = await recorded(page, () => page.locator("[data-testid=zoom-in]").click());
    const endErr = (Math.abs(step.a1 - step.a0 * 0.5) / (step.a0 * 0.5)) * 100;
    // Eased: a quarter of the way through the time, well under a quarter of the way (in zoom ratio).
    const progress = (s: Rec["samples"][number]) => Math.log(step.a0 / s[1]) / Math.log(step.a0 / step.a1);
    const quarter = step.samples.filter((s) => s[0] <= step.t0 + step.ms * 0.25).at(-1);
    check(quarter !== undefined && progress(quarter) < 0.2, `step not eased: ${quarter ? round(progress(quarter), 2) : "?"} done at a quarter of the time`);
    const frames = step.samples.filter((s) => s[0] >= step.t0 && s[0] <= step.t0 + step.ms).length;
    log(`step: ${round(step.a0)} → ${round(step.a1)} m in ${round(step.ms)} ms over ${frames} frames, ${quarter ? round(progress(quarter) * 100) : "?"}% done at a quarter of the time`);

    const c = await centreOf(page);
    await page.mouse.move(c.x + 60, c.y + 40);
    const wheels: number[] = [];
    for (const alt of [80_000, 3_000_000, 2_000]) {
      await goTo(page, EVERGLADES, alt);
      await page.mouse.move(c.x + 60, c.y + 40);
      const w = await recorded(page, () => page.mouse.wheel(0, -100), 500);
      wheels.push(((w.a0 - w.a1) / w.a0) * 100);
      // No jump: no frame changes the altitude by more than the whole notch.
      const biggest = Math.max(...w.samples.slice(1).map((s, i) => Math.abs(Math.log(s[1] / w.samples[i]![1]))));
      check(biggest <= Math.log(1.26), `wheel at ${alt} m jumped ×${round(Math.exp(biggest), 3)} in one frame`);
    }
    log(`wheel notch at 80 km, 3,000 km, 2 km: ${wheels.map((w) => round(w)).join("%, ")}%`);
    const wheelOk = wheels.every((w) => w >= 10 && w <= 30);
    check(wheelOk, `wheel percentages ${wheels.join(",")}`);

    await goTo(page, EVERGLADES, 40_000);
    const target = { lon: EVERGLADES.lon + 0.06, lat: EVERGLADES.lat - 0.04 };
    const p0 = (await page.evaluate((t) => window.__inversa!.project(t.lon, t.lat), target))!;
    const dbl = await recorded(page, () => page.mouse.dblclick(p0.x, p0.y));
    const p1 = (await page.evaluate((t) => window.__inversa!.project(t.lon, t.lat), target))!;
    const dblPx = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    check(Math.abs(dbl.a1 / dbl.a0 - 0.5) < 0.05, `double click ratio ${round(dbl.a1 / dbl.a0, 3)}`);
    log(`double click at (${round(p0.x)}, ${round(p0.y)}): ${round(dbl.a0)} → ${round(dbl.a1)} m, the point moved ${round(dblPx, 2)} px`);
    console.log(`ZOOM motion step_ms=${Math.round(step.ms)} end_err_pct=${round(endErr, 2)} wheel_pct=${round(wheels[0]!)} dblclick_px=${round(dblPx, 1)}`);

    // ---- G4 limits ---------------------------------------------------------------------------------------
    let underground = 0;
    let minFlat = Number.POSITIVE_INFINITY;
    const watch = (m: Motion, minM: number) => {
      underground += m.samples.filter((s) => s[2] !== null && s[2] < minM - 1).length;
      if (Number.isFinite(m.minClearance)) minFlat = Math.min(minFlat, m.minClearance);
    };
    await goTo(page, EVERGLADES, 5_000);
    const flatState = await zoomState(page);
    check(!flatState.threeD && flatState.minM === 400, `flat limits ${flatState.minM} (route ${flatState.route}, google3d ${flatState.google3d})`);
    for (let i = 0; i < 6; i += 1) watch(await recorded(page, () => page.locator("[data-testid=zoom-in]").click(), 300), 400);
    await page.mouse.move(c.x, c.y);
    watch(await recorded(page, async () => {
      for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, -120);
    }, 500), 400);
    watch(await recorded(page, () => page.mouse.dblclick(c.x, c.y), 500), 400);
    // A link (or the agent) asking for 5 m lands at the limit.
    await page.evaluate((h) => (window.location.hash = h), `v=2&app=${APP}&c=${EVERGLADES.lat},${EVERGLADES.lon},5,0,-90`);
    await page.waitForTimeout(2500);
    const linked = await zoomState(page);
    watch({ a0: 0, a1: 0, ms: 0, t0: 0, samples: [[0, linked.altitudeM, linked.clearanceM, linked.pitchDeg]], minClearance: linked.clearanceM ?? Number.NaN }, 400);
    log(`flat: lowest clearance ${round(minFlat)} m (limit 400), a 5 m link landed at ${round(linked.altitudeM)} m, lifts ${linked.lifts}`);
    // Maximum: End on the slider, then more steps out.
    await slider.focus();
    await recorded(page, () => page.keyboard.press("End"), 500);
    for (let i = 0; i < 3; i += 1) await recorded(page, () => page.locator("[data-testid=zoom-out]").click(), 300);
    const top = await zoomState(page);
    const maxKm = top.altitudeM / 1000;
    check(maxKm <= 20_000.5 && maxKm >= 19_000, `max ${round(maxKm)} km`);
    const routeAttr = await page.evaluate(() => document.querySelector("[data-imagery-route]")?.getAttribute("data-imagery-route"));
    check(routeAttr === top.route, `limits route ${top.route} vs data-imagery-route ${routeAttr}`);

    // Over Google 3D (live only): the 30 m limit measured over Miami's tiles.
    let min3d = 30;
    let source = "config";
    let tiltRoute = top.route;
    let tiltDeg = 0;
    let hint = 0;
    await goTo(page, MIAMI, 8_000);
    if (LIVE) {
      await page.waitForFunction(() => document.querySelector("[data-google3d]")?.getAttribute("data-google3d") === "shown", undefined, { timeout: 60_000 }).catch(() => log("Google 3D never showed"));
      await page.waitForTimeout(4000);
    }
    const before3d = await zoomState(page);
    tiltRoute = before3d.route;
    for (let i = 0; i < 4; i += 1) await recorded(page, () => page.locator("[data-testid=zoom-in]").click(), 500);
    const tilted = await zoomState(page);
    tiltDeg = Math.round(90 + tilted.pitchDeg);
    hint = (await page.locator("[data-testid=zoom-hint]").count()) > 0 ? 1 : 0;
    log(`tilt: ${tilted.route} google3d=${tilted.google3d} at ${round(tilted.altitudeM)} m, pitch ${round(tilted.pitchDeg)}°, hint ${hint}`);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(EVIDENCE, "zoom-city.png") });
    if (LIVE && tilted.threeD) {
      await page.waitForTimeout(6000);
      await page.screenshot({ path: path.join(EVIDENCE, "zoom-city-3d.png") });
      for (let i = 0; i < 6; i += 1) {
        const m = await recorded(page, () => page.locator("[data-testid=zoom-in]").click(), 600);
        underground += m.samples.filter((s) => s[2] !== null && s[2] < 29).length;
      }
      await page.waitForTimeout(3000);
      const low = await zoomState(page);
      min3d = Math.round(low.clearanceM ?? low.altitudeM);
      source = "measured";
      log(`3D: lowest ${round(low.altitudeM)} m above the ellipsoid, ${round(low.clearanceM ?? Number.NaN)} m above the tiles (limit ${low.minM})`);
      check(low.minM === 30 && min3d >= 29, `3D clearance ${min3d}`);
    } else {
      check(tiltDeg === 0 && hint === 0, `flat route tilted ${tiltDeg}° or hinted`);
    }
    console.log(`ZOOM limits min_3d_m=${min3d} min_flat_m=${Math.round(minFlat)} max_km=${Math.round(maxKm)} underground=${underground} 3d=${source}`);
    console.log(`ZOOM tilt route=${tiltRoute} tilt_deg=${tiltDeg} hint=${hint}`);

    // ---- G7 idle ------------------------------------------------------------------------------------------
    await goTo(page, EVERGLADES, 60_000);
    await page.waitForTimeout(1500);
    const g0 = await page.evaluate(() => window.__inversa!.globe()!.governor);
    await page.waitForTimeout(3000);
    const g1 = await page.evaluate(() => window.__inversa!.globe()!.governor);
    const idle = g1.mode === "idle" && g1.holds.length === 0;
    check(idle && g1.requests === g0.requests, `idle: mode ${g1.mode} holds ${g1.holds.join(",")} requests +${g1.requests - g0.requests}`);
    console.log(`ZOOM idle=${idle ? "ok" : "fail"} requests_delta=${g1.requests - g0.requests}`);

    check(errors.length === 0, `page errors: ${errors.slice(0, 3).join(" | ")}`);
    await context.close();

    // ---- phone: +/- only, clear of the dock; pinch -----------------------------------------------------------
    const phone = await openApp(browser, stack, { width: 375, height: 812 }, true, `v=2&app=${APP}&c=${EVERGLADES.lat},${EVERGLADES.lon},60000,0,-90`);
    await phone.page.waitForTimeout(2000);
    const shownOnPhone = await phone.page.evaluate(() =>
      ["zoom-in", "zoom-out", "zoom-slider", "zoom-reset", "zoom-fit", "zoom-readout"].map((id) => {
        const el = document.querySelector(`[data-testid=${id}]`);
        return el ? el.getBoundingClientRect().width > 0 : false;
      }),
    );
    const collapsed = shownOnPhone[0] && shownOnPhone[1] && !shownOnPhone.slice(2).some(Boolean);
    check(collapsed, `phone controls ${JSON.stringify(shownOnPhone)}`);
    const phoneOverlap = await overlapsAt(phone.page, "375");
    for (const o of phoneOverlap) log(`overlap ${o}`);
    await phone.page.screenshot({ path: path.join(EVIDENCE, "zoom-mobile.png") });
    const pc = await centreOf(phone.page);
    const cdp = await phone.context.newCDPSession(phone.page);
    const pinch = await recorded(
      phone.page,
      async () => {
        const pts = (d: number) => [
          { x: pc.x - d, y: pc.y, id: 1 },
          { x: pc.x + d, y: pc.y, id: 2 },
        ];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(30) });
        for (let d = 36; d <= 90; d += 6) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      },
      600,
    );
    const pinchRatio = pinch.a0 / pinch.a1;
    check(Math.abs(pinchRatio - 3) < 0.3, `pinch ratio ${round(pinchRatio, 2)} (fingers ×3)`);
    console.log(`ZOOM touch pinch_ratio=${round(pinchRatio, 2)} collapsed=${collapsed ? 1 : 0} overlap=${phoneOverlap.length}`);
    check(phone.errors.length === 0, `phone page errors: ${phone.errors.slice(0, 3).join(" | ")}`);
    await phone.context.close();

    // The other apps' cards (carp's review board, Lionfish Watch's survey panel and banner): reported, not gated
    // (GE7 is moving those panels); the column takes the rightmost free slot, the +/- pair where none is wide enough.
    const appOverlaps: string[] = [];
    for (const app of ["carp", "lionfish"] as const) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
        const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
        const p = await ctx.newPage();
        await p.goto(`${stack.origin}/?app=${app}`, { waitUntil: "domcontentloaded" });
        await p.locator("[data-testid=zoom-controls]").waitFor({ timeout: LOAD_TIMEOUT_MS });
        await p.waitForTimeout(2500);
        const list = await overlapsAt(p, `${app} ${viewport.width}`);
        const placement = await stripPlacement(p, `${app} ${viewport.width}`);
        placements.push(placement);
        appOverlaps.push(`${app}_${viewport.width}=${list.length}`);
        for (const o of list) log(`app overlap ${o}`);
        await ctx.close();
      }
    }
    console.log(`ZOOM apps ${appOverlaps.join(" ")}`);
    for (const pl of placements) log(`strip ${pl.name}: gap to the timeline ${pl.gap.toFixed(1)}, right edge ${pl.right.toFixed(1)}, bottom ${pl.bottom.toFixed(1)}, track leftmost ${pl.trackLeftmost}, no taller than the bar ${pl.heightLeBar}, ${pl.stops} stops`);
    const placed = placements.every(placementOk);
    check(placed, `strip placement: ${placements.filter((x) => !placementOk(x)).map((x) => x.name).join(", ") || "all ok"}`);
    const python = placements[0]!;
    console.log(`ZOOMSTRIP placed=${placed ? "ok" : "fail"} gap=${Math.round(python.gap)} right=${Math.round(python.right)} bottom=${Math.round(python.bottom)} leftmost_track=${placements.every((x) => x.trackLeftmost) ? 1 : 0} height_le_bar=${placements.every((x) => x.heightLeBar) ? 1 : 0} apps=python,carp,lionfish`);
    console.log(`ZOOMSTRIP icon_stops=${stopCount} click_stop=${stopOk ? "ok" : "fail"} drag=${dragOk ? "ok" : "fail"} no_words=${noWords ? 1 : 0}`);

    const overlapCount = overlapList.length;
    const mobile = collapsed && phoneOverlap.length === 0;
    console.log(`ZOOM controls buttons=${buttons ? "ok" : "fail"} slider=${sliderOk ? "ok" : "fail"} keys=${keys ? "ok" : "fail"} reset=${reset ? "ok" : "fail"} fit=${fit ? "ok" : "fail"} overlap=${overlapCount} mobile=${mobile ? "ok" : "fail"}`);
    if (fails.length) log(`${fails.length} failed checks:\n  ${fails.join("\n  ")}`);
    return fails.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(stack.logs().slice(-3000));
    throw err;
  } finally {
    await browser.close();
    await stack.stop();
  }
}

process.exit(await main());
