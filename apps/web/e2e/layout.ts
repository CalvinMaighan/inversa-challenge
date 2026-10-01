/**
 * T40 e2e: the chat-left layout, the Layers legend, globe hover tooltips, the help sheet and the phone sheet,
 * on the real stack (e2e/stack.ts: Axum with the fixture backfill, `next start`, the signal Worker, a Caddy-like
 * proxy, all on free ports).
 *
 *   bun run e2e:layout            build, run, print the LAYOUT and THEMES lines
 *   E2E_SKIP_BUILD=1 …            reuse the last e2e build
 *
 * Desktop 1440×900:
 *   1. the stage layout (docs/GODS_EYE.md GC1): the chat card is visible at load, floating at the left with
 *      12 px gutters (GE9: the --gap-m unit), full height less them; the globe fills the page behind it; the top bar, timeline and
 *      legend sit right of the card on the page (bounding boxes); the card's edge resizes it and the width
 *      survives to the next visit; the first-visit hint offers example questions and stays dismissed;
 *   2. Layers (About → More data, T41): the legend opens, its counts come from the globe's own layer stats, and
 *      its switches change LAYERS and the globe layer (stations start off → on, drawn; off → disabled; on again;
 *      a species switch, which the species chip follows);
 *   3. a hover over a known station (from Axum's own readings) shows its tooltip with the station name;
 *   4. the Missions tab switches, and a team message sent from a second browser lights its unread dot;
 *   5. the help sheet (About → Help) lists every control; Esc closes it;
 *   6. light, dark and tactical (from the theme button): column, legend, About, species chips and help text keep
 *      ≥ 4.5:1 contrast.
 * Phone 375×812:
 *   7. the globe is full screen, the column is a sheet collapsed to the composer; a tap and a drag on the handle
 *      move it to half and full height and back.
 *
 * Screenshots: docs/evidence/layout-legend.png, layout-tooltip.png, layout-mobile.png. Last lines:
 *
 *   THEMES light=ok dark=ok tactical=ok
 *   MOBILE app=python overflow=<n> hscroll=<n> pagescroll=<px> states=…
 *   LAYOUT app=python chat=left globe=right legend=ok tooltip=ok tabs=ok mobile=ok
 *
 * `-- --app carp|lionfish` runs the same frame (two panes; phone sheet, full-screen globe) over that app:
 *   carp (page clock 2026-10-01T08:00Z, an hour after its fixtures, so its gauges report): legend = the stage
 *     chart's legend names every series the chart draws for a site, and About → More data's switches turn the
 *     gauge (stations) and alerts layers off and on on the globe; tooltip = hovering a site marker shows its tip
 *     with that site's configured name; phone = the board tab opens the board as a sheet, a row opens the
 *     briefing, the stage timeline sits above the chat sheet.
 *   lionfish (page clock 2026-10-01T09:00Z): legend = each survey layer switch (reports, priority, heat,
 *     field) changes what is drawn and back; tooltip = hovering a ranked place and a report shows their tips
 *     with the place's rank and area and the report's source, as their labels say; phone = the survey tab opens
 *     the panel as a sheet, a ranked place opens its card.
 * MOBILE: at 375×812 in each state (load, chat half sheet, the app's panel, its drawer or card): `overflow` =
 * elements past the viewport's side edges or out of their HUD surface, `hscroll` = sideways scrolling boxes
 * plus states with horizontal page scroll. `mobile=ok` needs the phone checks and overflow=0 hscroll=0.
 * Also docs/evidence/<app>-desktop.png and docs/evidence/mobile/<app>-375.png.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { sitesOf } from "../client/carp/model";
import { getApp } from "../shared/apps";
import { appArg } from "./args";
import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const APP = appArg();
const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
const MOBILE_DIR = path.join(SHOT_DIR, "mobile");
/** The Axum fixtures were recorded 2026-09-30T20:40Z; the browser clock sits just after, so stations report. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
/** Carp fixtures: recorded 2026-10-01T07:01Z; an hour later its USGS gauges are inside the 2 h station window. */
const CARP_CLOCK_MS = Date.parse("2026-10-01T08:00:00Z");
/** Lionfish fixtures: e2e/lionfish.ts's live clock. */
const LIONFISH_CLOCK_MS = Date.parse("2026-10-01T09:00:00Z");
const STATUS_BUTTON = '[data-testid="status-button"]';
const LOAD_TIMEOUT_MS = 120_000;
const STATIONS = "stations";
const SIGHTINGS = "sightings";
const PYTHON = "python";

