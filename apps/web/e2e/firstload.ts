/**
 * T41 e2e: what a newcomer sees at first load, on the real stack (e2e/stack.ts: Axum with the fixture backfill,
 * `next start`, the signal Worker and a Caddy-like proxy, all on free ports), 1440×900 at the live edge.
 *
 *   bun run e2e:firstload            build, run, print the SIMPLIFY, CHROME, ATTRIBUTION, POPOVERS and FIRSTLOAD lines
 *   bun run e2e:firstload --before   only measure and save docs/evidence/simplify-before.png (run on a build of
 *                                    the code before T41)
 *   E2E_SKIP_BUILD=1 …               reuse the last e2e build
 *   bun run e2e:firstload --app <id> --evidence-shots
 *                                    also save the rubric's per-app shots: docs/evidence/<id>-desktop.png (the load
 *                                    view at 1440×900) and docs/evidence/mobile/<id>-375.png (a fresh 375×812 load)
 *
 * 1. Clutter at load: interactive controls and elements with their own visible text, in the globe pane and on
 *    the whole page (text drawn on canvases is not counted). `SIMPLIFY pane_controls=… page_labels=…`.
 * 2. What the app draws at load (records), per kind of app:
 *    - species (python): only sightings on the globe. Stations, alerts and hotspots draw nothing, and the
 *      sightings layer draws exactly the distinct (non-duplicate) sightings of the app's species Axum holds for the
 *      same window of frames (the app's default window). records = the sightings drawn.
 *    - survey (lionfish): the app draws its reports itself (client/lionfish); records = its report markers, and
 *      the EVF sightings layer, stations and alerts draw nothing.
 *    - conditions (carp): no sightings layer and no frames; neither sightings nor hotspots may draw. records = its
 *      site markers drawn with a loaded review status, which must be the sites Axum's review board lists.
 * 3. No always-visible top bar text: the chrome is two icon buttons. `CHROME icons=2 visible_text_labels=0`.
 * 4. The globe's data attribution is clickable (the element at its centre is the link). `ATTRIBUTION clickable=1`.
 * 5. Both popovers open from their buttons and Esc hands focus back. `POPOVERS about=ok theme=ok`.
 *
 * Last line (docs/grading/rubric.json three-apps/firstload), always printed, with step 2's details after it:
 *
 *   FIRSTLOAD app=<id> records=<n> errors=<n> kind=<species|survey|conditions> …
 *
 * errors = page errors plus console errors from load to the end of the run, counted (not failed on at once). The
 * exit code is 1 when a step failed, errors > 0 or records < 1.
 *
 * Screenshots: docs/evidence/simplify-after.png (load), simplify-welcome.png (welcome plus a species chip's
 * description), simplify-popover.png (About open); for another app than python the names end in `-<app>`.
 *
 * Apps (PLAN.md C-A1): `--app <id>` (default python, whose data the fixtures are) runs it in that app, its data dir
 * filled by `backfill --fixtures --app <id>`, the region and the species from its config.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { isSurveyApp } from "../client/lionfish/model";
import { appBBox, getApp, type AppId } from "../shared/apps";
import { appArg } from "./args";
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
const APP: AppId = appArg();
const CLOCK = APP === "python" ? PYTHON_CLOCK : FIXTURE_CLOCK;
const CONFIG = getApp(APP);
const SPECIES_APP = CONFIG.kind === "species";
/** A survey app (Lionfish Watch) draws its reports itself (client/lionfish), not through the EVF sightings layer. */
const SURVEY_APP = isSurveyApp(CONFIG);
const REPORTS = '[data-kind="report"]:not([data-copy])';
/** Carp's site markers (client/carp/SiteMarkers). */
const CARP_SITES = "[data-carp-site]";
const REGION = appBBox(CONFIG);
const EVIDENCE_SHOTS = process.argv.includes("--evidence-shots");
const shotName = (name: string) => (APP === "python" ? name : name.replace(/\.png$/, `-${APP}.png`));
/** The app's default sightings window (`windows.defaultHours`: 7 days for python, 30 for lionfish). */
const WINDOW_HOURS = CONFIG.windows.defaultHours;

