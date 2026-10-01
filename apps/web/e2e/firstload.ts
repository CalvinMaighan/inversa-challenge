/**
 * T41 e2e: what a newcomer sees at first load, on the real stack (e2e/stack.ts: Axum with the fixture backfill,
 * `next start`, the signal Worker and a Caddy-like proxy, all on free ports), 1440×900 at the live edge.
 *
 *   bun run e2e:firstload            build, run, print the SIMPLIFY, FIRSTLOAD, CHROME, ATTRIBUTION and POPOVERS lines
 *   bun run e2e:firstload --before   only measure and save docs/evidence/simplify-before.png (run on a build of
 *                                    the code before T41)
 *   E2E_SKIP_BUILD=1 …               reuse the last e2e build
 *
 * 1. Clutter at load: interactive controls and elements with their own visible text, in the globe pane and on
 *    the whole page (text drawn on canvases is not counted). `SIMPLIFY pane_controls=… page_labels=…`.
 * 2. Only sightings on the globe: stations, alerts and hotspots draw nothing, and the sightings layer draws
 *    exactly the distinct (non-duplicate) sightings of the app's species Axum holds for the same window of frames
 *    (the app's default window).
 *    `FIRSTLOAD sightings>0 stations=0 alerts=0 hotspots=0 window=<drawn> api=<count>`.
 * 3. No always-visible top bar text: the chrome is two icon buttons. `CHROME icons=2 visible_text_labels=0`.
 * 4. The globe's data attribution is clickable (the element at its centre is the link). `ATTRIBUTION clickable=1`.
 * 5. Both popovers open from their buttons and Esc hands focus back. `POPOVERS about=ok theme=ok`.
 *
 * Screenshots: docs/evidence/simplify-after.png (load), simplify-welcome.png (welcome plus a species chip's
 * description), simplify-popover.png (About open); for another app than python the names end in `-<app>`.
 *
 * Apps (PLAN.md C-A1): `--app <id>` (default python, whose data the fixtures are) runs it in that app, its data dir
 * filled by `backfill --fixtures --app <id>`, the region and the species from its config, and appends `app=<id>`
 * to the FIRSTLOAD line. A conditions app (carp) has no sightings layer and no frames: step 2 checks that nothing
 * but its gauges and alerts can draw (`FIRSTLOAD kind=conditions sightings=0 hotspots=0 app=carp`).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { appBBox, getApp, isAppId, type AppId } from "../shared/apps";
import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
/**
 * The Axum fixtures were recorded 2026-09-30T20:40Z; the browser clock sits just after, at the live edge. The
 * python app tracks one species (K1), and the newest Burmese python in its fixtures was observed 2026-09-14, so
 * its 7-day default window at 2026-09-30 is empty: for python the clock sits the day after that record instead.
 */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
const PYTHON_CLOCK = "2026-09-15T21:00:00Z";
const LOAD_TIMEOUT_MS = 120_000;
const APP_ARG = process.argv[process.argv.indexOf("--app") + 1];
const APP: AppId = process.argv.includes("--app") ? (isAppId(APP_ARG) ? APP_ARG : fail(`--app ${APP_ARG}: not an app id`)) : "python";
const CLOCK = APP === "python" ? PYTHON_CLOCK : FIXTURE_CLOCK;
const CONFIG = getApp(APP);
const SPECIES_APP = CONFIG.kind === "species";
const REGION = appBBox(CONFIG);
const shotName = (name: string) => (APP === "python" ? name : name.replace(/\.png$/, `-${APP}.png`));
/** The app's default sightings window (`windows.defaultHours`: 7 days for python, 30 for lionfish). */
const WINDOW_HOURS = CONFIG.windows.defaultHours;