const log = (...a: unknown[]) => console.error("[e2e:layout]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type Box = { x: number; y: number; width: number; height: number };
type LayerStat = { id: string; enabled: boolean; count: number; breakdown?: Record<string, number> };

async function box(page: Page, selector: string): Promise<Box> {
  return (await page.locator(selector).first().boundingBox()) ?? fail(`${selector} has no box`);
}

/** About (ⓘ) → More data (for experts): the Layers legend. */
async function openLegend(page: Page): Promise<void> {
  await page.click('[data-testid="status-button"]');
  await page.locator('[data-testid="status-popover"]').waitFor();
  await page.click('[data-testid="layers-button"]');
  await page.locator('[data-testid="layers-legend"]').waitFor();
}

/** About (ⓘ) → Help. */
async function openHelp(page: Page): Promise<void> {
  await page.click('[data-testid="status-button"]');
  await page.click('[data-testid="help-button"]');
  await page.locator('[data-testid="help-sheet"]').waitFor();
}

async function layerStat(page: Page, id: string): Promise<LayerStat | null> {
  return page.evaluate((layer) => (window.__inversa?.globe()?.layers.find((l) => l.id === layer) as LayerStat | undefined) ?? null, id);
}

async function layersState(page: Page): Promise<{ visible: Record<string, boolean>; species: Record<string, unknown> }> {
  return (await page.evaluate(() => window.__inversa!.state("LAYERS"))) as { visible: Record<string, boolean>; species: Record<string, unknown> };
}

function watch(page: Page, errors: string[], name: string): Page {
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name} console: ${m.text()}`);
  });
  return page;
}

async function newPage(browser: Browser, viewport: { width: number; height: number }, errors: string[], name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(viewport.width < 768 ? { hasTouch: true } : {}) });
  if (APP === "python") await context.clock.install({ time: new Date(FIXTURE_CLOCK) });
  else await context.clock.setFixedTime(APP === "carp" ? CARP_CLOCK_MS : LIONFISH_CLOCK_MS);
  return { context, page: watch(await context.newPage(), errors, name) };
}

/** Carp and Lionfish Watch: the app's HUD has loaded its data (e2e/carp.ts, e2e/lionfish.ts); the banner is dismissed. */
async function appReady(page: Page, origin: string, phone = false): Promise<void> {
  await page.goto(`${origin}/?app=${APP}`, { waitUntil: "load" });
  await page.locator(`[data-testid="app-select-button"][data-app="${APP}"]`).waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  if (APP === "carp") {
    // On a phone the board is a closed sheet; its rows render once it opens.
    await page.waitForFunction(
      (rows) => (!rows || document.querySelectorAll("[data-carp-row]").length === 8) && [...document.querySelectorAll("[data-carp-site]")].length === 8 && [...document.querySelectorAll("[data-carp-site]")].every((m) => m.getAttribute("data-status") !== "loading"),
      !phone,
      { timeout: LOAD_TIMEOUT_MS },
    );
  } else {
    await page.locator('[data-testid="lionfish-hud"][data-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
    const dismiss = page.locator('[data-testid="lionfish-banner-dismiss"]');
    if (await dismiss.count()) await dismiss.click();
  }
  await page.waitForTimeout(800);
}

/** Stage frame at 1440×900 (GODS_EYE GC1): the chat card at 12,12, 420 wide, full height less the gutters; the globe filling the page. */
async function stageFrame(page: Page): Promise<{ column: Box; globe: Box }> {
  const column = await box(page, "[data-chat-column]");
  const globe = await box(page, "[data-globe]");
  log(`column ${JSON.stringify(column)} globe ${JSON.stringify(globe)}`);
  if (column.x !== 12 || column.y !== 12 || Math.abs(column.height - 876) > 1 || Math.abs(column.width - 420) > 1) fail(`chat card ${JSON.stringify(column)}, want 12,12 420×876`);
  if (globe.x !== 0 || globe.y !== 0 || Math.abs(globe.width - 1440) > 1 || Math.abs(globe.height - 900) > 1) fail(`globe ${JSON.stringify(globe)} does not fill the page`);
  return { column, globe };
}

/** `b` sits on the page right of the chat card (the HUD chrome never hides under it). */
function rightOfCard(b: Box, column: Box): boolean {
  return b.x >= column.x + column.width && b.x + b.width <= 1441 && b.y >= 0 && b.y + b.height <= 901;
}

/** Desktop frame: the chat card floating at the left, the globe filling the page, `inside` right of the card. */
async function panes(page: Page, inside: string[]): Promise<Box> {
  const { column, globe } = await stageFrame(page);
  for (const sel of inside) {
    const b = await box(page, sel);
    if (!rightOfCard(b, column)) fail(`${sel} ${JSON.stringify(b)} is not on the page right of the chat card`);
  }
  if (!(await page.locator('[data-chat-column] [aria-label="Question"]').isVisible())) fail("no composer in the chat column");
  return globe;
}

// ---- phone overflow (as e2e/a11y.ts measures it) -----------------------------------------------------------

type Overflow = { overflow: string[]; hscroll: string[]; pageScroll: number };

/** Content past the viewport's side edges (after clipping by ancestors) or out of its HUD surface, sideways scroll boxes, page scroll. */
function horizontalOverflow(): Overflow {
  const vw = document.documentElement.clientWidth;
  const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${[...el.classList].slice(0, 2).join(".")}`;
  const overflow: string[] = [];
  const hscroll: string[] = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    // Not rendered: inside a closed <details> (content-visibility: hidden) or a hidden ancestor.
    if (!el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    let left = r.left;
    let right = r.right;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === "visible") continue;
      const ar = a.getBoundingClientRect();
      left = Math.max(left, ar.left);
      right = Math.min(right, ar.right);
    }
    if (right - left > 0 && (left < -1 || right > vw + 1)) overflow.push(`${name(el)} ${Math.round(r.left)}..${Math.round(r.right)}`);
    const surface = el.parentElement?.closest("[data-hud-obstacle]");
    if (surface && right - left > 0) {
      const br = surface.getBoundingClientRect();
      if (left < br.left - 1 || right > br.right + 1) overflow.push(`${name(el)} ${Math.round(left)}..${Math.round(right)} outside ${name(surface)} ${Math.round(br.left)}..${Math.round(br.right)}`);
    }
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) hscroll.push(`${name(el)} ${el.scrollWidth}>${el.clientWidth}`);
  }
  const root = document.scrollingElement ?? document.documentElement;
  return { overflow, hscroll, pageScroll: root.scrollWidth - root.clientWidth };
}

/** Phone overflow per state, summed into the MOBILE line. */
const mobile = { states: [] as string[], overflow: 0, hscroll: 0, pageScroll: 0 };

async function measure(page: Page, state: string): Promise<void> {
  await page.waitForTimeout(500);
  const o = await page.evaluate(horizontalOverflow);
  mobile.states.push(state);
  mobile.overflow += o.overflow.length;
  mobile.hscroll += o.hscroll.length + (o.pageScroll > 0 ? 1 : 0);
  mobile.pageScroll = Math.max(mobile.pageScroll, o.pageScroll);
  log(`phone ${state}: overflow ${o.overflow.length} hscroll ${o.hscroll.length} pagescroll ${o.pageScroll}`);
  for (const line of [...o.overflow, ...o.hscroll].slice(0, 12)) log(`   ${state}: ${line}`);
}

/** The element's box lies on screen, between the top and the collapsed chat sheet, edge to edge at most. */
async function onScreen(page: Page, selector: string, floor: number): Promise<Box> {
  const b = await box(page, selector);
  if (b.x < -1 || b.x + b.width > 376 || b.y < -1 || b.y + b.height > floor + 1 || b.width < 1 || b.height < 1) fail(`${selector} ${JSON.stringify(b)} is not on screen above ${floor}`);
  return b;
}

/**
 * A fresh visit in the same browser profile (same localStorage). The old tab closes first: its db worker must
 * let go of the OPFS database before the new tab's worker opens it, as when a person closes and reopens a tab.
 */