const log = (...a: unknown[]) => console.error("[e2e:firstload]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type LayerStat = { id: string; enabled: boolean; count: number; frame: number; breakdown?: Record<string, number> };

/** What the run measured for the FIRSTLOAD line; filled as the steps go, so a failed step still reports it. */
type Measured = { records: number; errors: string[]; detail: string };

const layerStats = (page: Page) => page.evaluate(() => (window.__inversa?.globe()?.layers ?? []) as LayerStat[]);

/** Page errors and console errors of `page`, into `errors`. */
function countErrors(page: Page, errors: string[]): void {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}${m.location().url ? ` (${m.location().url})` : ""}`);
  });
}

async function ready(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/?app=${APP}`, { waitUntil: "load" });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  const step = (what: string) => (err: unknown) => fail(`waiting for ${what}: ${err instanceof Error ? err.message : String(err)}`);
  if (!SPECIES_APP) {
    // No frames in a conditions app: the feeds, the globe's layers and the site markers are what loads.
    await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS }).catch(step("feeds"));
    await page.waitForFunction(() => (window.__inversa?.globe()?.layers.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS }).catch(step("globe layers"));
    await page
      .waitForFunction(
        (sel) => {
          const markers = [...document.querySelectorAll(sel)];
          return markers.length > 0 && markers.every((m) => m.getAttribute("data-status") !== "loading");
        },
        CARP_SITES,
        { timeout: LOAD_TIMEOUT_MS },
      )
      .catch(step("site markers with a review status"));
    await page.waitForTimeout(4_000);
    return;
  }
  await page
    .waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && (window.__inversa?.globe()?.layers.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS })
    .catch(step("frames and globe layers"));
  await page.waitForFunction(() => ((window.__inversa?.state("FEEDS") as unknown[] | undefined)?.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS }).catch(step("feeds"));
  if (SURVEY_APP) {
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, REPORTS, { timeout: LOAD_TIMEOUT_MS }).catch(step("report markers"));
    await page.waitForTimeout(4_000);
    return;
  }
  await page
    .waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.frame ?? -1) >= 0, undefined, { timeout: LOAD_TIMEOUT_MS })
    .catch(step("a sightings frame"));
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

/** Step 2: the records the app draws at load, checked against Axum; sets `out.records` and `out.detail`. */
async function records(page: Page, stack: Stack, out: Measured): Promise<void> {
  const stats = await layerStats(page);
  const drawn = (id: string) => {
    const s = stats.find((l) => l.id === id);
    return s && s.enabled ? s.count : 0;
  };
  log(`layers: ${stats.map((l) => `${l.id}=${l.enabled ? l.count : "off"}`).join(" ")}`);
  if (SURVEY_APP) {
    // Reports are the app's own markers (GBIF copies of iNat records drawn but not counted; e2e:lionfish checks
    // the count against Axum). The EVF sightings layer stays empty, and no stations or alerts draw.
    const reports = await page.locator(REPORTS).count();
    const [sightings, stations, alerts] = [drawn("sightings"), drawn("stations"), drawn("alerts")];
    out.records = reports;
    out.detail = `kind=survey reports=${reports} sightings=${sightings} stations=${stations} alerts=${alerts}`;
    if (reports === 0) fail("no reports drawn at first load");
    if (sightings || stations || alerts) fail(`survey app draws sightings=${sightings} stations=${stations} alerts=${alerts} at first load`);
  } else if (SPECIES_APP) {
    const sightings = stats.find((l) => l.id === "sightings") ?? fail("no sightings layer");
    const count = sightings.enabled ? sightings.count : 0;
    out.records = count;
    const api = await apiWindowCount(page, stack, sightings.frame);
    const [stations, alerts, hotspots] = [drawn("stations"), drawn("alerts"), drawn("hotspots")];
    out.detail = `kind=species stations=${stations} alerts=${alerts} hotspots=${hotspots} window=${count} api=${api.count}`;
    log(`sightings layer frame ${sightings.frame}: ${sightings.count} drawn ${JSON.stringify(sightings.breakdown)}; Axum ${api.count} distinct in ${api.from}..${api.to}`);
    if (count === 0) fail("no sightings drawn at first load");
    if (count !== api.count) fail(`globe draws ${count} sightings, Axum has ${api.count} distinct animal sightings in the same window`);
  } else {
    // A conditions app lists no sightings or hotspot layer: neither may draw. Its records are the site markers
    // drawn with a review status, one per site Axum's review board lists, with the same status.
    const [sightings, hotspots] = [drawn("sightings"), drawn("hotspots")];
    const markers = await page.$$eval(CARP_SITES, (els) =>
      els.map((el) => ({ site: el.getAttribute("data-carp-site") ?? "", status: el.getAttribute("data-status") ?? "", hidden: el.hasAttribute("data-hidden") })),
    );
    const loaded = markers.filter((m) => !m.hidden && m.status && m.status !== "loading");
    out.records = loaded.length;
    // Axum's board at the time the page's board reviewed (else the page's clock, installed at CLOCK).
    const reviewedAt = Number((await page.getAttribute('[data-testid="carp-board"]', "data-reviewed-at").catch(() => null)) || 0);
    const asOf = new Date(reviewedAt || (await page.evaluate(() => Date.now()))).toISOString();
    log(`review board as of ${asOf}${reviewedAt ? " (the page's data-reviewed-at)" : " (page clock)"}`);
    const board = await stack.graphql<{ reviewBoard: { sites: { site: string; status: string }[] } }>("query($asOf: Time) { reviewBoard(asOf: $asOf) { sites { site status } } }", { asOf });
    const api = new Map(board.reviewBoard.sites.map((s) => [s.site, s.status.toLowerCase()]));
    const statusDiffs = loaded.filter((m) => api.get(m.site) !== m.status).map((m) => `${m.site}=${m.status}/api ${api.get(m.site) ?? "none"}`);
    out.detail = `kind=conditions sites=${loaded.length}/${markers.length} api=${api.size} sightings=${sightings} hotspots=${hotspots} stations=${drawn("stations")} alerts=${drawn("alerts")}`;
    log(`site markers: ${markers.map((m) => `${m.site}=${m.status}${m.hidden ? "(hidden)" : ""}`).join(" ")}; Axum review board ${[...api].map(([s, st]) => `${s}=${st}`).join(" ")}`);
    if (sightings || hotspots) fail(`conditions app draws sightings=${sightings} hotspots=${hotspots}`);
    if (loaded.length === 0) fail("no site markers with a review status at first load");
    const sites = new Set(loaded.map((m) => m.site));
    if (sites.size !== api.size || [...api.keys()].some((s) => !sites.has(s))) fail(`markers ${[...sites].join(",")} are not Axum's review board sites ${[...api.keys()].join(",")}`);
    // The page reviewed a few seconds before this query: a status can flip between them, so a difference is logged.
    if (statusDiffs.length) log(`marker statuses differ from Axum's board: ${statusDiffs.join(" ")}`);
  }
}

