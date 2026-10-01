/**
 * Leaf UL e2e: the Lionfish Watch UI on the real stack (e2e/stack.ts: Axum over a temp data dir filled by
 * `backfill --fixtures --app lionfish`, the production e2e build, the signal Worker and the Caddy-like proxy).
 * Everything is driven through the UI; `window.__inversa` is only read (camera position).
 *
 *   bun run e2e:lionfish        build, run, print the LIONFISH lines
 *   E2E_SKIP_BUILD=1 …          reuse the last e2e build
 *
 * The fixtures were recorded 2026-10-01 (CRW product day 2026-09-29, iNat to 2026-09-30) and the pollers are
 * off, so the page clock is pinned: 2026-10-01T09:00Z for the live view (CRW 45 h old: fresh), 2026-10-03T06:00Z
 * for the stale phase (CRW 90 h old). The API answers for whatever `at` the page asks, so every line holds on any
 * run date.
 *
 * Lines:
 *   LIONFISH areas=4 layers=ok thin=2 duplicates=ok keyboard=ok
 *   LIONFISH-CARD components=4 heat_both=ok field_separate=ok links_new_tab=ok no_percent=ok
 *   LIONFISH-QUALITY basis_toggle=ok late_filter=ok stale=ok missing=ok conflict=ok chips=ok
 *   LIONFISH-REPLAY play=ok step=ok asof=ok scrub_median_ms=<n> requests=0
 *   LIONFISH-HELP topics=6 sources=ok banner=ok
 *   LIONFISH-A11Y serious=<n> critical=<n> mobile_hscroll=<n> keyboard=ok
 * Screenshots: docs/evidence/lionfish-{areas,priority-card,heat,quality,replay,help,mobile,light}.png
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { getApp } from "../shared/apps";
import { APP_DIR, buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
const LOAD_TIMEOUT_MS = 120_000;
const LIVE_MS = Date.parse("2026-10-01T09:00:00Z");
const STALE_MS = Date.parse("2026-10-03T06:00:00Z");
const DAY = 86_400_000;
const APP = getApp("lionfish");
const RISK_PERCENT = /(risk|probability|chance)[^.\n]{0,40}%|%[^.\n]{0,40}(risk|probability|chance)/i;

const log = (...a: unknown[]) => console.error("[e2e:lionfish]", ...a);
function fail(message: string): never {
  throw new Error(message);
}
const check = (ok: boolean, what: string) => (ok ? "ok" : (log(`FAIL ${what}`), "fail"));

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
  log(`screenshot docs/evidence/${name}`);
}

async function newPage(browser: Browser, opts: { width?: number; height?: number; mobile?: boolean; light?: boolean; clockMs?: number } = {}): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    deviceScaleFactor: opts.mobile ? 2 : 1,
    isMobile: opts.mobile ?? false,
    hasTouch: opts.mobile ?? false,
  });
  if (opts.light) await context.addInitScript(() => localStorage.setItem("inversa:THEME", JSON.stringify("light")));
  const page = await context.newPage();
  await page.clock.setFixedTime(opts.clockMs ?? LIVE_MS);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, errors };
}

/** The HUD has its reports, heat, feeds and the live priority. */
async function ready(page: Page): Promise<void> {
  await page.locator('[data-testid="app-select-button"][data-app="lionfish"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.locator('[data-testid="lionfish-hud"][data-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
}

async function replayReady(page: Page): Promise<void> {
  await page.locator('[data-testid="lionfish-hud"][data-replay-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
}

async function cameraNear(page: Page, lat: number, lon: number, tol: number): Promise<boolean> {
  return page
    .waitForFunction(
      ({ lat, lon, tol }) => {
        const v = window.__inversa?.state("VIEW") as { lat: number; lon: number } | undefined;
        return !!v && Math.abs(v.lat - lat) < tol && Math.abs(v.lon - lon) < tol;
      },
      { lat, lon, tol },
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(async () => (log(`camera at ${JSON.stringify(await page.evaluate(() => window.__inversa?.state("VIEW")))}, wanted ${lat},${lon}`), false));
}

const count = (page: Page) => page.getAttribute('[data-testid="lionfish-count"]', "data-count").then(Number);
const canvas = (page: Page) => page.evaluate(() => ({ ...document.querySelector<HTMLCanvasElement>('[data-testid="lionfish-canvas"]')!.dataset }));
const asOf = (page: Page) => page.getAttribute('[data-testid="lionfish-overlay"]', "data-asof").then(Number);

/** Move the shared timeline's scrubber to `step` the way a drag does (an input event on the range). */
async function scrubTo(page: Page, step: number): Promise<void> {
  await page.evaluate((s) => {
    const r = document.querySelector<HTMLInputElement>("[data-hud-scrubber]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(s));
    r.dispatchEvent(new Event("input", { bubbles: true }));
  }, step);
}
const scrubMax = (page: Page) => page.getAttribute("[data-hud-scrubber]", "max").then(Number);
/** 15-minute steps (TIME_STEP_MINUTES). */
const STEPS_PER_DAY = 96;

async function openCard(page: Page, cell: string): Promise<void> {
  await page.click(`[data-cell-row="${cell}"]`);
  await page.locator(`[data-testid="lionfish-card"][data-cell="${cell}"] [data-testid="lionfish-components"]`).waitFor({ timeout: 30_000 });
}

const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);
const REGIONS = ['[data-testid="lionfish-panel"]', '[data-testid="lionfish-panel-tab"]', '[data-testid="lionfish-card-panel"]', '[data-testid="lionfish-help"]', '[data-testid="lionfish-overlay"]', '[data-testid="lionfish-chip"]', '[data-testid="lionfish-banner"]', '[data-testid="lionfish-asof"]'];

async function axe(page: Page): Promise<{ serious: string[]; critical: string[] }> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (regions) => {
    const axe = (window as unknown as { axe: { run: (ctx: object, opts: object) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const include = regions.filter((s) => document.querySelector(s)).map((s) => [s]);
    const res = await axe.run({ include }, { resultTypes: ["violations"] });
    const of = (impact: string) => res.violations.filter((v) => v.impact === impact).flatMap((v) => v.nodes.map((n) => `${v.id}@${n.target.join(" ")}`));
    return { serious: of("serious"), critical: of("critical") };
  }, REGIONS);
}

type Row = { id: string; source: string; observedAt: string; canonicalId: string | null; taxon: { focus: boolean } };
/** Independent focus reports observed in the 30 days before LIVE_MS, straight from the API (all four areas). */
async function apiIndependent(stack: Stack): Promise<{ independent: number; copies: number }> {
  let independent = 0;
  let copies = 0;
  for (const r of APP.regions) {
    const res = await stack.graphql<{ sightings: Row[] }>(`query($b: BBox!, $f: Time!, $t: Time!) { sightings(bbox: $b, from: $f, to: $t) { id source observedAt canonicalId taxon { focus } } }`, {
      b: r.bbox,
      f: new Date(LIVE_MS - 30 * DAY + 1).toISOString(),
      t: new Date(LIVE_MS).toISOString(),
    });
    for (const s of res.sightings) {
      if (!s.taxon.focus) continue;
      if (s.canonicalId) copies += 1;
      else independent += 1;
    }
  }
  return { independent, copies };
}

async function main(): Promise<void> {
  // The API's lionfish frame build can deadlock under rayon: `hotspot::lionfish::Index::{crw,marine}_nearest`
  // run `OnceLock::get_or_init(nearest_index)`, and `nearest_index` uses `par_chunks_mut` while the frames are
  // themselves built with `par_iter`, so a worker that steals a frame job blocks on the OnceLock it is still
  // initialising (0 % CPU, `backfill` never prints `frames: rebuilt`; seen 6 of 7 runs on 2026-10-01). One rayon
  // thread runs the same code sequentially. Remove once api/ fixes the init (owner: L5).
  process.env.RAYON_NUM_THREADS ??= "1";
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "lionfish", app: "lionfish", apps: ["lionfish"] });
  const origin = stack.origin;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

    // ---- G5 (part): the honesty banner on first load --------------------------------------------
    const { context, page, errors } = await newPage(browser);
    await page.goto(`${origin}/?app=lionfish`);
    await ready(page);
    const bannerText = await page.locator('[data-testid="lionfish-banner"]').innerText();
    const bannerFirst = bannerText.includes(APP.copy.sightingsNote!) && bannerText.includes(APP.copy.heatNote!) && bannerText.includes(APP.copy.priorityNote!);
    await shot(page, "lionfish-areas.png");

    // ---- G1: areas, layers, thin, duplicates, keyboard -------------------------------------------
    let areas = 0;
    for (const r of APP.regions) {
      await page.click(`[data-area="${r.id}"]`);
      const pressed = (await page.getAttribute(`[data-area="${r.id}"]`, "aria-pressed")) === "true";
      if (pressed && (await cameraNear(page, r.camera.lat, r.camera.lon, 0.3))) areas += 1;
    }
    await page.click(`[data-area="${APP.regions.at(-1)!.id}"]`); // off again: every area drawn
    const thinChips = await page.$$eval("[data-area][data-thin]", (els) => els.filter((e) => /Thin data/.test((e as HTMLElement).innerText)).map((e) => e.getAttribute("data-area")));
    await page.click('[data-area="belize"]');
    const sparse = await page.locator('[data-testid="lionfish-sparse"]').innerText().catch(() => "");
    const thinOk = thinChips.length === 2 && thinChips.includes("belize") && thinChips.includes("co-caribbean") && sparse.includes(APP.copy.thinAreaNote!) && /not no lionfish/.test(sparse);
    await page.click('[data-area="belize"]');
    const thin = thinOk ? thinChips.length : 0;
    if (!thinOk) log("thin", thinChips, sparse);

    // Layers: each toggle changes what is drawn, and back.
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
    const reportsLayer = await layerCheck("reports", () => page.locator('[data-kind="report"]').count());
    const priorityLayer = await layerCheck("priority", () => page.locator('[data-kind="cell"]').count());
    const heatLayer = await layerCheck("heat", async () => Number((await canvas(page)).heatOk ?? 0));
    const fieldLayer = await layerCheck("field", async () => Number((await canvas(page)).field ?? 0));
    const layers = check(reportsLayer && priorityLayer && heatLayer && fieldLayer, `layers reports=${reportsLayer} priority=${priorityLayer} heat=${heatLayer} field=${fieldLayer}`);

    // GBIF copies of iNat: drawn as marked rings, never counted (chip, area chips, total all agree with the API).
    const api = await apiIndependent(stack);
    const total = await count(page);
    const chipSum = (await page.$$eval("[data-area] small[data-count]", (els) => els.map((e) => Number(e.getAttribute("data-count"))))).reduce((a, b) => a + b, 0);
    const chip = await page.locator('[data-testid="lionfish-chip"]').innerText();
    const copyMarkers = await page.$$eval('[data-kind="report"][data-copy]', (els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    const dupOk = api.copies > 0 && copyMarkers.length === api.copies && copyMarkers.every((l) => /not counted/.test(l)) && total === api.independent && chipSum === total && chip.includes(`${total} report`);
    const duplicates = check(dupOk, `duplicates api=${JSON.stringify(api)} ui=${total} chips=${chipSum} copies=${copyMarkers.length} chip="${chip}"`);
    log(`reports: ${total} independent, ${api.copies} GBIF copies drawn and not counted`);

    // Keyboard: Enter on an area chip flies there; Space toggles a layer; Enter on a ranked place opens its card
    // with focus inside; Escape closes it and focus returns to the row.
    await page.focus('[data-area="mx-caribbean"]');
    await page.keyboard.press("Enter");
    const kbFly = await cameraNear(page, APP.regions[1]!.camera.lat, APP.regions[1]!.camera.lon, 0.3);
    await page.focus('input[data-layer="heat"]');
    await page.keyboard.press("Space");
    const kbLayer = !(await page.isChecked('input[data-layer="heat"]'));
    await page.keyboard.press("Space");
    const firstRow = await page.getAttribute("[data-cell-row]", "data-cell-row");
    await page.focus(`[data-cell-row="${firstRow}"]`);
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="lionfish-card"] [data-testid="lionfish-components"]').waitFor({ timeout: 30_000 });
    const kbInCard = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="lionfish-card-panel"]'));
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="lionfish-card-panel"]').waitFor({ state: "detached", timeout: 10_000 });
    const kbBack = await page.evaluate(() => document.activeElement?.getAttribute("data-cell-row"));
    const keyboard = check(kbFly && kbLayer && kbInCard && kbBack === firstRow, `keyboard fly=${kbFly} layer=${kbLayer} inCard=${kbInCard} back=${kbBack}`);
    console.log(`LIONFISH areas=${areas} layers=${layers} thin=${thin} duplicates=${duplicates} keyboard=${keyboard}`);
    await page.click('[data-area="mx-caribbean"]');

    // ---- G2: the priority evidence card --------------------------------------------------------
    await page.click('[data-area="fl-keys"]');
    const rows = await page.$$eval("[data-cell-row]", (els) => els.map((e) => e.getAttribute("data-cell-row")!));
    let heatCell: string | null = null;
    for (const cell of rows) {
      await openCard(page, cell);
      if (/°C-weeks/.test(await page.locator('[data-testid="lionfish-card-dhw"]').innerText())) {
        heatCell = cell;
        break;
      }
    }
    if (!heatCell) fail(`no Florida place with CRW heat among ${rows.join(", ")}`);
    const comps = await page.$$eval("[data-component]", (els) =>
      els.map((e) => ({ id: e.getAttribute("data-component"), state: e.getAttribute("data-state"), text: (e as HTMLElement).innerText, inputs: !!e.querySelector("details summary") })),
    );
    const compsOk = comps.length === 4 && comps.every((c) => /\d\.\d\d|unknown|stale/.test(c.text) && /ok|unknown|stale/.test(c.state ?? "") && c.inputs && c.text.length > 60);
    const dhw = await page.locator('[data-testid="lionfish-card-dhw"]').innerText();
    const baa = await page.locator('[data-testid="lionfish-card-baa"]').innerText();
    const credit = await page.locator('[data-testid="lionfish-card-credit"]').innerText();
    const heatBoth = check(/\d+\.\d+ °C-weeks/.test(dhw) && /level \d/.test(baa) && /Coral Reef Watch/i.test(credit), `heat dhw="${dhw}" baa="${baa}" credit="${credit}"`);
    const fieldSeparate = check(
      await page.evaluate(() => {
        const f = document.querySelector('[data-testid="lionfish-card-field"]');
        const grid = document.querySelector('[data-testid="lionfish-components"]');
        return !!f && !!grid && !grid.contains(f) && /not part of priority/i.test((f as HTMLElement).innerText) && ![...grid.querySelectorAll("[data-component]")].some((c) => /wave|current/i.test(c.getAttribute("data-component") ?? ""));
      }),
      "field window separate",
    );
    const links = await page.$$eval('[data-testid="lionfish-card"] a[href^="http"]', (els) => els.map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") ?? "", photo: a.hasAttribute("data-photo") })));
    const obsDates = await page.$$eval('[data-testid="lionfish-card-observations"] [data-evidence] .dates', (els) => els.map((e) => (e as HTMLElement).innerText));
    const linksOk = links.length > 0 && links.some((l) => l.photo) && links.every((l) => l.target === "_blank" && /noopener/.test(l.rel)) && obsDates.length > 0 && obsDates.every((d) => /observed \d{4}-\d\d-\d\d/.test(d) && /submitted (\d{4}-\d\d-\d\d|unknown)/.test(d));
    const linksNewTab = check(linksOk, `links ${JSON.stringify(links.slice(0, 4))} dates=${JSON.stringify(obsDates.slice(0, 2))}`);
    const caveats = await page.locator('[data-testid="lionfish-card-caveats"]').innerText();
    const bodyText = await page.evaluate(() => document.body.innerText);
    const noPercent = check(!RISK_PERCENT.test(bodyText) && /abundance/i.test(caveats), `no percent (caveats "${caveats.slice(0, 120)}")`);
    await shot(page, "lionfish-priority-card.png");
    console.log(`LIONFISH-CARD components=${compsOk ? comps.length : 0} heat_both=${heatBoth} field_separate=${fieldSeparate} links_new_tab=${linksNewTab} no_percent=${noPercent}`);
    await page.click('[data-testid="lionfish-card-panel"] button[aria-label="Close panel"]');

    // ---- G3: data quality ------------------------------------------------------------------------
    // Basis: the same window counted by observed and by submitted date, with the lag explanation.
    await page.click('[data-area="fl-keys"]'); // all areas again
    const byBasis: Record<string, number[]> = { observed: [], submitted: [] };
    for (const days of [7, 30, 90]) {
      await page.click(`[data-days="${days}"]`);
      for (const basis of ["observed", "submitted"]) {
        await page.click(`[data-basis="${basis}"]`);
        await page.waitForTimeout(150);
        byBasis[basis]!.push(await count(page));
      }
    }
    const lag = await page.locator('[data-testid="lionfish-lag"]').innerText();
    const basisToggle = check(byBasis.observed!.some((n, i) => n !== byBasis.submitted![i]) && /median lag was 5 days/.test(lag) && /24 of 74/.test(lag), `basis ${JSON.stringify(byBasis)} lag="${lag.slice(0, 160)}"`);
    log(`counts by window 7/30/90: observed ${byBasis.observed} submitted ${byBasis.submitted}`);
    // Late filter: only uploads more than 30 days after the dive, every drawn report marked late.
    await page.click('[data-days="90"]');
    await page.click('[data-basis="submitted"]');
    const allSubmitted = await count(page);
    await page.check('[data-testid="lionfish-late"]');
    await page.waitForTimeout(200);
    const lateCount = await count(page);
    const lateMarks = await page.$$eval('[data-kind="report"]', (els) => els.map((e) => e.hasAttribute("data-late")));
    const lateFilter = check(lateCount <= allSubmitted && lateMarks.every(Boolean) && (lateCount === 0 || lateMarks.length >= lateCount), `late ${lateCount}/${allSubmitted} marks=${lateMarks.length}`);
    log(`late filter: ${lateCount} of ${allSubmitted} reports submitted in 90 days were uploaded >30 days after the dive`);
    await page.uncheck('[data-testid="lionfish-late"]');
    await page.click('[data-basis="observed"]');
    await page.click('[data-days="30"]');
    // Buoy against satellite (Florida) and the feed chips.
    const sst = await page.locator('[data-testid="lionfish-sst-conflict"]').first();
    const sstText = await sst.innerText();
    const conflict = check((await sst.getAttribute("data-disagree")) !== "none" && /NDBC/.test(sstText) && /CRW/.test(sstText) && /not blended/.test(sstText), `sst "${sstText}"`);
    const feeds = await stack.graphql<{ feeds: { source: string; mode: string }[] }>("{ feeds { source mode } }");
    const chips = await page.$$eval("[data-feed]", (els) => els.map((e) => ({ source: e.getAttribute("data-feed"), mode: e.getAttribute("data-mode"), state: e.getAttribute("data-state") })));
    const chipsOk = check(
      chips.length === feeds.feeds.length && chips.every((c) => ["push", "webhook", "poll"].includes(c.mode ?? "") && !!c.state) && feeds.feeds.every((f) => chips.find((c) => c.source === f.source)?.mode === f.mode.toLowerCase()),
      `chips ${JSON.stringify(chips)}`,
    );
    await page.locator('[data-testid="lionfish-quality"]').scrollIntoViewIfNeeded();
    await shot(page, "lionfish-quality.png");
    // Missing: before the first CRW product the heat layer is hatched with words, never zero; a place with no CRW
    // within reach reads "unknown" on its card.
    await replayReady(page);
    const max = await scrubMax(page);
    await scrubTo(page, max - 5 * STEPS_PER_DAY);
    await page.waitForTimeout(500);
    const pastCanvas = await canvas(page);
    const missingWords = await page.$$eval("[data-heat-area]", (els) => els.map((e) => `${e.getAttribute("data-state")}:${(e as HTMLElement).innerText}`));
    await page.click('[data-testid="hud-live"]');
    await page.waitForTimeout(400);
    await page.click('[data-area="mx-caribbean"]');
    const mxRow = await page.getAttribute("[data-cell-row]", "data-cell-row");
    await openCard(page, mxRow!);
    const mxHeat = await page.locator('[data-testid="lionfish-card-heat"]').innerText();
    const mxComp = await page.getAttribute('[data-component="heatStress"]', "data-state");
    const missing = check(Number(pastCanvas.heatMissing) > 0 && Number(pastCanvas.heatOk) === 0 && missingWords.some((w) => /^missing:[\s\S]*no CRW product held/.test(w)) && /unknown, not zero/i.test(mxHeat) && mxComp === "unknown", `missing canvas=${JSON.stringify(pastCanvas)} words=${JSON.stringify(missingWords)} mx="${mxHeat.slice(0, 80)}" comp=${mxComp}`);
    await page.click('[data-testid="lionfish-card-panel"] button[aria-label="Close panel"]');
    await context.close();
    // Stale: the same product 90 h later.
    const stalePage = await newPage(browser, { clockMs: STALE_MS });
    await stalePage.page.goto(`${origin}/?app=lionfish`);
    await ready(stalePage.page);
    await stalePage.page.click('[data-testid="lionfish-banner-dismiss"]');
    await stalePage.page.click('[data-area="fl-keys"]');
    await stalePage.page.waitForTimeout(2500);
    const staleCanvas = await canvas(stalePage.page);
    const staleWords = await stalePage.page.$$eval("[data-heat-area]", (els) => els.map((e) => `${e.getAttribute("data-state")}:${(e as HTMLElement).innerText}`));
    const stale = check(Number(staleCanvas.heatStale) > 0 && Number(staleCanvas.heatOk) === 0 && staleWords.some((w) => /^stale:[\s\S]*older than 72 h/.test(w)), `stale canvas=${JSON.stringify(staleCanvas)} words=${JSON.stringify(staleWords)}`);
    await shot(stalePage.page, "lionfish-heat.png");
    await stalePage.context.close();
    console.log(`LIONFISH-QUALITY basis_toggle=${basisToggle} late_filter=${lateFilter} stale=${stale} missing=${missing} conflict=${conflict} chips=${chipsOk}`);

    // ---- G4: replay over the window ------------------------------------------------------------
    const rp = await newPage(browser);
    await rp.page.goto(`${origin}/?app=lionfish`);
    await ready(rp.page);
    await replayReady(rp.page);
    await rp.page.click('[data-testid="lionfish-banner-dismiss"]');
    await rp.page.click('[data-area="fl-keys"]');
    const liveAt = await asOf(rp.page);
    // Step: one key press goes back one step and labels what was known then.
    await rp.page.focus("[data-hud-scrubber]");
    await rp.page.keyboard.press("ArrowLeft");
    await rp.page.waitForTimeout(300);
    const stepAt = await asOf(rp.page);
    const label = await rp.page.locator('[data-testid="lionfish-asof"]').innerText().catch(() => "");
    const step = check(stepAt < liveAt && /Known at/.test(label), `step ${liveAt} -> ${stepAt} "${label}"`);
    // As of: 20 days back the priority snapshot is that day's, the reports are those known then, the label says so.
    const rmax = await scrubMax(rp.page);
    await scrubTo(rp.page, rmax - 20 * STEPS_PER_DAY);
    await rp.page.waitForTimeout(400);
    const pastAt = await asOf(rp.page);
    const pastLabel = await rp.page.locator('[data-testid="lionfish-asof"]').innerText();
    const snapAt = Date.parse((/Priority snapshot (\d{4}-\d\d-\d\d \d\d:\d\d)Z/.exec(pastLabel)?.[1] ?? "").replace(" ", "T") + ":00Z");
    const asof = check(/Known at/.test(pastLabel) && pastLabel.includes(APP.copy.replayNote!) && snapAt <= pastAt && pastAt - snapAt <= DAY, `asof "${pastLabel}" snap=${snapAt} at=${pastAt}`);
    await shot(rp.page, "lionfish-replay.png");
    // Scrub: 40 input events, time from the event to the overlay's new as-of; no request in between.
    let requests = 0;
    const onRequest = (r: { url(): string }) => {
      if (/\/v1\//.test(r.url())) requests += 1;
    };
    rp.page.on("request", onRequest);
    const wsFrames: string[] = [];
    rp.page.on("websocket", (ws) => ws.on("framesent", (f) => wsFrames.push(String(f.payload).slice(0, 80))));
    const sentBefore = wsFrames.length;
    const times: number[] = await rp.page.evaluate(async (max) => {
      const r = document.querySelector<HTMLInputElement>("[data-hud-scrubber]")!;
      const overlay = document.querySelector('[data-testid="lionfish-overlay"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        const target = max - 1 - Math.floor(((i * 37) % 29) * 96 + (i % 7) * 13);
        const before = overlay.getAttribute("data-asof");
        const t0 = performance.now();
        const done = new Promise<number>((resolve) => {
          const mo = new MutationObserver(() => {
            if (overlay.getAttribute("data-asof") !== before) {
              mo.disconnect();
              resolve(performance.now() - t0);
            }
          });
          mo.observe(overlay, { attributes: true, attributeFilter: ["data-asof"] });
          setTimeout(() => (mo.disconnect(), resolve(-1)), 2000);
        });
        setter.call(r, String(target));
        r.dispatchEvent(new Event("input", { bubbles: true }));
        out.push(await done);
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      }
      return out;
    }, rmax);
    await rp.page.waitForTimeout(300);
    rp.page.off("request", onRequest);
    const wsDuring = wsFrames.slice(sentBefore).filter((f) => /subscribe|query/.test(f));
    const measured = times.filter((t) => t >= 0).sort((a, b) => a - b);
    const median = measured.length ? measured[Math.floor(measured.length / 2)]! : -1;
    log(`scrub: ${measured.length}/40 measured, median ${median.toFixed(2)} ms, max ${measured.at(-1)?.toFixed(2)} ms; http ${requests}, ws ${wsDuring.length}`);
    // Play: the cursor moves forward and the overlay follows; pause stops it.
    await scrubTo(rp.page, rmax - 2 * STEPS_PER_DAY);
    await rp.page.waitForTimeout(200);
    const p0 = await asOf(rp.page);
    await rp.page.click('[data-testid="hud-play"]');
    await rp.page.waitForTimeout(2000);
    const p1 = await asOf(rp.page);
    await rp.page.click('[data-testid="hud-play"]');
    await rp.page.waitForTimeout(300);
    const p2 = await asOf(rp.page);
    await rp.page.waitForTimeout(600);
    const p3 = await asOf(rp.page);
    const play = check(p1 > p0 && p2 === p3, `play ${p0} -> ${p1}, paused ${p2} ${p3}`);
    console.log(`LIONFISH-REPLAY play=${play} step=${step} asof=${asof} scrub_median_ms=${median.toFixed(1)} requests=${requests + wsDuring.length}`);
    await rp.context.close();

    // ---- G5: ocean-data help and the banner per session ------------------------------------------
    const hp = await newPage(browser);
    await hp.page.goto(`${origin}/?app=lionfish`);
    await ready(hp.page);
    const bannerFresh = await hp.page.locator('[data-testid="lionfish-banner"]').isVisible();
    await hp.page.click('[data-testid="lionfish-banner-dismiss"]');
    const bannerGone = (await hp.page.locator('[data-testid="lionfish-banner"]').count()) === 0;
    await hp.page.reload();
    await ready(hp.page);
    const bannerStillGone = (await hp.page.locator('[data-testid="lionfish-banner"]').count()) === 0;
    const banner = check(bannerFirst && bannerFresh && bannerGone && bannerStillGone, `banner first=${bannerFirst} fresh=${bannerFresh} gone=${bannerGone} reload=${bannerStillGone}`);
    // From the HUD.
    await hp.page.click('[data-testid="lionfish-help-open"]');
    await hp.page.locator('[data-testid="lionfish-help"]').waitFor();
    const topicsList = await hp.page.$$eval("[data-help-topic]", (els) =>
      els.map((e) => ({
        id: e.getAttribute("data-help-topic"),
        limits: (e.querySelector("[data-help-limits]") as HTMLElement | null)?.innerText ?? "",
        links: [...e.querySelectorAll("[data-help-source] a")].map((a) => ({ target: a.getAttribute("target"), href: a.getAttribute("href") })),
      })),
    );
    const helpText = await hp.page.locator('[data-testid="lionfish-help"]').innerText();
    const wanted = ["SST", "anomaly", "DHW", "BAA", "Waves", "Currents"];
    const topics = topicsList.filter((t) => t.limits.length > 30 && t.links.length > 0).length;
    const sources = check(topicsList.every((t) => t.links.every((l) => l.target === "_blank" && /^https:/.test(l.href ?? ""))) && wanted.every((w) => helpText.includes(w)) && /can disagree/.test(helpText) && /why/i.test(helpText), `help ${JSON.stringify(topicsList.map((t) => [t.id, t.links.length, t.limits.length]))}`);
    await shot(hp.page, "lionfish-help.png");
    await hp.page.keyboard.press("Escape");
    // From the card: the guide opens on DHW.
    await hp.page.click('[data-area="fl-keys"]');
    const flRow = await hp.page.getAttribute("[data-cell-row]", "data-cell-row");
    await openCard(hp.page, flRow!);
    await hp.page.click('[data-testid="lionfish-card-help"]');
    const fromCard = (await hp.page.locator('[data-testid="lionfish-help"] [data-help-topic="dhw"][data-current]').count()) === 1;
    if (!fromCard) log("help from card did not open on DHW");
    await hp.page.keyboard.press("Escape");
    await hp.context.close();
    // A new session gets the banner again.
    const again = await newPage(browser);
    await again.page.goto(`${origin}/?app=lionfish`);
    await ready(again.page);
    const bannerNewSession = await again.page.locator('[data-testid="lionfish-banner"]').isVisible();
    await again.context.close();
    console.log(`LIONFISH-HELP topics=${fromCard ? topics : 0} sources=${sources} banner=${bannerNewSession ? banner : "fail"}`);

    // ---- G6: accessibility (dark and light), mobile, keyboard ------------------------------------
    const dark = await newPage(browser);
    await dark.page.goto(`${origin}/?app=lionfish`);
    await ready(dark.page);
    await dark.page.click('[data-area="fl-keys"]');
    const axeDark1 = await axe(dark.page);
    await openCard(dark.page, (await dark.page.getAttribute("[data-cell-row]", "data-cell-row"))!);
    const axeDark2 = await axe(dark.page);
    await dark.page.click('[data-testid="lionfish-card-help"]');
    const axeDark3 = await axe(dark.page);
    await dark.page.keyboard.press("Escape");
    // Keyboard path: chip → layer → place → card → guide → back.
    await dark.page.click('[data-testid="lionfish-card-panel"] button[aria-label="Close panel"]');
    await dark.page.focus('[data-area="belize"]');
    await dark.page.keyboard.press("Enter");
    const k1 = (await dark.page.getAttribute('[data-area="belize"]', "aria-pressed")) === "true";
    await dark.page.keyboard.press("Enter");
    await dark.page.focus('input[data-layer="field"]');
    await dark.page.keyboard.press("Space");
    const k2 = await dark.page.isChecked('input[data-layer="field"]');
    await dark.page.keyboard.press("Space");
    const row = (await dark.page.getAttribute("[data-cell-row]", "data-cell-row"))!;
    await dark.page.focus(`[data-cell-row="${row}"]`);
    await dark.page.keyboard.press("Enter");
    await dark.page.locator('[data-testid="lionfish-card"] [data-testid="lionfish-components"]').waitFor({ timeout: 30_000 });
    await dark.page.focus('[data-testid="lionfish-card-help"]');
    await dark.page.keyboard.press("Enter");
    const k3 = await dark.page.evaluate(() => !!document.activeElement?.closest('[data-testid="lionfish-help"]'));
    await dark.page.keyboard.press("Escape");
    const k4 = await dark.page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "lionfish-card-help");
    await dark.page.keyboard.press("Escape");
    await dark.page.locator('[data-testid="lionfish-card-panel"]').waitFor({ state: "detached", timeout: 10_000 });
    const k5 = await dark.page.evaluate((r) => document.activeElement?.getAttribute("data-cell-row") === r, row);
    const keyboardA11y = check(k1 && k2 && k3 && k4 && k5, `a11y keyboard area=${k1} layer=${k2} help=${k3} back=${k4} row=${k5}`);
    await dark.context.close();

    const light = await newPage(browser, { light: true });
    await light.page.goto(`${origin}/?app=lionfish`);
    await ready(light.page);
    if ((await light.page.evaluate(() => document.documentElement.dataset.theme)) !== "light") fail("light theme not applied");
    await light.page.click('[data-area="fl-keys"]');
    await openCard(light.page, (await light.page.getAttribute("[data-cell-row]", "data-cell-row"))!);
    const axeLight = await axe(light.page);
    await shot(light.page, "lionfish-light.png");
    await light.context.close();

    const phone = await newPage(browser, { width: 375, height: 812, mobile: true });
    await phone.page.goto(`${origin}/?app=lionfish`);
    await ready(phone.page);
    const hscroll = async () => phone.page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth));
    const h1 = await hscroll();
    await phone.page.click('[data-testid="lionfish-panel-tab"]');
    await phone.page.locator('[data-testid="lionfish-panel"]').waitFor();
    const h2 = await hscroll();
    const axePhone = await axe(phone.page);
    await shot(phone.page, "lionfish-mobile.png");
    await phone.page.click('[data-area="fl-keys"]');
    await phone.page.click('[data-testid="lionfish-panel-tab"]');
    const phoneRow = (await phone.page.getAttribute("[data-cell-row]", "data-cell-row"))!;
    await openCard(phone.page, phoneRow);
    const h3 = await hscroll();
    await phone.context.close();

    const all = [axeDark1, axeDark2, axeDark3, axeLight, axePhone];
    const serious = [...new Set(all.flatMap((a) => a.serious))];
    const critical = [...new Set(all.flatMap((a) => a.critical))];
    if (serious.length || critical.length) log("axe", JSON.stringify({ serious, critical }));
    console.log(`LIONFISH-A11Y serious=${serious.length} critical=${critical.length} mobile_hscroll=${h1 + h2 + h3} keyboard=${keyboardA11y}`);
    if (errors.length) log("page errors", errors.slice(0, 5));
  } catch (err) {
    console.error(err);
    console.error(stack.logs());
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await stack.stop();
  }
}

await main();