async function revisit(context: BrowserContext, old: Page, origin: string, errors: string[], name: string): Promise<Page> {
  await old.close();
  const page = watch(await context.newPage(), errors, name);
  await ready(page, origin);
  return page;
}

async function ready(page: Page, origin: string, hash = ""): Promise<void> {
  await page.goto(`${origin}/${hash}`, { waitUntil: "load" });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && (window.__inversa?.globe()?.layers.length ?? 0) > 0, undefined, {
    timeout: LOAD_TIMEOUT_MS,
  });
}

/** WCAG contrast of two CSS colours as the page resolves them (oklch included), the background made opaque. */
async function contrast(page: Page, fgSelector: string, bgSelector: string): Promise<number> {
  return page.evaluate(
    ([fgSel, bgSel]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const g = canvas.getContext("2d", { willReadFrequently: true })!;
      const rgba = (css: string, under?: [number, number, number]) => {
        g.clearRect(0, 0, 1, 1);
        if (under) {
          g.fillStyle = `rgb(${under.join(" ")})`;
          g.fillRect(0, 0, 1, 1);
        }
        g.fillStyle = css;
        g.fillRect(0, 0, 1, 1);
        const d = g.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!] as [number, number, number];
      };
      const lum = ([r, gg, b]: [number, number, number]) => {
        const c = [r, gg, b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
      };
      const fgEl = document.querySelector(fgSel);
      const bgEl = document.querySelector(bgSel);
      if (!fgEl || !bgEl) return 0;
      const pageBg = rgba(getComputedStyle(document.body).backgroundColor || "#fff", [255, 255, 255]);
      const bg = rgba(getComputedStyle(bgEl).backgroundColor, pageBg);
      const fg = rgba(getComputedStyle(fgEl).color, bg);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    },
    [fgSelector, bgSelector] as const,
  );
}

// ---- desktop ---------------------------------------------------------------------------------------------

