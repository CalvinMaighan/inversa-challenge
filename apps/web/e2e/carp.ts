/**
 * Leaf UC e2e: the carp UI (Louisiana field conditions) on the real stack (e2e/stack.ts: Axum over a temp data dir
 * filled by `backfill --fixtures --app carp`, the production e2e build, the signal Worker and the Caddy-like
 * proxy). Everything is driven through the UI and the URL; `window.__inversa` is only read (camera position).
 *
 *   bun run e2e:carp             build, run, print the CARP lines
 *   E2E_SKIP_BUILD=1 …           reuse the last e2e build
 *
 * The fixtures were recorded 2026-10-01T07:01Z and the pollers are off, so what is "live" depends on when this
 * runs; every check below holds at any run time. The stale phase sets the page clock 12 h past the wall clock, so
 * every observation is older than 6 h whatever day it is.
 *
 * Lines:
 *   CARP sites=8 board=ok briefing=ok presets=2 keyboard=ok
 *   CARP-TIMELINE series=ok thresholds=ok coverage_marker=ok conflict_chip=ok scrub_median_ms=<n>
 *   CARP-ASOF forecast_swap=ok later_obs=ok board_asof=ok label=ok exit=ok
 *   CARP-EVIDENCE drawer=ok new_tab=ok stale=ok missing=ok cannot_assess=ok boundary=ok
 *   CARP-A11Y serious=<n> critical=<n> mobile_hscroll=<n> keyboard=ok
 * Screenshots: docs/evidence/carp-{board,timeline,asof,drawer,mobile,light}.png
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { frameSites, sitesOf } from "../client/carp/model";
import { getApp } from "../shared/apps";
import { APP_DIR, buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
const LOAD_TIMEOUT_MS = 120_000;
const SITES = ["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"];
const STATUSES = ["review", "ok", "cannot_assess"];
const FORBIDDEN = /\b(python|tegu|iguana|lionfish|everglades)\b/i;
/** A past as-of inside the fixtures' archive: the forecast in force is the IEM copy of the 09-28 issuance. */
const PAST_ASOF = "2026-09-28T18:00Z";

const log = (...a: unknown[]) => console.error("[e2e:carp]", ...a);
function fail(message: string): never {
  throw new Error(message);
}
const check = (ok: boolean, what: string) => (ok ? "ok" : (log(`FAIL ${what}`), `fail`));

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
  log(`screenshot docs/evidence/${name}`);
}

async function ready(page: Page): Promise<void> {
  await page.locator('[data-testid="app-select-button"][data-app="carp"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-carp-row]").length === n && [...document.querySelectorAll("[data-carp-site]")].every((m) => m.getAttribute("data-status") !== "loading"),
    SITES.length,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

/** The drawer shows `lid` with its briefing loaded and the chart drawn from loaded data. */
async function siteLoaded(page: Page, lid: string): Promise<void> {
  await page.locator(`[data-testid="carp-drawer"][data-site="${lid}"] [data-testid="carp-changed"]`).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]');
    return !!c && c.dataset.message === "" && /forecast:[1-9]/.test(c.dataset.series ?? "");
  }, undefined, { timeout: 30_000 });
}

async function view(page: Page): Promise<{ lat: number; lon: number }> {
  return (await page.evaluate(() => window.__inversa?.state("VIEW"))) as { lat: number; lon: number };
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
    .catch(async () => (log(`camera at ${JSON.stringify(await view(page))}, wanted ${lat},${lon}`), false));
}

const chart = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')!;
    return { ...c.dataset };
  });

const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);
const CARP_REGIONS = ['[data-testid="carp-board-panel"]', '[data-testid="carp-drawer-panel"]', '[data-testid="carp-timeline"]', '[data-testid="carp-markers"]', '[data-testid="carp-board-panel-tab"]'];

/** axe-core over the carp surfaces present: serious and critical violations as `rule@target`. */
async function axeCarp(page: Page): Promise<{ serious: string[]; critical: string[] }> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (regions) => {
    const axe = (window as unknown as { axe: { run: (ctx: object, opts: object) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const include = regions.filter((s) => document.querySelector(s)).map((s) => [s]);
    const res = await axe.run({ include }, { resultTypes: ["violations"] });
    const of = (impact: string) => res.violations.filter((v) => v.impact === impact).flatMap((v) => v.nodes.map((n) => `${v.id}@${n.target.join(" ")}`));
    return { serious: of("serious"), critical: of("critical") };
  }, CARP_REGIONS);
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
  if (opts.clockMs !== undefined) await page.clock.setFixedTime(opts.clockMs);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, errors };
}

