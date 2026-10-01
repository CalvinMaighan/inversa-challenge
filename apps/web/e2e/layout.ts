/**
 * T40 e2e: the chat-left layout, the Layers legend, globe hover tooltips, the help sheet and the phone sheet,
 * on the real stack (e2e/stack.ts: Axum with the fixture backfill, `next start`, the signal Worker, a Caddy-like
 * proxy, all on free ports).
 *
 *   bun run e2e:layout            build, run, print the LAYOUT and THEMES lines
 *   E2E_SKIP_BUILD=1 …            reuse the last e2e build
 *
 * Desktop 1440×900:
 *   1. the chat column is visible at load, left, full height; the globe fills the pane to its right; the top
 *      bar, timeline and legend sit inside the globe pane (bounding boxes); the column's edge resizes it and the
 *      width survives to the next visit; the first-visit hint offers example questions and stays dismissed;
 *   2. Layers: the legend opens, its counts come from the globe's own layer stats, and its switches change
 *      LAYERS and the globe layer (stations off → disabled, 0 drawn; on → drawn again; a species filter);
 *   3. a hover over a known station (from Axum's own readings) shows its tooltip with the station name;
 *   4. the Missions tab switches, and a team message sent from a second browser lights its unread dot;
 *   5. the "?" sheet lists every control; Esc closes it;
 *   6. light, dark and tactical: column, legend and help text keep ≥ 4.5:1 contrast.
 * Phone 375×812:
 *   7. the globe is full screen, the column is a sheet collapsed to the composer; a tap and a drag on the handle
 *      move it to half and full height and back.
 *
 * Screenshots: docs/evidence/layout-legend.png, layout-tooltip.png, layout-mobile.png. Last lines:
 *
 *   THEMES light=ok dark=ok tactical=ok
 *   LAYOUT chat=left globe=right legend=ok tooltip=ok tabs=ok mobile=ok
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
/** The Axum fixtures were recorded 2026-09-30T20:40Z; the browser clock sits just after, so stations report. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
const LOAD_TIMEOUT_MS = 120_000;
const STATIONS = "stations";
const SIGHTINGS = "sightings";
const IGUANA = "iguana";

const log = (...a: unknown[]) => console.error("[e2e:layout]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type Box = { x: number; y: number; width: number; height: number };
type LayerStat = { id: string; enabled: boolean; count: number; breakdown?: Record<string, number> };

async function box(page: Page, selector: string): Promise<Box> {
  return (await page.locator(selector).first().boundingBox()) ?? fail(`${selector} has no box`);
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
  await context.clock.install({ time: new Date(FIXTURE_CLOCK) });
  return { context, page: watch(await context.newPage(), errors, name) };
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

async function desktop(browser: Browser, stack: Stack, errors: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const opened = await newPage(browser, { width: 1440, height: 900 }, errors, "A");
  const context = opened.context;
  let page = opened.page;
  await ready(page, stack.origin);

  // 1. Two panes.
  const column = await box(page, "[data-chat-column]");
  const globe = await box(page, "[data-globe]");
  const topbar = await box(page, '[data-testid="hud-topbar"]');
  const timeline = await box(page, '[data-testid="hud-timeline"]');
  const layersButton = await box(page, '[data-testid="layers-button"]');
  log(`column ${JSON.stringify(column)} globe ${JSON.stringify(globe)}`);
  if (column.x !== 0 || column.y !== 0 || Math.abs(column.height - 900) > 1 || Math.abs(column.width - 420) > 1) fail(`chat column ${JSON.stringify(column)}, want 0,0 420×900`);
  if (Math.abs(globe.x - (column.x + column.width)) > 1 || Math.abs(globe.x + globe.width - 1440) > 1 || Math.abs(globe.height - 900) > 1) fail(`globe ${JSON.stringify(globe)} does not fill the pane right of the column`);
  for (const [name, b] of [
    ["top bar", topbar],
    ["timeline", timeline],
    ["Layers button", layersButton],
  ] as const) {
    if (b.x < globe.x || b.x + b.width > globe.x + globe.width + 1) fail(`${name} ${JSON.stringify(b)} is not inside the globe pane`);
  }
  if (layersButton.x + layersButton.width < globe.x + globe.width - 80) fail(`Layers button ${JSON.stringify(layersButton)} is not top right`);
  if (!(await page.locator('[data-chat-column] [aria-label="Start voice"]').isVisible())) fail("no mic button in the composer");
  result.chat = "left";
  result.globe = "right";

  // First visit: example questions above the composer; dismissed for good once closed.
  const hint = page.locator("[data-chat-hint]");
  await hint.waitFor();
  const examples = await hint.locator("[data-example-question]").allTextContents();
  if (!examples.includes("Where should python crews go tonight?")) fail(`example questions: ${examples.join(" | ")}`);
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

  // 2. Layers legend: counts from the globe's stats, switches drive LAYERS and the layer.
  await page.waitForFunction((id) => (window.__inversa?.globe()?.layers.find((l) => l.id === id)?.count ?? 0) > 0, STATIONS, { timeout: LOAD_TIMEOUT_MS });
  await page.click('[data-testid="layers-button"]');
  const legend = page.locator('[data-testid="layers-legend"]');
  await legend.waitFor();
  const legendBox = await box(page, '[data-testid="layers-legend"]');
  if (legendBox.x < globe.x || legendBox.x + legendBox.width > 1440) fail(`legend ${JSON.stringify(legendBox)} is not inside the globe pane`);
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
  await page.click(`[data-testid="legend-species-${IGUANA}"]`);
  await page.waitForFunction((s) => (window.__inversa?.state("LAYERS") as { species: Record<string, boolean> }).species[s] === false, IGUANA);
  await page.waitForFunction((s) => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.breakdown?.[s] ?? -1) === 0, IGUANA);
  await page.click(`[data-testid="legend-species-${IGUANA}"]`);
  await page.waitForFunction((s) => (window.__inversa?.state("LAYERS") as { species: Record<string, boolean> }).species[s] === true, IGUANA);
  const after = await layersState(page);
  if (!after.visible[STATIONS] || after.species[IGUANA] !== true) fail(`LAYERS after toggles ${JSON.stringify(after)}`);
  const sightingsStat = await layerStat(page, SIGHTINGS);
  log(`legend toggles: stations off/on, iguana off/on; sightings ${JSON.stringify(sightingsStat?.breakdown)}`);
  result.legend = "ok";
  await page.click('[data-testid="layers-button"]');

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
  if (tipBox.x < globe.x || tipBox.y < 0) fail(`tooltip ${JSON.stringify(tipBox)} outside the globe pane`);
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

  // 5. Help sheet: every control, Esc closes.
  await page.click('[data-testid="help-button"]');
  const help = page.locator('[data-testid="help-sheet"]');
  await help.waitFor();
  const entries = await help.locator("[data-help-entry]").count();
  if (entries < 20) fail(`help sheet lists ${entries} controls`);
  for (const id of ["feeds", "live", "focus", "theme", "play", "step", "speed", "date", "layers", "agent-tab", "missions-tab", "mic", "citations", "drawer", "share"]) {
    if (!(await help.locator(`[data-help-entry="${id}"]`).count())) fail(`help sheet has no ${id} entry`);
  }
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "detached" });
  log(`help sheet: ${entries} controls`);

  // 6. Themes: readable column, legend and help in each mode.
  const themes: string[] = [];
  await page.click('[data-testid="layers-button"]');
  await legend.waitFor();
  for (const [mode, label] of [
    ["light", "light"],
    ["dark", "dark"],
    ["tactical", "tac"],
  ] as const) {
    await page.getByRole("radio", { name: label, exact: true }).click();
    await page.waitForTimeout(250);
    await page.click('[data-testid="help-button"]');
    await help.waitFor();
    const ratios = {
      column: await contrast(page, "[data-chat-column] [data-tab]", "[data-chat-column]"),
      composer: await contrast(page, '[data-chat-column] [aria-label="Question"]', "[data-chat-column]"),
      legend: await contrast(page, '[data-legend-layer="stations"] span', '[data-testid="layers-legend"]'),
      legendNote: await contrast(page, '[data-legend-layer="stations"] p', '[data-testid="layers-legend"]'),
      help: await contrast(page, "[data-help-entry] dd", '[data-testid="help-sheet"]'),
    };
    await page.keyboard.press("Escape");
    const low = Object.entries(ratios).filter(([, r]) => r < 4.5);
    log(`${mode}: ${Object.entries(ratios).map(([k, r]) => `${k}=${r.toFixed(2)}`).join(" ")}`);
    themes.push(`${mode}=${low.length ? `low(${low.map(([k, r]) => `${k}:${r.toFixed(2)}`).join(",")})` : "ok"}`);
  }
  await page.getByRole("radio", { name: "dark", exact: true }).click();
  result.themes = themes.join(" ");
  await context.close();
  return result;
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

  // Tap: half. Drag up: full. Drag down: collapsed.
  const handle = page.locator("[data-sheet-handle]");
  await handle.click();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "half");
  await page.waitForTimeout(400);
  const half = await box(page, "[data-chat-column]");
  if (Math.abs(half.height - 406) > 2) fail(`half sheet is ${half.height} px`);
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
  await page.locator('[data-chat-column] [data-tab="agent"]').click();
  await page.locator("[data-chat-hint]").waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOT_DIR, "layout-mobile.png") });
  log("phone: collapsed → half (tap) → full (drag) → collapsed (drag) → half (composer focus); tabs work; screenshot layout-mobile.png");
  await context.close();
}

async function main() {
  buildApi(log);
  buildWeb(log);
  mkdirSync(SHOT_DIR, { recursive: true });
  const stack = await startStack({ name: "layout" });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  try {
    const r = await desktop(browser, stack, errors);
    await phone(browser, stack, errors);
    if (errors.length) fail(`page errors:\n${errors.join("\n")}`);
    console.log(`THEMES ${r.themes}`);
    console.log(`LAYOUT chat=${r.chat} globe=${r.globe} legend=${r.legend} tooltip=${r.tooltip} tabs=${r.tabs} mobile=ok`);
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