async function desktop(browser: Browser, stack: Stack, errors: string[], result: Record<string, string>): Promise<void> {
  const opened = await newPage(browser, { width: 1440, height: 900 }, errors, "A");
  const context = opened.context;
  let page = opened.page;
  await ready(page, stack.origin);

  // 1. The stage frame: chat card left, globe behind, the chrome right of the card.
  const { column, globe } = await stageFrame(page);
  const topbar = await box(page, '[data-testid="hud-topbar"]');
  const timeline = await box(page, '[data-testid="hud-timeline"]');
  // T41: the Layers legend lives in the About popover; its button sits top right with the theme button.
  const layersButton = await box(page, '[data-testid="status-button"]');
  for (const [name, b] of [
    ["top bar", topbar],
    ["timeline", timeline],
    ["Layers button", layersButton],
  ] as const) {
    if (!rightOfCard(b, column)) fail(`${name} ${JSON.stringify(b)} is not on the page right of the chat card`);
  }
  // First of the four top-right icon buttons (About, Theme, Look, Developer: 4 × 36 px, three 12 px gaps, the gutter).
  if (layersButton.x + layersButton.width < globe.x + globe.width - 200) fail(`Layers button ${JSON.stringify(layersButton)} is not top right`);
  if (!(await page.locator('[data-chat-column] [aria-label="Start voice"]').isVisible())) fail("no mic button in the composer");
  result.chat = "left";
  result.globe = "right";

  // First visit: example questions above the composer; dismissed for good once closed.
  const hint = page.locator("[data-chat-hint]");
  await hint.waitFor();
  const examples = await hint.locator("[data-example-question]").allTextContents();
  // The app's own example questions (shared/apps helperQuestions), at least two.
  const helper = getApp("python").helperQuestions;
  if (examples.length < 2 || !examples.every((q) => helper.includes(q))) fail(`example questions: ${examples.join(" | ")}`);
  log(`hint: ${examples.join(" | ")}`);

  // The column edge resizes; the width is remembered.
  const handle = await box(page, "[data-column-resize]");
  await page.mouse.move(handle.x + handle.width / 2, 450);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 80, 450, { steps: 6 });
  await page.mouse.up();
  const wider = await box(page, "[data-chat-column]");
  if (Math.abs(wider.width - 500) > 2) fail(`dragged column is ${wider.width} px, want 500`);
  const narrowed = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-column-resize]")!;
    el.focus();
    return el.getAttribute("aria-valuenow");
  });
  await page.keyboard.press("End");
  const atMax = await box(page, "[data-chat-column]");
  if (Math.abs(atMax.width - 560) > 1) fail(`End key: column ${atMax.width}, want 560 (was ${narrowed})`);
  await page.keyboard.press("Home");
  await page.locator('[data-chat-hint] [aria-label="Dismiss hint"]').click();
  page = await revisit(context, page, stack.origin, errors, "A");
  await page.waitForTimeout(300);
  const remembered = await box(page, "[data-chat-column]");
  if (Math.abs(remembered.width - 360) > 1) fail(`column on the next visit is ${remembered.width}, want the stored 360`);
  if (await page.locator("[data-chat-hint]").count()) fail("the dismissed hint came back on the next visit");
  await page.evaluate(() => localStorage.removeItem("inversa:chat-column-width"));
  page = await revisit(context, page, stack.origin, errors, "A");
  await page.waitForTimeout(300);
  if (Math.abs((await box(page, "[data-chat-column]")).width - 420) > 1) fail("column did not return to 420 px");
  log("resize 420 → 500 (drag) → 560 (End) → 360 (Home), kept for the next visit; hint stays dismissed");

  // 2. Layers legend (About → More data): counts from the globe's stats, switches drive LAYERS and the layer.
  // Stations start off (sightings first); the legend's switch turns them on.
  const legend = page.locator('[data-testid="layers-legend"]');
  await openLegend(page);
  const legendBox = await box(page, '[data-testid="layers-legend"]');
  // Horizontally only: the legend scrolls inside the About popover, so its box runs below the fold.
  if (legendBox.x < column.x + column.width || legendBox.x + legendBox.width > 1440) fail(`legend ${JSON.stringify(legendBox)} is not on the page right of the chat card`);
  if ((await page.textContent('[data-testid="legend-count-stations"]'))?.trim() !== "off") fail("stations are not off at load");
  await page.click('[data-testid="legend-toggle-stations"]');
  await page.waitForFunction((id) => {
    const l = window.__inversa?.globe()?.layers.find((x) => x.id === id);
    return (window.__inversa?.state("LAYERS") as { visible: Record<string, boolean> }).visible[id] === true && l?.enabled === true && l.count > 0;
  }, STATIONS, { timeout: LOAD_TIMEOUT_MS });
  const stationsBefore = (await layerStat(page, STATIONS))!;
  await page.waitForFunction(
    (n) => document.querySelector('[data-testid="legend-count-stations"]')?.textContent?.startsWith(String(n)) ?? false,
    stationsBefore.count,
    { timeout: 10_000 },
  ).catch(async () => fail(`legend shows ${await page.textContent('[data-testid="legend-count-stations"]')} stations, globe ${stationsBefore.count}`));
  const usgsShown = await page.textContent('[data-legend-layer="stations"] [data-testid="legend-count-usgs"]');
  if (Number(usgsShown) !== (stationsBefore.breakdown?.usgs ?? -1)) fail(`legend USGS count ${usgsShown}, globe ${JSON.stringify(stationsBefore.breakdown)}`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOT_DIR, "layout-legend.png") });
  await page.screenshot({ path: path.join(SHOT_DIR, "python-desktop.png") });
  log(`legend: stations ${stationsBefore.count} (${JSON.stringify(stationsBefore.breakdown)}); screenshot layout-legend.png`);

  await page.click('[data-testid="legend-toggle-stations"]');
  await page.waitForFunction((id) => {
    const l = window.__inversa?.globe()?.layers.find((x) => x.id === id);
    return (window.__inversa?.state("LAYERS") as { visible: Record<string, boolean> }).visible[id] === false && l?.enabled === false;
  }, STATIONS);
  if ((await page.textContent('[data-testid="legend-count-stations"]'))?.trim() !== "off") fail("legend does not show stations off");
  await page.click('[data-testid="legend-toggle-stations"]');
  await page.waitForFunction((id) => {
    const l = window.__inversa?.globe()?.layers.find((x) => x.id === id);
    return (window.__inversa?.state("LAYERS") as { visible: Record<string, boolean> }).visible[id] === true && l?.enabled === true && l.count > 0;
  }, STATIONS);
  // A species switch: the layer stops drawing that species (the breakdown, per taxon id, still counts it, for the chips).
  const sightingsAll = (await layerStat(page, SIGHTINGS)) ?? fail("no sightings stats");
  await page.click(`[data-testid="legend-species-${PYTHON}"]`);
  await page.waitForFunction((s) => (window.__inversa?.state("LAYERS") as { species: Record<string, boolean> }).species[s] === false, PYTHON);
  await page.waitForFunction(
    ([before, pythons]) => {
      const l = window.__inversa?.globe()?.layers.find((x) => x.id === "sightings");
      return !!l && l.count === before - pythons;
    },
    [sightingsAll.count, sightingsAll.breakdown?.["1"] ?? 0] as const,
  );
  if ((await page.getAttribute(`[data-species-chip="${PYTHON}"]`, "aria-pressed")) !== "false") fail("the species chip did not follow the legend's switch");
  await page.click(`[data-testid="legend-species-${PYTHON}"]`);
  await page.waitForFunction((s) => (window.__inversa?.state("LAYERS") as { species: Record<string, boolean> }).species[s] === true, PYTHON);
  const after = await layersState(page);
  if (!after.visible[STATIONS] || after.species[PYTHON] !== true) fail(`LAYERS after toggles ${JSON.stringify(after)}`);
  const sightingsStat = await layerStat(page, SIGHTINGS);
  log(`legend toggles: stations on/off/on, python off/on; sightings ${JSON.stringify(sightingsStat?.breakdown)}`);
  result.legend = "ok";
  await page.keyboard.press("Escape");
  await legend.waitFor({ state: "detached" });

  // 3. Hover a known station: one Axum reported in the 2 h before the cursor, flown to through a share link.
  const at = (await page.evaluate(() => (window.__inversa!.state("TIME") as { at: string }).at)) as string;
  const to = Date.parse(at);
  const { readings } = await stack.graphql<{ readings: { observedAt: string; origin: string; station: { id: string; name: string; source: string; lat: number; lon: number } }[] }>(
    `query($bbox: BBox!, $from: Time!, $to: Time!) { readings(bbox: $bbox, from: $from, to: $to, params: [STAGE_M]) { observedAt origin station { id name source lat lon } } }`,
    { bbox: { west: -83.2, south: 24.3, east: -79.8, north: 27.5 }, from: new Date(to - 2 * 3_600_000).toISOString(), to: new Date(Math.floor(to / 900_000) * 900_000).toISOString() },
  );
  const station = readings.find((r) => r.origin.toLowerCase() === "measured" && r.station.source === "usgs")?.station ?? fail(`no USGS stage reading in Axum before ${at}`);
  log(`station ${station.id} ${station.name} at ${station.lat},${station.lon}`);
  await page.evaluate(([lat, lon]) => {
    location.hash = `#v=1&c=${lat.toFixed(5)},${lon.toFixed(5)},6000,0,-90`;
  }, [station.lat, station.lon] as const);
  await page.waitForFunction(
    ([lat, lon]) => {
      const p = window.__inversa?.project(lon, lat);
      const v = window.__inversa?.state("VIEW") as { lat: number; lon: number } | undefined;
      return !!p && !!v && Math.abs(v.lat - lat) < 0.01 && Math.abs(v.lon - lon) < 0.01;
    },
    [station.lat, station.lon] as const,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1_500);
  const canvasBox = await box(page, "[data-globe] canvas");
  let hovered = false;
  for (let attempt = 0; attempt < 10 && !hovered; attempt++) {
    const p = (await page.evaluate(([lat, lon]) => window.__inversa!.project(lon, lat), [station.lat, station.lon] as const)) ?? fail("station projects off screen");
    await page.mouse.move(canvasBox.x + p.x + 3, canvasBox.y + p.y + 3);
    await page.mouse.move(canvasBox.x + p.x, canvasBox.y + p.y, { steps: 3 });
    hovered = await page
      .locator('[data-testid="globe-tooltip"]')
      .waitFor({ timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!hovered) fail(`no tooltip over station ${station.id}`);
  const tip = page.locator('[data-testid="globe-tooltip"]');
  const tipId = (await tip.getAttribute("data-evidence-id")) ?? "";
  const tipText = (await tip.textContent()) ?? "";
  if (!tipId.startsWith(`reading:${station.id}:`) || !tipText.includes("USGS gauge") || !tipText.includes(station.name)) fail(`tooltip ${tipId}: ${tipText}`);
  const tipBox = await box(page, '[data-testid="globe-tooltip"]');
  if (tipBox.x < column.x + column.width || tipBox.y < 0) fail(`tooltip ${JSON.stringify(tipBox)} under the chat card or off the page`);
  await page.screenshot({ path: path.join(SHOT_DIR, "layout-tooltip.png") });
  log(`tooltip "${tipText}"; screenshot layout-tooltip.png`);
  // A click still opens the evidence drawer on the same record.
  const mark = (await page.evaluate(([lat, lon]) => window.__inversa!.project(lon, lat), [station.lat, station.lon] as const)) ?? fail("station moved off screen");
  await page.mouse.click(canvasBox.x + mark.x, canvasBox.y + mark.y);
  await page.waitForFunction((id) => document.querySelector('[data-testid="hud-drawer-id"]')?.textContent?.trim() === id, tipId, { timeout: 15_000 });
  await page.click('[data-testid="hud-drawer"] [aria-label="Close panel"]');
  result.tooltip = "ok";

  // 4. Tabs: Missions switches; a teammate's message lights the dot while Agent shows.
  await page.click('[data-tab="board"]');
  await page.locator('[data-tabpanel="board"] [data-testid="team-panel"]').waitFor({ timeout: 60_000 });
  if (!((await page.evaluate(() => window.__inversa!.state("MISSIONS"))) as { panelOpen: boolean }).panelOpen) fail("MISSIONS.panelOpen is not set on the Missions tab");
  if (await page.locator('[data-tabpanel="agent"]').isVisible()) fail("Agent panel still showing on the Missions tab");
  await page.waitForSelector('[data-testid="team-panel"][data-ready="1"]', { timeout: 60_000 });
  await page.click('[data-tab="agent"]');
  await page.locator('[data-tabpanel="agent"] [aria-label="Question"]').waitFor();
  const peer = await newPage(browser, { width: 1280, height: 800 }, errors, "B");
  await ready(peer.page, stack.origin);
  await peer.page.click('[data-tab="board"]');
  await peer.page.waitForSelector('[data-testid="team-panel"][data-ready="1"]', { timeout: 60_000 });
  const text = `layout-e2e-${Date.now().toString(36)}`;
  await peer.page.fill('[data-testid="chat-input"]', text);
  await peer.page.press('[data-testid="chat-input"]', "Enter");
  await page.locator('[data-tab="board"][data-unread]').waitFor({ timeout: 45_000 });
  await page.click('[data-tab="board"]');
  await page.locator('[data-testid="chat-log"]', { hasText: text }).waitFor({ timeout: 15_000 });
  if (await page.locator('[data-tab="board"][data-unread]').count()) fail("the unread dot did not clear when the tab opened");
  await page.click('[data-tab="agent"]');
  await peer.context.close();
  log("Missions tab switches; a teammate's message lit and then cleared its dot");
  result.tabs = "ok";

  // 5. Help sheet (from About): every control, Esc closes.
  await openHelp(page);
  const help = page.locator('[data-testid="help-sheet"]');
  const entries = await help.locator("[data-help-entry]").count();
  if (entries < 20) fail(`help sheet lists ${entries} controls`);
  for (const id of ["species", "about", "feeds", "live", "focus", "theme", "play", "speed", "date", "layers", "agent-tab", "missions-tab", "mic", "citations", "drawer", "share"]) {
    if (!(await help.locator(`[data-help-entry="${id}"]`).count())) fail(`help sheet has no ${id} entry`);
  }
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "detached" });
  log(`help sheet: ${entries} controls`);

  // 6. Themes (from the theme button): readable column, legend, popover and help in each mode.
  const themes: string[] = [];
  for (const [mode, label] of [
    ["light", "Light"],
    ["dark", "Dark"],
    ["tactical", "Tactical"],
  ] as const) {
    await page.click('[data-testid="theme-button"]');
    await page.getByRole("radio", { name: label, exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await openLegend(page);
    const legendRatios = {
      legend: await contrast(page, '[data-legend-layer="stations"] span', '[data-testid="status-popover"]'),
      legendNote: await contrast(page, '[data-legend-layer="stations"] p', '[data-testid="status-popover"]'),
      about: await contrast(page, '[data-testid="status-popover"] > p', '[data-testid="status-popover"]'),
    };
    await page.keyboard.press("Escape");
    await openHelp(page);
    const ratios = {
      column: await contrast(page, "[data-chat-column] [data-tab]", "[data-chat-column]"),
      composer: await contrast(page, '[data-chat-column] [aria-label="Question"]', "[data-chat-column]"),
      ...legendRatios,
      chips: await contrast(page, '[data-species-chip][aria-pressed="true"]', '[data-testid="species-bar"]'),
      help: await contrast(page, "[data-help-entry] dd", '[data-testid="help-sheet"]'),
    };
    await page.keyboard.press("Escape");
    const low = Object.entries(ratios).filter(([, r]) => r < 4.5);
    log(`${mode}: ${Object.entries(ratios).map(([k, r]) => `${k}=${r.toFixed(2)}`).join(" ")}`);
    themes.push(`${mode}=${low.length ? `low(${low.map(([k, r]) => `${k}:${r.toFixed(2)}`).join(",")})` : "ok"}`);
  }
  await page.click('[data-testid="theme-button"]');
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  result.themes = themes.join(" ");
  await context.close();
}

// ---- phone -----------------------------------------------------------------------------------------------

async function phone(browser: Browser, stack: Stack, errors: string[]): Promise<void> {
  const { context, page } = await newPage(browser, { width: 375, height: 812 }, errors, "phone");
  await ready(page, stack.origin);
  const column = page.locator("[data-chat-column]");
  if ((await column.getAttribute("data-layout")) !== "sheet" || (await column.getAttribute("data-sheet")) !== "collapsed") fail("phone layout is not a collapsed sheet");
  const sheet = await box(page, "[data-chat-column]");
  const globe = await box(page, "[data-globe]");
  if (sheet.x !== 0 || Math.abs(sheet.width - 375) > 1 || Math.abs(sheet.y + sheet.height - 812) > 1 || sheet.height > 100) fail(`collapsed sheet ${JSON.stringify(sheet)}`);
  if (globe.x !== 0 || Math.abs(globe.width - 375) > 1 || globe.y !== 0 || globe.height < 812 - 100) fail(`phone globe ${JSON.stringify(globe)} is not full screen`);
  if (!(await page.locator('[data-chat-column] [aria-label="Question"]').isVisible())) fail("no composer in the collapsed sheet");
  const timeline = await box(page, '[data-testid="hud-timeline"]');
  if (timeline.y + timeline.height > sheet.y + 1) fail(`timeline ${JSON.stringify(timeline)} hides under the sheet ${JSON.stringify(sheet)}`);
  mkdirSync(MOBILE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(MOBILE_DIR, "python-375.png") });
  await measure(page, "main");

  // Tap: half. Drag up: full. Drag down: collapsed.
  const handle = page.locator("[data-sheet-handle]");
  await handle.click();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "half");
  await page.waitForTimeout(400);
  const half = await box(page, "[data-chat-column]");
  if (Math.abs(half.height - 406) > 2) fail(`half sheet is ${half.height} px`);
  await measure(page, "half");
  await page.locator('[data-chat-column] [data-tab="board"]').waitFor();
  const h = await box(page, "[data-sheet-handle]");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "full");
  await page.waitForTimeout(400);
  const full = await box(page, "[data-chat-column]");
  if (full.y > 12 || Math.abs(full.y + full.height - 812) > 1) fail(`full sheet ${JSON.stringify(full)}`);
  await measure(page, "full");
  const top = await box(page, "[data-sheet-handle]");
  await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + top.width / 2, 790, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "collapsed");

  // The composer grows the sheet so the thread shows; the Missions tab works in the sheet too.
  await page.locator('[data-chat-column] [aria-label="Question"]').click();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "half");
  await page.locator('[data-chat-column] [data-tab="board"]').click();
  await page.locator('[data-tabpanel="board"] [data-testid="team-panel"]').waitFor();
  await measure(page, "missions");
  await page.locator('[data-chat-column] [data-tab="agent"]').click();
  await page.locator("[data-chat-hint]").waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOT_DIR, "layout-mobile.png") });
  // The app's panel on a phone: About → More data (the Layers legend) in a popover on screen, scrolled to.
  await openLegend(page);
  await onScreen(page, '[data-testid="status-popover"]', 812);
  await page.locator('[data-testid="legend-toggle-stations"]').scrollIntoViewIfNeeded();
  await onScreen(page, '[data-testid="legend-toggle-stations"]', 812);
  await measure(page, "legend");
  await page.click(STATUS_BUTTON);
  log("phone: collapsed → half (tap) → full (drag) → collapsed (drag) → half (composer focus); tabs work; legend on screen; screenshot layout-mobile.png");
  await context.close();
}