async function firstLoad(browser: Browser, stack: Stack, before: boolean, out: Measured): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.clock.install({ time: new Date(CLOCK) });
  const page = await context.newPage();
  countErrors(page, out.errors);
  await ready(page, stack.origin);
  const m = await measure(page);
  const lines = [`SIMPLIFY pane_controls=${m.paneControls} pane_labels=${m.paneLabels} page_controls=${m.pageControls} page_labels=${m.pageLabels}`];
  const loadShot = shotName(before ? "simplify-before.png" : "simplify-after.png");
  await page.screenshot({ path: path.join(SHOT_DIR, loadShot) });
  log(`screenshot ${loadShot}`);
  if (EVIDENCE_SHOTS) {
    await page.screenshot({ path: path.join(SHOT_DIR, `${APP}-desktop.png`) });
    log(`screenshot ${APP}-desktop.png`);
  }
  if (before) {
    await context.close();
    return lines;
  }

  await records(page, stack, out);

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
  // A survey app's species chip is its own (client/lionfish).
  if (SPECIES_APP) await page.locator(SURVEY_APP ? '[data-testid="lionfish-chip"]' : `[data-species-chip="${CONFIG.taxa[0]!.id}"]`).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, shotName("simplify-welcome.png")) });
  log(`screenshot ${shotName("simplify-welcome.png")}`);
  await page.mouse.move(900, 500);

  lines.push(await popovers(page));
  await context.close();
  return lines;
}

/** The rubric's phone shot: a fresh load at 375×812, the chat sheet collapsed to its composer. */
async function mobileShot(browser: Browser, stack: Stack, errors: string[]): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.clock.install({ time: new Date(CLOCK) });
  const page = await context.newPage();
  countErrors(page, errors);
  await ready(page, stack.origin);
  const dir = path.join(SHOT_DIR, "mobile");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${APP}-375.png`) });
  log(`screenshot mobile/${APP}-375.png`);
  await context.close();
}

async function main() {
  const before = process.argv.includes("--before");
  buildApi(log);
  buildWeb(log);
  mkdirSync(SHOT_DIR, { recursive: true });
  const stack = await startStack({ name: "firstload", app: APP });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const out: Measured = { records: 0, errors: [], detail: "" };
  let failed = false;
  try {
    for (const line of await firstLoad(browser, stack, before, out)) console.log(line);
    if (EVIDENCE_SHOTS && !before) await mobileShot(browser, stack, out.errors);
  } catch (err) {
    failed = true;
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
  } finally {
    await browser.close();
    await stack.stop();
  }
  if (!before) {
    for (const e of out.errors) log(`error: ${e.slice(0, 400)}`);
    console.log(`FIRSTLOAD app=${APP} records=${out.records} errors=${out.errors.length}${out.detail ? ` ${out.detail}` : ""}`);
  }
  process.exit(failed || (!before && (out.errors.length > 0 || out.records < 1)) ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