async function main(): Promise<void> {
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "carp", app: "carp", apps: ["carp"] });
  const origin = stack.origin;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

    // ---- G1: markers, board, briefing, presets, keyboard ------------------------------------------
    const { page, errors } = await newPage(browser);
    await page.goto(`${origin}/?app=carp`);
    await ready(page);
    const markers = await page.$$eval("[data-carp-site]", (els) =>
      els.map((el) => ({
        lid: el.getAttribute("data-carp-site"),
        status: el.getAttribute("data-status"),
        glyph: el.querySelector("[data-glyph]")?.getAttribute("data-glyph"),
        ring: el.querySelector("[data-ring]")?.getAttribute("data-ring"),
        label: el.getAttribute("aria-label") ?? "",
        hidden: el.hasAttribute("data-hidden"),
      })),
    );
    const markersOk =
      markers.length === SITES.length &&
      SITES.every((lid) => markers.some((m) => m.lid === lid)) &&
      markers.every((m) => STATUSES.includes(m.status ?? "") && m.glyph === m.status && !!m.ring && /:/.test(m.label) && !m.hidden);
    if (!markersOk) log("markers", JSON.stringify(markers));
    // Tooltip on hover.
    await page.hover('[data-carp-site="BTRL1"]');
    const tipVisible = await page.$eval('[data-carp-site="BTRL1"] .tip', (el) => getComputedStyle(el).visibility === "visible" && (el as HTMLElement).innerText.includes("Baton Rouge"));
    const sitesCount = markersOk && tipVisible ? markers.length : 0;
    log(`statuses: ${markers.map((m) => `${m.lid}=${m.status}/${m.ring}`).join(" ")}`);

    const rows = await page.$$eval("[data-carp-row]", (els) => els.map((el) => ({ lid: el.getAttribute("data-carp-row"), status: el.getAttribute("data-status") ?? "", reasons: el.querySelectorAll("li").length, text: (el as HTMLElement).innerText })));
    const rank = (s: string) => ({ review: 0, cannot_assess: 1, ok: 2 })[s] ?? 9;
    const sorted = rows.every((r, i) => i === 0 || rank(rows[i - 1]!.status) <= rank(r.status));
    const boardOk = rows.length === 8 && sorted && rows.every((r) => r.reasons > 0 && (r.status !== "review" || /reach|moved|rose|fell|alert|at /.test(r.text)));
    const board = check(boardOk, `board ${JSON.stringify(rows.map((r) => [r.lid, r.status, r.reasons]))}`);
    const noSiteMessage = (await chart(page)).message ?? "";
    await shot(page, "carp-board.png");

    // Click a board row: the drawer opens on its briefing and the camera flies there.
    await page.click('[data-carp-row="MCGL1"]');
    await siteLoaded(page, "MCGL1");
    const flew = await cameraNear(page, 29.6964, -91.2108, 0.05);
    const briefingText = await page.locator('[data-testid="carp-briefing"]').innerText();
    const briefingOk = flew && /What changed/i.test(briefingText) && /What is expected/i.test(briefingText) && /What is missing/i.test(briefingText) && /ft/.test(briefingText);
    const briefing = check(briefingOk, `briefing (flew=${flew}): ${briefingText.slice(0, 200)}`);
    await shot(page, "carp-drawer.png");

    // Presets: Atchafalaya frames its four sites, All sites the eight.
    const presetButtons = await page.locator("[data-carp-preset]").count();
    const carpSites = sitesOf(getApp("carp").locations);
    const basin = frameSites(carpSites.filter((s) => getApp("carp").cameraPresets?.find((p) => p.id === "atchafalaya")?.locations?.includes(s.id)));
    const whole = frameSites(carpSites);
    await page.click('[data-carp-preset="atchafalaya"]');
    const atch = await cameraNear(page, basin.lat, basin.lon, 0.1);
    await page.click('[data-carp-preset="all-sites"]');
    const all = await cameraNear(page, whole.lat, whole.lon, 0.1);
    const presets = atch && all ? presetButtons : 0;

    // Keyboard: Enter on a board row opens it, Escape closes the drawer and focus returns to the row; Enter on a
    // marker opens its site; arrow keys on the timeline go back in time, End returns to live.
    await page.click('[data-testid="carp-drawer-panel"] button[aria-label="Close panel"]');
    await page.locator('[data-testid="carp-drawer"]').waitFor({ state: "detached", timeout: 10_000 });
    await page.focus('[data-carp-row="BTRL1"]');
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="carp-drawer"][data-site="BTRL1"]').waitFor({ timeout: 10_000 });
    const focusInPanel = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="carp-drawer-panel"]'));
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="carp-drawer"]').waitFor({ state: "detached", timeout: 10_000 });
    const focusBack = await page.evaluate(() => document.activeElement?.getAttribute("data-carp-row"));
    await page.focus('[data-carp-site="AEXL1"]');
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="carp-drawer"][data-site="AEXL1"]').waitFor({ timeout: 10_000 });
    await page.focus("[data-carp-scrubber]");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("PageDown");
    const keyAsof = await page.getAttribute('[data-testid="carp-timeline"]', "data-mode");
    await page.keyboard.press("End");
    const keyLive = await page.getAttribute('[data-testid="carp-timeline"]', "data-mode");
    const keyboardOk = focusInPanel && focusBack === "BTRL1" && keyAsof === "asof" && keyLive === "live";
    const keyboard = check(keyboardOk, `keyboard focusInPanel=${focusInPanel} back=${focusBack} asof=${keyAsof} live=${keyLive}`);
    console.log(`CARP sites=${sitesCount} board=${board} briefing=${briefing} presets=${presets} keyboard=${keyboard}`);

    // ---- G2: timeline ---------------------------------------------------------------------------
    await page.click('[data-carp-row="KRZL1"]');
    await siteLoaded(page, "KRZL1");
    // NWPS observations arrive with the verification pairs, after the forecast.
    await page.waitForFunction(() => /nwps:[1-9]/.test(document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')?.dataset.series ?? ""), undefined, { timeout: 20_000 }).catch(() => {});
    const k = await chart(page);
    log(`KRZL1 chart ${JSON.stringify(k)}`);
    const series = /usgs:[1-9]/.test(k.series ?? "") && /nwps:[1-9]/.test(k.series ?? "") && /forecast:[1-9]/.test(k.series ?? "") && /spread:[1-9]/.test(k.series ?? "");
    const legend = await page.locator('[data-testid="carp-legend"]').innerText();
    const datumNote = /USGS gauge height \(USGS datum\)/.test(legend) && /flood datum/.test(legend);
    const flowKrz = await page.locator('[data-testid="carp-flow"]').innerText();
    // Monroe: two flows that disagree, each with its source.
    await page.click('[data-carp-row="MLUL1"]');
    await siteLoaded(page, "MLUL1");
    const flowMlu = await page.locator('[data-testid="carp-flow"]').innerText();
    const flowChip = await page.locator('[data-testid="carp-conflict-chip"][data-kind="flow"]').count();
    const discharge = /Not measured at this gauge/.test(flowKrz) && /cfs/.test(flowMlu) && /USGS discharge/.test(flowMlu) && /NWS estimate/.test(flowMlu) && /not blended/.test(flowMlu);
    // Play replays forward; pause stops.
    await page.click('[data-testid="carp-play"]');
    await page.waitForTimeout(150);
    const c0 = Number((await chart(page)).cursor);
    await page.waitForTimeout(1_200);
    const c1 = Number((await chart(page)).cursor);
    await page.click('[data-testid="carp-play"]');
    await page.waitForTimeout(400);
    const c2 = Number((await chart(page)).cursor);
    await page.waitForTimeout(500);
    const c3 = Number((await chart(page)).cursor);
    const played = c1 - c0 >= 3 * 3_600_000 && c2 === c3;
    await page.click('[data-testid="carp-live"]');
    log(`series=${series} datum=${datumNote} discharge=${discharge} played=${played} (${(c1 - c0) / 3_600_000} h) flowKRZ="${flowKrz}" flowMLU="${flowMlu}"`);
    const seriesOk = check(series && datumNote && discharge && played, "series");

    // Thresholds: MCGL1's action (4 ft) sits inside its chart; KRZL1's 28 ft is named as above the chart.
    await page.click('[data-carp-row="MCGL1"]');
    await siteLoaded(page, "MCGL1");
    const m = await chart(page);
    const [drawnTh] = (m.thresholds ?? "0/0").split("/").map(Number);
    await page.click('[data-carp-row="KRZL1"]');
    await siteLoaded(page, "KRZL1");
    const off = await page.locator('[data-testid="carp-offchart"]').innerText().catch(() => "");
    const thresholds = check((drawnTh ?? 0) >= 1 && /Action 28 ft is .* above the chart/.test(off), `thresholds mcgl1=${m.thresholds} krzl1="${off}"`);
    const kk = await chart(page);
    const coverage = check(kk.coverage === "marker" || kk.coverage === "note", `coverage ${kk.coverage}`);
    // KRZL1: USGS and NWPS stage on different datums: the chip explains it.
    const stageChip = page.locator('[data-testid="carp-conflict-chip"][data-kind="stage"]');
    await stageChip.locator("summary").click();
    const chipText = await stageChip.locator("p").innerText();
    const conflict = check(flowChip === 1 && /datum/.test(chipText) && /NWPS stage only/.test(chipText), `conflict flow=${flowChip} text="${chipText}"`);
    await shot(page, "carp-timeline.png");
    await stageChip.locator("summary").click();

    // Scrub latency: input event to the canvas repainted at the new cursor, in the same task.
    const scrub = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>("[data-carp-scrubber]")!;
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      const max = Number(input.max);
      const times: number[] = [];
      let repainted = 0;
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 4 + Math.random() * 12));
        const v = Math.round(max * 0.15 + (i * max * 0.3) / 80);
        const before = canvas.dataset.cursor;
        const t0 = performance.now();
        setValue.call(input, String(v));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const t1 = performance.now();
        if (canvas.dataset.cursor !== before) repainted += 1;
        times.push(t1 - t0);
      }
      times.sort((a, b) => a - b);
      return { median: times[times.length >> 1]!, p95: times[Math.floor(times.length * 0.95)]!, repainted, n: times.length };
    });
    log(`scrub: median ${scrub.median.toFixed(2)} ms, p95 ${scrub.p95.toFixed(2)} ms, repainted ${scrub.repainted}/${scrub.n}`);
    const scrubMs = scrub.repainted >= scrub.n - 2 ? scrub.median.toFixed(2) : "999";
    await page.click('[data-testid="carp-live"]');
    console.log(`CARP-TIMELINE series=${seriesOk} thresholds=${thresholds} coverage_marker=${coverage} conflict_chip=${conflict} scrub_median_ms=${scrubMs}`);

    // ---- G3: what we knew ------------------------------------------------------------------------
    await page.waitForFunction(() => document.querySelector('[data-testid="carp-timeline"]')?.getAttribute("data-mode") === "live");
    const liveIssued = await page.locator('[data-testid="carp-issued"]').innerText();
    const liveSource = await page.getAttribute('[data-testid="carp-forecast-source"]', "data-source");
    const liveRows = await page.$$eval("[data-carp-row]", (els) => els.map((el) => `${el.getAttribute("data-carp-row")}:${el.getAttribute("data-status")}:${(el as HTMLElement).innerText.length}`).join(","));
    // A past time by link (the URL is UI): the 09-28 forecast is in force then.
    await page.goto(`${origin}/?app=carp#v=2&app=carp&site=KRZL1&asof=${PAST_ASOF}`);
    await ready(page);
    await siteLoaded(page, "KRZL1");
    const asofMs = Date.parse(PAST_ASOF.replace("Z", ":00Z"));
    await page.waitForFunction((t) => document.querySelector('[data-testid="carp-board"]')?.getAttribute("data-reviewed-at") === String(t), asofMs, { timeout: 30_000 });
    const pastIssued = await page.locator('[data-testid="carp-issued"]').innerText();
    const pastSource = await page.getAttribute('[data-testid="carp-forecast-source"]', "data-source");
    const issuedIso = await page.evaluate(() => document.querySelector('[data-testid="carp-forecast-issued"]')?.textContent ?? "");
    const issuedUtc = /\((\d{4}-\d\d-\d\d \d\d:\d\d)Z\)/.exec(issuedIso)?.[1];
    const issuedBefore = issuedUtc ? Date.parse(`${issuedUtc.replace(" ", "T")}:00Z`) <= asofMs : false;
    const forecastSwap = check(pastIssued !== liveIssued && pastSource === "IEM_ARCHIVE" && issuedBefore, `swap live=${liveIssued}/${liveSource} past=${pastIssued}/${pastSource} issued=${issuedUtc}`);
    const p = await chart(page);
    const laterLegend = await page.locator('[data-testid="carp-later-legend"]').count();
    const laterObs = check(Number(p.later) > 0 && laterLegend === 1 && Number(p.cursor) === asofMs, `later ${JSON.stringify(p)}`);
    const boardAsof = await page.getAttribute('[data-testid="carp-board"]', "data-asof");
    const asofNote = await page.locator('[data-testid="carp-board-asof"]').innerText();
    const pastRows = await page.$$eval("[data-carp-row]", (els) => els.map((el) => `${el.getAttribute("data-carp-row")}:${el.getAttribute("data-status")}:${(el as HTMLElement).innerText.length}`).join(","));
    const boardAsofOk = check(boardAsof === String(asofMs) && /Statuses as known at Sep 28/.test(asofNote) && pastRows !== liveRows, `board asof=${boardAsof} note="${asofNote}"`);
    const label = await page.locator('[data-testid="carp-asof-label"]').innerText();
    const labelOk = check(/What we knew at Sep 28, 1:00 PM CDT/.test(label) && /forecast issued Sep 2[78]/.test(label) && /IEM archive/.test(label), `label "${label}"`);
    await shot(page, "carp-asof.png");
    // "What we knew yesterday afternoon": 3 PM Central the day before today.
    await page.click('[data-testid="carp-yesterday"]');
    await page.waitForFunction(() => /What we knew at .* 3:00 PM C[DS]T/.test(document.querySelector('[data-testid="carp-asof-label"]')?.textContent ?? ""), undefined, { timeout: 10_000 });
    // Back to live.
    await page.click('[data-testid="carp-live"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="carp-timeline"]')?.getAttribute("data-mode") === "live" && document.querySelector('[data-testid="carp-board"]')?.getAttribute("data-asof") === "live");
    await siteLoaded(page, "KRZL1");
    await page.waitForTimeout(600);
    const exitIssued = await page.locator('[data-testid="carp-issued"]').innerText();
    const hash = new URL(page.url()).hash;
    const exit = check(exitIssued === liveIssued && !hash.includes("asof") && (await page.locator('[data-testid="carp-later-legend"]').count()) === 0, `exit issued=${exitIssued} hash=${hash}`);
    console.log(`CARP-ASOF forecast_swap=${forecastSwap} later_obs=${laterObs} board_asof=${boardAsofOk} label=${labelOk} exit=${exit}`);

    // ---- G4: evidence and honesty -----------------------------------------------------------------
    // textContent: labels are upper-cased by CSS, which innerText would report.
    const drawerText = (await page.locator('[data-testid="carp-drawer"]').textContent()) ?? "";
    const drawerOk = check(
      /NWPS stage[\s\S]*ft[\s\S]*C[DS]T/.test(drawerText) && /USGS gauge height[\s\S]*ft/.test(drawerText) && /Issued[\s\S]*C[DS]T/.test(drawerText) && /Action[\s\S]*28(\.0)? ft/.test(drawerText) && /(No active NWS alerts|until)/.test(drawerText),
      `drawer text: ${drawerText.slice(0, 400)}`,
    );
    const links = await page.$$eval('[data-testid="carp-drawer"] a[href^="http"]', (els) => els.map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") ?? "" })));
    const newTab = check(links.length >= 3 && links.every((l) => l.target === "_blank" && /noopener/.test(l.rel)), `links ${JSON.stringify(links)}`);
    const missing = check(/Flow\s*Not measured at this gauge/.test(drawerText.replace(/\n/g, " ")) || /Not measured at this gauge/.test(drawerText), "missing flow words");
    const boundaryText = await page.locator('[data-testid="carp-boundary"]').innerText();
    const bodyText = await page.evaluate(() => document.body.innerText);
    const forbidden = FORBIDDEN.exec(bodyText)?.[0];
    if (forbidden) log(`forbidden word on the carp page: ${forbidden}`);
    const boundary = check(/cannot establish carp abundance, expected catch, legal access or trip safety/.test(boundaryText) && /Demonstration locations/.test(boundaryText) && /Atchafalaya/.test(boundaryText) && !forbidden, `boundary "${boundaryText}"`);
    const noSite = /Select a location/.test(noSiteMessage);

    // Stale: the page clock 12 h past the wall clock; every observation is then older than 6 h.
    const stalePage = await newPage(browser, { clockMs: Date.now() + 12 * 3_600_000 });
    await stalePage.page.goto(`${origin}/?app=carp#v=2&app=carp&site=SMML1`);
    await ready(stalePage.page);
    await siteLoaded(stalePage.page, "SMML1");
    const staleRows = await stalePage.page.$$eval("[data-carp-row]", (els) => els.map((el) => ({ status: el.getAttribute("data-status"), rules: [...el.querySelectorAll("li[data-rule]")].map((li) => li.getAttribute("data-rule")), text: (el as HTMLElement).innerText })));
    const staleRings = await stalePage.page.$$eval("[data-carp-site]", (els) => els.map((el) => el.getAttribute("data-freshness")));
    const staleMissing = await stalePage.page.locator('[data-testid="carp-missing"]').innerText();
    const stale = check(staleRows.every((r) => r.rules.includes("stale_observation") && /stale after 6 h/.test(r.text)) && staleRings.every((f) => f === "stale") && /stale after 6 h/.test(staleMissing), `stale ${JSON.stringify(staleRows.map((r) => r.rules))} rings=${staleRings}`);
    const cannot = staleRows.filter((r) => r.status === "cannot_assess");
    const cannotAssess = check(cannot.length >= 1 && cannot.every((r) => /Cannot assess/i.test(r.text) && r.rules.length > 0), `cannot_assess ${cannot.length}`);
    await stalePage.context.close();
    console.log(`CARP-EVIDENCE drawer=${drawerOk} new_tab=${newTab} stale=${stale} missing=${missing} cannot_assess=${cannotAssess} boundary=${noSite ? boundary : check(false, `empty chart message "${noSiteMessage}"`)}`);

    // ---- G5: accessibility, mobile, keyboard -------------------------------------------------------
    await page.click('[data-carp-row="MCGL1"]');
    await siteLoaded(page, "MCGL1");
    const axeDark = await axeCarp(page);
    const light = await newPage(browser, { light: true });
    await light.page.goto(`${origin}/?app=carp#v=2&app=carp&site=MCGL1`);
    await ready(light.page);
    await siteLoaded(light.page, "MCGL1");
    if ((await light.page.evaluate(() => document.documentElement.dataset.theme)) !== "light") fail("light theme not applied");
    const axeLight = await axeCarp(light.page);
    await shot(light.page, "carp-light.png");
    await light.context.close();

    const phone = await newPage(browser, { width: 375, height: 812, mobile: true });
    await phone.page.goto(`${origin}/?app=carp`);
    await phone.page.locator('[data-testid="carp-board-panel-tab"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
    await phone.page.click('[data-testid="carp-board-panel-tab"]');
    await ready(phone.page);
    const hscroll = await phone.page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth));
    const sheet = await phone.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="carp-board-panel"]')!.getBoundingClientRect();
      const pane = document.querySelector('[data-slot="globe-pane"]')!.getBoundingClientRect();
      return { left: panel.left, right: panel.right, bottom: panel.bottom, paneBottom: pane.bottom, paneRight: pane.right };
    });
    const bottomSheet = Math.abs(sheet.bottom - sheet.paneBottom) <= 2 && sheet.left <= 1 && Math.abs(sheet.right - sheet.paneRight) <= 1;
    const axePhone = await axeCarp(phone.page);
    await shot(phone.page, "carp-mobile.png");
    // On a phone, choosing a site closes the sheet and opens the briefing.
    await phone.page.click('[data-carp-row="KRZL1"]');
    await phone.page.locator('[data-testid="carp-drawer"][data-site="KRZL1"]').waitFor({ timeout: 20_000 });
    const phoneHscroll2 = await phone.page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    await phone.context.close();

    const serious = [...axeDark.serious, ...axeLight.serious, ...axePhone.serious];
    const critical = [...axeDark.critical, ...axeLight.critical, ...axePhone.critical];
    if (serious.length || critical.length) log(`axe: ${[...serious, ...critical].join(", ")}`);
    if (!bottomSheet) log(`phone board is not a bottom sheet: ${JSON.stringify(sheet)}`);
    console.log(`CARP-A11Y serious=${serious.length} critical=${critical.length} mobile_hscroll=${bottomSheet ? hscroll + phoneHscroll2 : "sheet"} keyboard=${keyboard}`);
    if (errors.length) log(`page errors: ${errors.slice(0, 5).join(" | ")}`);
  } catch (err) {
    log(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    log(stack.logs());
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await stack.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