// ---- carp and Lionfish Watch -------------------------------------------------------------------------------

const CARP_TIMELINE = '[data-testid="carp-timeline"]';
const CARP_DRAWER = '[data-testid="carp-drawer"]';
const LIONFISH_CARD = '[data-testid="lionfish-card"] [data-testid="lionfish-components"]';

/** Hover `selector` (each candidate in turn) until its `.tip` shows; returns the tip's name line, box and the marker's label. */
async function hoverTip(page: Page, selector: string): Promise<{ name: string; label: string; box: Box; text: string } | null> {
  const n = await page.locator(selector).count();
  for (let i = 0; i < Math.min(n, 12); i++) {
    const marker = page.locator(selector).nth(i);
    if (!(await marker.hover({ timeout: 3_000 }).then(() => true).catch(() => false))) continue;
    await page.waitForTimeout(250);
    const tip = await marker.evaluate((el) => {
      const t = el.querySelector<HTMLElement>(".tip");
      if (!t || getComputedStyle(t).visibility !== "visible" || parseFloat(getComputedStyle(t).opacity) === 0) return null;
      const r = t.getBoundingClientRect();
      return { name: t.querySelector("b")?.textContent?.trim() ?? "", label: el.getAttribute("aria-label") ?? "", box: { x: r.x, y: r.y, width: r.width, height: r.height }, text: t.innerText };
    });
    if (tip) return tip;
  }
  return null;
}