const log = (...a: unknown[]) => console.error("[e2e:firstload]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type LayerStat = { id: string; enabled: boolean; count: number; frame: number; breakdown?: Record<string, number> };

const layerStats = (page: Page) => page.evaluate(() => (window.__inversa?.globe()?.layers ?? []) as LayerStat[]);

async function ready(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/?app=${APP}`, { waitUntil: "load" });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  if (!SPECIES_APP) {
    // No frames in a conditions app: the feeds and the globe's layers are what loads.
    await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction(() => (window.__inversa?.globe()?.layers.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(4_000);
    return;
  }
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && (window.__inversa?.globe()?.layers.length ?? 0) > 0, undefined, {
    timeout: LOAD_TIMEOUT_MS,
  });
  await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.frame ?? -1) >= 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  // Imagery, the stats sampler and the feed subscription settle.
  await page.waitForTimeout(4_000);
}

/**
 * Controls (anything Tab or a click reaches) and elements that carry their own visible text, in the viewport,
 * in the globe pane and on the whole page.
 */
async function measure(page: Page): Promise<{ paneControls: number; paneLabels: number; pageControls: number; pageLabels: number }> {
  return page.evaluate(() => {
    const CONTROLS =
      'button, a[href], input, select, textarea, summary, [role="button"], [role="radio"], [role="switch"], [role="tab"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    };
    const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0);
    const pane = document.querySelector('[data-slot="globe-pane"]');
    const controls = [...document.querySelectorAll(CONTROLS)].filter(visible);
    const labels = [...document.querySelectorAll("body *")].filter((el) => el.tagName !== "SCRIPT" && el.tagName !== "STYLE" && ownText(el) && visible(el));
    const inPane = (el: Element) => !!pane && pane.contains(el);
    return {
      paneControls: controls.filter(inPane).length,
      paneLabels: labels.filter(inPane).length,
      pageControls: controls.length,
      pageLabels: labels.length,
    };
  });
}

/** Buttons and visible own-text elements inside the top bar chrome. */
async function chrome(page: Page): Promise<{ icons: number; text: number }> {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="hud-topbar"]');
    if (!bar) return { icons: -1, text: -1 };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    };
    const icons = [...bar.querySelectorAll("button")].filter((b) => visible(b) && b.getAttribute("aria-haspopup") === "dialog").length;
    const text = [...bar.querySelectorAll("*")].filter(
      (el) => visible(el) && [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0),
    ).length;
    return { icons, text };
  });
}

/**
 * Distinct sightings Axum holds for the frames the sightings layer draws (the trailing window of frames, 7 days
 * by default) of the app's species (`speciesCounts` counts the focus taxon only): what the globe draws by default.
 */
async function apiWindowCount(page: Page, stack: Stack, frame: number): Promise<{ count: number; from: string; to: string }> {
  const meta = (await page.evaluate(() => window.__inversa!.snapshot().meta)) ?? fail("no frame meta");
  const step = meta.stepMinutes * 60_000;
  const frames = Math.ceil((WINDOW_HOURS * 3_600_000) / step);
  const first = Math.max(0, frame - frames + 1);
  const from = new Date(meta.frame0UnixMs + first * step).toISOString();
  // Frames hold [start, start + step); the API's window is inclusive at both ends.
  const to = new Date(meta.frame0UnixMs + (frame + 1) * step - 1).toISOString();
  const { speciesCounts } = await stack.graphql<{ speciesCounts: { count: number }[] }>(
    "query($bbox: BBox!, $from: Time!, $to: Time!) { speciesCounts(bbox: $bbox, from: $from, to: $to) { count } }",
    { bbox: REGION, from, to },
  );
  return { count: speciesCounts.reduce((n, row) => n + row.count, 0), from, to };
}

async function popovers(page: Page): Promise<string> {
  const results: string[] = [];
  for (const [name, button, pop] of [
    ["about", "status-button", "status-popover"],
    ["theme", "theme-button", "theme-popover"],
  ] as const) {
    await page.locator(`[data-testid="${button}"]`).focus();
    await page.keyboard.press("Enter");
    await page.locator(`[data-testid="${pop}"]`).waitFor({ timeout: 5_000 });
    if (!(await page.evaluate((sel) => document.activeElement?.closest(sel) !== null, `[data-testid="${pop}"]`))) fail(`${name}: opening did not move focus into the popover`);
    if (name === "about") {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOT_DIR, shotName("simplify-popover.png")) });
      log(`screenshot ${shotName("simplify-popover.png")}`);
    }
    await page.keyboard.press("Escape");
    await page.locator(`[data-testid="${pop}"]`).waitFor({ state: "detached", timeout: 5_000 });
    if (!(await page.evaluate((id) => document.activeElement?.getAttribute("data-testid") === id, button))) fail(`${name}: Esc closed the popover but focus did not return to its button`);
    results.push(`${name}=ok`);
  }
  return `POPOVERS ${results.join(" ")}`;
}

async function firstLoad(browser: Browser, stack: Stack, before: boolean): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.clock.install({ time: new Date(CLOCK) });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, stack.origin);
  const m = await measure(page);
  const lines = [`SIMPLIFY pane_controls=${m.paneControls} pane_labels=${m.paneLabels} page_controls=${m.pageControls} page_labels=${m.pageLabels}`];
  const loadShot = shotName(before ? "simplify-before.png" : "simplify-after.png");
  await page.screenshot({ path: path.join(SHOT_DIR, loadShot) });
  log(`screenshot ${loadShot}`);
  if (before) {
    await context.close();
    return lines;
  }

  // Only sightings draw, and they are exactly Axum's distinct sightings of the window.
  const stats = await layerStats(page);
  const drawn = (id: string) => {
    const s = stats.find((l) => l.id === id);
    return s && s.enabled ? s.count : 0;
  };
  log(`layers: ${stats.map((l) => `${l.id}=${l.enabled ? l.count : "off"}`).join(" ")}`);
  if (SPECIES_APP) {
    const sightings = stats.find((l) => l.id === "sightings") ?? fail("no sightings layer");
    const api = await apiWindowCount(page, stack, sightings.frame);
    log(`sightings layer frame ${sightings.frame}: ${sightings.count} drawn ${JSON.stringify(sightings.breakdown)}; Axum ${api.count} distinct in ${api.from}..${api.to}`);
    if (!(sightings.enabled && sightings.count > 0)) fail("no sightings drawn at first load");
    if (sightings.count !== api.count) fail(`globe draws ${sightings.count} sightings, Axum has ${api.count} distinct animal sightings in the same window`);
    const [stations, alerts, hotspots] = [drawn("stations"), drawn("alerts"), drawn("hotspots")];
    lines.push(`FIRSTLOAD sightings>0 stations=${stations} alerts=${alerts} hotspots=${hotspots} window=${sightings.count} api=${api.count} app=${APP}`);
  } else {
    // A conditions app lists no sightings or hotspot layer: neither may draw.
    const [sightings, hotspots] = [drawn("sightings"), drawn("hotspots")];
    if (sightings || hotspots) fail(`conditions app draws sightings=${sightings} hotspots=${hotspots}`);
    lines.push(`FIRSTLOAD kind=conditions sightings=${sightings} hotspots=${hotspots} stations=${drawn("stations")} alerts=${drawn("alerts")} app=${APP}`);
  }

  const c = await chrome(page);
  lines.push(`CHROME icons=${c.icons} visible_text_labels=${c.text}`);

  // The attribution link answers to the pointer: nothing covers its centre.
  const attribution = await page.evaluate(() => {
    const link = document.querySelector<HTMLElement>("[data-globe-credits] .cesium-credit-expand-link") ?? document.querySelector<HTMLElement>("[data-globe-credits] a");
    if (!link) return { found: false, clickable: false, text: "" };
    const r = link.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { found: true, clickable: !!hit && (hit === link || link.contains(hit)), text: link.textContent?.trim() ?? "" };
  });
  log(`attribution "${attribution.text}" clickable=${attribution.clickable}`);
  if (!attribution.found) fail("no attribution link in the globe credits");
  lines.push(`ATTRIBUTION clickable=${attribution.clickable ? 1 : 0}`);

  // The welcome, with a species chip's plain description showing.
  const welcome = page.locator("[data-chat-hint]");
  await welcome.waitFor();
  const welcomeText = (await welcome.locator("[data-welcome]").textContent()) ?? "";
  const species = await welcome.locator("[data-welcome-species]").count();
  log(`welcome: "${welcomeText}" with ${species} species lines`);
  // A species app: one line for its species; a conditions app has no species chip.
  const wantSpecies = SPECIES_APP ? CONFIG.taxa.length : 0;
  if (species !== wantSpecies) fail(`the welcome lists ${species} species, want ${wantSpecies}`);
  if (SPECIES_APP) await page.locator(`[data-species-chip="${CONFIG.taxa[0]!.id}"]`).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, shotName("simplify-welcome.png")) });
  log(`screenshot ${shotName("simplify-welcome.png")}`);
  await page.mouse.move(900, 500);

  lines.push(await popovers(page));
  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  await context.close();
  return lines;
}

async function main() {
  const before = process.argv.includes("--before");
  buildApi(log);
  buildWeb(log);
  mkdirSync(SHOT_DIR, { recursive: true });
  const stack = await startStack({ name: "firstload", app: APP });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    for (const line of await firstLoad(browser, stack, before)) console.log(line);
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