async function layerOf(page: Page, id: string): Promise<{ visible: boolean; enabled: boolean; count: number }> {
  return page.evaluate((layer) => {
    const l = window.__inversa?.globe()?.layers.find((x) => x.id === layer);
    const visible = (window.__inversa?.state("LAYERS") as { visible: Record<string, boolean> }).visible[layer] === true;
    return { visible, enabled: l?.enabled === true, count: l?.count ?? -1 };
  }, id);
}

/** A legend switch turns its globe layer off (not drawn, "off") and back on. */
async function legendSwitch(page: Page, layer: string): Promise<boolean> {
  const before = await layerOf(page, layer);
  await page.click(`[data-testid="legend-toggle-${layer}"]`);
  const off = await page
    .waitForFunction((id) => {
      const l = window.__inversa?.globe()?.layers.find((x) => x.id === id);
      return (window.__inversa?.state("LAYERS") as { visible: Record<string, boolean> }).visible[id] === false && l?.enabled === false;
    }, layer, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const offText = (await page.textContent(`[data-testid="legend-count-${layer}"]`))?.trim();
  await page.click(`[data-testid="legend-toggle-${layer}"]`);
  const on = await page
    .waitForFunction((id) => {
      const l = window.__inversa?.globe()?.layers.find((x) => x.id === id);
      return (window.__inversa?.state("LAYERS") as { visible: Record<string, boolean> }).visible[id] === true && l?.enabled === true;
    }, layer, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const after = await layerOf(page, layer);
  log(`legend ${layer}: ${JSON.stringify(before)} → off=${off} ("${offText}") → on=${on} ${JSON.stringify(after)}`);
  return before.visible && before.enabled && off && offText === "off" && on && after.count === before.count;
}

async function carpDesktop(browser: Browser, stack: Stack, errors: string[], result: Record<string, string>): Promise<void> {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 }, errors, "A");
  await appReady(page, stack.origin);
  const globe = await panes(page, ['[data-testid="hud-topbar"]', STATUS_BUTTON, CARP_TIMELINE, '[data-testid="carp-board-panel"]']);
  result.chat = "left";
  result.globe = "right";

  // Tooltip: a site marker on screen shows its tip, named as the app's configuration names that site.
  const names = new Map(sitesOf(getApp("carp").locations).map((s) => [s.lid, s.name]));
  const tip = await hoverTip(page, "[data-carp-site]:not([data-hidden])");
  const lid = tip ? /\(([A-Z0-9]+)\)/.exec(tip.label)?.[1] : undefined;
  log(`tooltip ${lid}: "${tip?.text.replace(/\n/g, " | ")}" (want "${lid ? names.get(lid) : "?"}")`);
  if (!tip || !lid || tip.name !== names.get(lid) || !tip.label.startsWith(tip.name)) fail(`site tooltip ${JSON.stringify(tip)}`);
  if (tip.box.x < globe.x || tip.box.x + tip.box.width > 1441 || tip.box.y < 0) fail(`site tooltip ${JSON.stringify(tip.box)} outside the globe pane`);
  await page.screenshot({ path: path.join(SHOT_DIR, "carp-layout-tooltip.png") });
  result.tooltip = "ok";

  // Legend 1: the stage chart's legend names each series the chart draws for a site.
  await page.click('[data-carp-row="KRZL1"]');
  await page.locator(`${CARP_DRAWER}[data-site="KRZL1"] [data-testid="carp-changed"]`).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => /usgs:[1-9]/.test(document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')?.dataset.series ?? ""), undefined, { timeout: 30_000 }).catch(() => {});
  const series = (await page.getAttribute('[data-testid="carp-chart"]', "data-series")) ?? "";
  const legendText = await page.locator('[data-testid="carp-legend"]').innerText();
  const labels: Record<string, string> = { usgs: "USGS gauge height", nwps: "NWPS observed stage", forecast: "NWPS forecast", spread: "spread of last 3 issuances" };
  const drawn = Object.keys(labels).filter((k) => new RegExp(`\\b${k}:[1-9]`).test(series));
  const unnamed = drawn.filter((k) => !legendText.includes(labels[k]!));
  log(`chart series "${series}"; drawn ${drawn.join(",")}; legend lists ${Object.keys(labels).filter((k) => legendText.includes(labels[k]!)).join(",")}`);
  const chartLegend = drawn.length === 4 && unnamed.length === 0;
  if (!chartLegend) log(`FAIL chart legend: drawn ${drawn.join(",")} unnamed ${unnamed.join(",")}`);
  await page.click('[data-testid="carp-drawer-panel"] button[aria-label="Close panel"]');

  // Legend 2: About → More data, the carp legend; its gauge and alert switches turn those globe layers off and on.
  await openLegend(page);
  if ((await page.getAttribute('[data-testid="layers-legend"]', "data-app")) !== "carp") fail("the legend is not carp's");
  const stations = await layerOf(page, "stations");
  const shown = (await page.textContent('[data-testid="legend-count-stations"]'))?.trim() ?? "";
  const countOk = stations.count > 0 && shown.startsWith(String(stations.count));
  log(`legend stations "${shown}", globe ${JSON.stringify(stations)}`);
  await page.screenshot({ path: path.join(SHOT_DIR, "carp-desktop.png") });
  const switches = (await legendSwitch(page, "stations")) && (await legendSwitch(page, "alerts"));
  await page.keyboard.press("Escape");
  if (chartLegend && countOk && switches) result.legend = "ok";
  else log(`FAIL legend chart=${chartLegend} count=${countOk} switches=${switches}`);
  await context.close();
}

async function lionfishDesktop(browser: Browser, stack: Stack, errors: string[], result: Record<string, string>): Promise<void> {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 }, errors, "A");
  await appReady(page, stack.origin);
  const globe = await panes(page, ['[data-testid="hud-topbar"]', STATUS_BUTTON, '[data-testid="hud-timeline"]', '[data-testid="lionfish-panel"]']);
  result.chat = "left";
  result.globe = "right";
  await page.screenshot({ path: path.join(SHOT_DIR, "lionfish-desktop.png") });

  // Legend: each survey layer switch changes what is drawn, and back (e2e/lionfish.ts layerCheck).
  const canvas = () => page.evaluate(() => ({ ...document.querySelector<HTMLCanvasElement>('[data-testid="lionfish-canvas"]')!.dataset }));
  const layerCheck = async (layer: string, probe: () => Promise<number>): Promise<boolean> => {
    const before = await probe();
    await page.click(`input[data-layer="${layer}"]`);
    await page.waitForTimeout(400);
    const after = await probe();
    await page.click(`input[data-layer="${layer}"]`);
    await page.waitForTimeout(400);
    const back = await probe();
    log(`layer ${layer}: ${before} -> ${after} -> ${back}`);
    return before !== after && back === before;
  };
  const reports = await layerCheck("reports", () => page.locator('[data-kind="report"]').count());
  const priority = await layerCheck("priority", () => page.locator('[data-kind="cell"]').count());
  const heat = await layerCheck("heat", async () => Number((await canvas()).heatOk ?? 0));
  const field = await layerCheck("field", async () => Number((await canvas()).field ?? 0));
  if (reports && priority && heat && field) result.legend = "ok";
  else log(`FAIL layers reports=${reports} priority=${priority} heat=${heat} field=${field}`);

  // Tooltip: a ranked place and a report on screen show their tips, named as their labels say.
  const areas = getApp("lionfish").regions.map((r) => r.name);
  const cell = await hoverTip(page, '[data-kind="cell"]:not([data-hidden])');
  const cellMatch = cell ? /^Survey priority (\d+) · (.+)$/.exec(cell.name) : null;
  const cellOk = !!cell && !!cellMatch && areas.includes(cellMatch[2]!) && cell.label.startsWith(`Survey priority ${cellMatch[1]} in ${cellMatch[2]}`);
  log(`place tooltip "${cell?.name}" label "${cell?.label.slice(0, 60)}" ok=${cellOk}`);
  const report = await hoverTip(page, '[data-kind="report"]:not([data-hidden]):not([data-copy])');
  const source = report ? /^Lionfish report · (.+)$/.exec(report.name)?.[1] : undefined;
  const reportOk = !!report && !!source && report.label.startsWith(`Lionfish report, ${source} `);
  log(`report tooltip "${report?.name}" label "${report?.label.slice(0, 60)}" ok=${reportOk}`);
  const inside = [cell, report].every((t) => !!t && t.box.x >= globe.x - 1 && t.box.x + t.box.width <= 1441 && t.box.y >= 0);
  if (cellOk && reportOk && inside) result.tooltip = "ok";
  else log(`FAIL tooltip place=${cellOk} report=${reportOk} inside=${inside}`);
  await page.screenshot({ path: path.join(SHOT_DIR, "lionfish-layout-tooltip.png") });
  await context.close();
}

/** Carp and Lionfish Watch at 375×812: sheet, full-screen globe, timeline above the sheet, the app's panel and its drawer or card. */
async function appPhone(browser: Browser, stack: Stack, errors: string[]): Promise<void> {
  const { context, page } = await newPage(browser, { width: 375, height: 812 }, errors, "phone");
  await appReady(page, stack.origin, true);
  const column = page.locator("[data-chat-column]");
  if ((await column.getAttribute("data-layout")) !== "sheet" || (await column.getAttribute("data-sheet")) !== "collapsed") fail("phone layout is not a collapsed sheet");
  const sheet = await box(page, "[data-chat-column]");
  const globe = await box(page, "[data-globe]");
  if (sheet.x !== 0 || Math.abs(sheet.width - 375) > 1 || Math.abs(sheet.y + sheet.height - 812) > 1 || sheet.height > 100) fail(`collapsed sheet ${JSON.stringify(sheet)}`);
  if (globe.x !== 0 || Math.abs(globe.width - 375) > 1 || globe.y !== 0 || globe.height < 812 - 100) fail(`phone globe ${JSON.stringify(globe)} is not full screen`);
  if (!(await page.locator('[data-chat-column] [aria-label="Question"]').isVisible())) fail("no composer in the collapsed sheet");
  await onScreen(page, APP === "carp" ? CARP_TIMELINE : '[data-testid="hud-timeline"]', sheet.y);
  mkdirSync(MOBILE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(MOBILE_DIR, `${APP}-375.png`) });
  await measure(page, "main");

  // The chat sheet opens to half height and closes again.
  await page.locator("[data-sheet-handle]").click();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "half");
  await page.waitForTimeout(400);
  if (Math.abs((await box(page, "[data-chat-column]")).height - 406) > 2) fail("half sheet is not 406 px");
  await measure(page, "half");
  await page.locator("[data-sheet-handle]").click();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") !== "half");
  if ((await column.getAttribute("data-sheet")) !== "collapsed") {
    // A tap from half may go to full; one more tap returns to collapsed in that design.
    await page.locator("[data-sheet-handle]").click();
    await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "collapsed", undefined, { timeout: 5_000 });
  }

  // The app's panel: its tab opens it on screen; a row opens the drawer (carp) or card (lionfish).
  const tab = APP === "carp" ? '[data-testid="carp-board-panel-tab"]' : '[data-testid="lionfish-panel-tab"]';
  const panel = APP === "carp" ? '[data-testid="carp-board-panel"]' : '[data-testid="lionfish-panel"]';
  await onScreen(page, tab, sheet.y);
  await page.locator(tab).click();
  await page.locator(panel).waitFor();
  if (APP === "carp") await page.waitForFunction(() => document.querySelectorAll("[data-carp-row]").length === 8, undefined, { timeout: 30_000 });
  await page.waitForTimeout(400);
  await onScreen(page, panel, sheet.y);
  await measure(page, "panel");
  if (APP === "carp") {
    await page.locator('[data-carp-row="KRZL1"]').click();
    await page.locator(`${CARP_DRAWER}[data-site="KRZL1"] [data-testid="carp-changed"]`).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(400);
    await onScreen(page, '[data-testid="carp-drawer-panel"]', sheet.y);
    await measure(page, "drawer");
  } else {
    await page.locator('[data-area="fl-keys"]').click();
    if (!(await page.locator("[data-cell-row]").first().isVisible())) await page.locator(tab).click();
    const row = (await page.getAttribute("[data-cell-row]", "data-cell-row")) ?? fail("no ranked place");
    await page.locator(`[data-cell-row="${row}"]`).click();
    await page.locator(LIONFISH_CARD).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(400);
    await onScreen(page, '[data-testid="lionfish-card-panel"]', sheet.y);
    await measure(page, "card");
  }
  log(`phone (${APP}): collapsed sheet with composer, full-screen globe, timeline above the sheet, half sheet, panel and ${APP === "carp" ? "drawer" : "card"} on screen`);
  await context.close();
}

async function main() {
  buildApi(log);
  buildWeb(log);
  mkdirSync(SHOT_DIR, { recursive: true });
  const stack = await startStack({ name: "layout", app: APP, apps: [APP] });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  const r: Record<string, string> = {};
  let failed = false;
  const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (err) {
      log(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
      return false;
    }
  };
  try {
    await step("desktop", () => (APP === "python" ? desktop : APP === "carp" ? carpDesktop : lionfishDesktop)(browser, stack, errors, r));
    const phoneOk = await step("phone", () => (APP === "python" ? phone(browser, stack, errors) : appPhone(browser, stack, errors)));
    if (mobile.states.length) console.log(`MOBILE app=${APP} overflow=${mobile.overflow} hscroll=${mobile.hscroll} pagescroll=${mobile.pageScroll} states=${mobile.states.join(",")}`);
    const mobileOk = phoneOk && mobile.states.length > 0 && mobile.overflow === 0 && mobile.hscroll === 0;
    if (errors.length) {
      // Page errors fail the run as before: no LAYOUT line claims anything.
      log(`page errors:\n${errors.join("\n")}`);
      console.log(`LAYOUT-FAIL app=${APP} page-errors=${errors.length}`);
      failed = true;
    } else {
      if (r.themes) console.log(`THEMES ${r.themes}`);
      const v = (k: string) => r[k] ?? "fail";
      const tabs = APP === "python" ? ` tabs=${v("tabs")}` : "";
      console.log(`LAYOUT app=${APP} chat=${v("chat")} globe=${v("globe")} legend=${v("legend")} tooltip=${v("tooltip")}${tabs} mobile=${mobileOk ? "ok" : "fail"}`);
      if (!mobileOk || ["chat", "globe", "legend", "tooltip"].some((k) => r[k] === undefined)) failed = true;
    }
    if (failed) {
      log(stack.logs());
      process.exitCode = 1;
    }
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    if (errors.length) log(`page errors:\n${errors.join("\n")}`);
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
