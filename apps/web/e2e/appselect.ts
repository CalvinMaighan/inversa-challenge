/**
 * A1b e2e: the app selector (PLAN.md C-A5, docs/APPS.md "App selector") on the real multi-app stack (e2e/stack.ts:
 * one Axum serving carp, lionfish and python, each data dir filled by `backfill --fixtures --app <id>`, the
 * production e2e build under `next start`, the signal Worker and the Caddy-like proxy). The proxy does not pin an
 * app, so the client's own resolution (`?app=`, then localStorage, then carp) is what is tested, and it records
 * every API path so a request without the app prefix is caught.
 *
 *   bun run e2e:appselect        build, run, print the APPSELECT lines
 *   E2E_SKIP_BUILD=1 …           reuse the last e2e build
 *
 * Steps:
 *   1. a fresh visit with no `?app=` opens carp (the default) and the URL gains `?app=carp`;
 *   2. the HUD's species icon button opens a popover listing carp, lionfish and python with icon, name, question
 *      and a health dot that matches Axum's `/health` (apps=3);
 *   3. picking lionfish switches in place: `?app=lionfish`, localStorage `inversa.app`, the map preset (VIEW),
 *      the layers, the helper questions and the legend all follow; `switch_ms` is click to all of those in the DOM
 *      and store, measured in the page (url, persist);
 *   4. a reload without `?app=` reopens lionfish (persist), and with `#v=1` (an old python link) opens python;
 *   5. keyboard only: Enter opens, the current app has focus, ArrowDown moves, Enter picks python (keyboard);
 *   6. Escape closes the popover and focus is back on the button; after a pick focus is on the new button
 *      (focus_return);
 *   7. no `/v1` request without an app prefix (APPSELECT-PREFIX); axe-core finds no violation in the open
 *      popover (dark, light, phone);
 *   8. screenshots: docs/evidence/appselect-dark.png, appselect-light.png (1440×900) and appselect-mobile.png
 *      (375×812, dark).
 *
 * Last lines:
 *   APPSELECT-PREFIX requests=<n> unprefixed=0
 *   APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms=<n>
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { parseAppHealth, type AppHealth } from "../client/hud/appselect/health";
import { APP_IDS, getApp, legendTitle, type AppId } from "../shared/apps";
import { APP_DIR, buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
const LOAD_TIMEOUT_MS = 90_000;
/** `/v1/<app>/...` (PLAN.md C-A2). */
const PREFIXED = new RegExp(`^/v1/(${APP_IDS.join("|")})/`);

const log = (...a: unknown[]) => console.error("[e2e:appselect]", ...a);
function fail(message: string): never {
  throw new Error(message);
}

// ---- page helpers --------------------------------------------------------------------------------

const BUTTON = '[data-testid="app-select-button"]';
const POPOVER = '[data-testid="app-select-popover"]';

async function ready(page: Page, app: AppId): Promise<void> {
  await page.locator(`${BUTTON}[data-app="${app}"]`).waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-app-pending"), undefined, { timeout: LOAD_TIMEOUT_MS });
}

/** Open the popover and wait until its health dots show `expected` (Axum's `/health`, read by the script). */
async function openPopover(page: Page, expected: Record<AppId, AppHealth>): Promise<void> {
  await page.click(BUTTON);
  await page.locator(POPOVER).waitFor();
  await page
    .waitForFunction((want) => [...document.querySelectorAll("[data-app-option]")].every((el) => el.getAttribute("data-health") === (want as Record<string, string>)[el.getAttribute("data-app-option") ?? ""]), expected, { timeout: 15_000 })
    .catch(async () => fail(`health dots ${JSON.stringify(await page.$$eval("[data-app-option]", (els) => els.map((el) => `${el.getAttribute("data-app-option")}=${el.getAttribute("data-health")}`)))}, /health says ${JSON.stringify(expected)}`));
}

const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);

/** axe-core over the open popover and its button: violations as `rule@target` strings. */
async function axePopover(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: object, opts: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const res = await axe.run({ include: [['[data-testid="app-select-popover"]'], ['[data-testid="app-select-button"]']] }, { resultTypes: ["violations"] });
    return res.violations.flatMap((v) => v.nodes.map((n) => `${v.id}@${n.target.join(" ")}`));
  });
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, name);
  await page.screenshot({ path: file });
  log(`screenshot ${path.relative(REPO_DIR, file)}`);
}

/** In the page: click an option and time until URL, storage, store, legend-relevant layers and helper questions all show `app`. */
async function timedSwitch(page: Page, app: AppId, helper: string): Promise<number> {
  return page.evaluate(
    ({ app, helper }) =>
      new Promise<number>((resolve, reject) => {
        const option = document.querySelector<HTMLButtonElement>(`[data-app-option="${app}"]`);
        if (!option) return reject(new Error(`no option ${app}`));
        const t0 = performance.now();
        option.click();
        const done = () => {
          const view = window.__inversa?.state("VIEW") as { seq: number } | undefined;
          const appKey = window.__inversa?.state("APP") as { id: string } | undefined;
          return (
            new URLSearchParams(location.search).get("app") === app &&
            localStorage.getItem("inversa.app") === app &&
            appKey?.id === app &&
            (view?.seq ?? 0) > 0 &&
            document.querySelector(`[data-testid="app-select-button"][data-app="${app}"]`) !== null &&
            document.body.innerText.includes(helper)
          );
        };
        const tick = () => (done() ? resolve(performance.now() - t0) : performance.now() - t0 > 10_000 ? reject(new Error("switch did not complete")) : requestAnimationFrame(tick));
        tick();
      }),
    { app, helper },
  );
}

async function main(): Promise<string> {
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "appselect", app: "carp", apps: APP_IDS, pinApp: false });
  const origin = stack.origin;
  let browser: Browser | null = null;
  try {
    const health = parseAppHealth(await (await fetch(`${origin}/health`)).json());
    log(`/health: ${JSON.stringify(health)}`);
    browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // 1. Default app and URL normalisation.
    await page.goto(origin);
    await ready(page, "carp");
    if (new URL(page.url()).searchParams.get("app") !== "carp") fail(`fresh visit URL ${page.url()}`);

    // 2. Popover lists the three apps with their health.
    await openPopover(page, health);
    const rows = await page.$$eval("[data-app-option]", (els) =>
      els.map((el) => ({ id: el.getAttribute("data-app-option"), health: el.getAttribute("data-health"), text: (el as HTMLElement).innerText, icon: el.querySelector("svg") !== null, current: el.getAttribute("aria-current") })),
    );
    if (rows.length !== 3) fail(`${rows.length} options`);
    for (const id of APP_IDS) {
      const row = rows.find((r) => r.id === id) ?? fail(`no ${id} option`);
      const app = getApp(id);
      if (!row.text.includes(app.name) || !row.text.includes(app.question.slice(0, 40)) || !row.icon) fail(`${id} option misses name, question or icon: ${row.text}`);
      if (row.health !== health[id]) fail(`${id} health ${row.health}, /health says ${health[id]}`);
    }
    if (rows.find((r) => r.current === "true")?.id !== "carp") fail("carp is not marked current");
    const axeDark = await axePopover(page);
    if (axeDark.length) fail(`axe (dark): ${axeDark.join(", ")}`);
    await shot(page, "appselect-dark.png");

    // 3. Switch to lionfish, timed in the page.
    const lionfish = getApp("lionfish");
    const switchMs = Math.round(await timedSwitch(page, "lionfish", lionfish.helperQuestions[0]!));
    const layers = (await page.evaluate(() => window.__inversa!.state("LAYERS"))) as { visible: Record<string, boolean>; sightingHours: number };
    if (layers.visible.lst !== false || layers.visible.sightings !== true || layers.sightingHours !== 720) fail(`lionfish layers ${JSON.stringify(layers)}`);
    // The map preset: the globe flies to frame lionfish's four areas in the part of the screen the HUD leaves free
    // (leaf UL/GRB fit), and VIEW (which the camera writes back once it settles) ends up showing all four.
    const hull = { west: -88.5, south: 9.7, east: -74.0, north: 27.5 };
    await page
      .waitForFunction(
        (h) => {
          const v = window.__inversa!.state("VIEW") as { bbox: { west: number; south: number; east: number; north: number }; altitudeM: number };
          return v.bbox.west <= h.west && v.bbox.south <= h.south && v.bbox.east >= h.east && v.bbox.north >= h.north && v.altitudeM < 12_000_000;
        },
        hull,
        { timeout: 15_000 },
      )
      .catch(() => page.evaluate(() => window.__inversa!.state("VIEW")).then((v) => fail(`lionfish preset: VIEW ${JSON.stringify(v)}`)));
    if ((await page.title()) !== lionfish.name) fail(`title ${await page.title()}`);
    // The legend is lionfish's: its title, and no land-surface row.
    await page.click('[data-testid="status-button"]');
    await page.click('[data-testid="layers-button"]');
    const legend = await page.locator('[data-testid="legend-title"]').innerText();
    if (legend !== legendTitle(lionfish)) fail(`legend title ${legend}, want ${legendTitle(lionfish)}`);
    await page.keyboard.press("Escape");
    // The share link follows with `app=lionfish` (written after the 400 ms debounce).
    await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get("app") === "lionfish", undefined, { timeout: 5_000 });
    const url = "ok";
    log(`switch carp → lionfish in ${switchMs} ms`);

    // 4. Remembered: a bare reload opens lionfish; an old v=1 link opens python. The server HTML is carp's, so
    // the head script must hide the page until lionfish is applied (no flash of the wrong app): record the
    // <html> attributes from the first moment.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __appAttrs: string[] }).__appAttrs = seen;
      // The whole document: <html> may not exist yet when this runs.
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.target !== document.documentElement) continue;
          seen.push(`${document.documentElement.getAttribute("data-app")}|${document.documentElement.hasAttribute("data-app-pending")}`);
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-app", "data-app-pending"] });
    });
    await page.goto(origin);
    await ready(page, "lionfish");
    if (new URL(page.url()).searchParams.get("app") !== "lionfish") fail(`reload URL ${page.url()}`);
    const attrs = await page.evaluate(() => (window as unknown as { __appAttrs: string[] }).__appAttrs);
    // Pending (hidden) from the head script on, until AppBoot clears it with lionfish applied.
    if (attrs[0] !== "lionfish|false" && attrs[0] !== "lionfish|true") fail(`head script attrs ${attrs.join(" ")}`);
    if (!attrs.includes("lionfish|true") || attrs.at(-1) !== "lionfish|false") fail(`pending never set or never cleared: ${attrs.join(" ")}`);
    log(`reload attrs: ${attrs.join(" → ")}`);
    const page2 = await context.newPage();
    await page2.goto(`${origin}/#v=1&c=25.7617,-80.1918,45000,0,-90`);
    await ready(page2, "python");
    await page2.close();
    const persist = "ok";

    // 6a. Escape returns focus.
    await page.goto(`${origin}/?app=lionfish`);
    await ready(page, "lionfish");
    await page.focus(BUTTON);
    await page.keyboard.press("Enter");
    await page.locator(POPOVER).waitFor();
    const focusedOpen = await page.evaluate(() => document.activeElement?.getAttribute("data-app-option"));
    if (focusedOpen !== "lionfish") fail(`open focus on ${focusedOpen}`);
    await page.keyboard.press("Escape");
    await page.locator(POPOVER).waitFor({ state: "detached" });
    if ((await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) !== "app-select-button") fail("Escape did not return focus");

    // 5. Keyboard: Enter, ArrowDown to python, Enter.
    await page.keyboard.press("Enter");
    await page.locator(POPOVER).waitFor();
    await page.keyboard.press("ArrowDown");
    if ((await page.evaluate(() => document.activeElement?.getAttribute("data-app-option"))) !== "python") fail("ArrowDown did not move to python");
    await page.keyboard.press("Enter");
    await ready(page, "python");
    const keyboard = new URL(page.url()).searchParams.get("app") === "python" ? "ok" : fail("keyboard pick did not switch");
    // 6b. After a pick, focus is on the (remounted) button.
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "app-select-button", undefined, { timeout: 2_000 });
    const focusReturn = "ok";

    // 8. Light and phone screenshots, popover open.
    const light = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await light.addInitScript(() => localStorage.setItem("inversa:THEME", JSON.stringify("light")));
    const lightPage = await light.newPage();
    await lightPage.goto(`${origin}/?app=python`);
    await ready(lightPage, "python");
    if ((await lightPage.evaluate(() => document.documentElement.dataset.theme)) !== "light") fail("light theme not applied");
    await openPopover(lightPage, health);
    const axeLight = await axePopover(lightPage);
    if (axeLight.length) fail(`axe (light): ${axeLight.join(", ")}`);
    await shot(lightPage, "appselect-light.png");
    await light.close();

    const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const phonePage = await phone.newPage();
    await phonePage.goto(`${origin}/?app=carp`);
    await ready(phonePage, "carp");
    await openPopover(phonePage, health);
    const box = await phonePage.locator(POPOVER).boundingBox();
    if (!box || box.x < 0 || box.x + box.width > 375) fail(`phone popover off screen: ${JSON.stringify(box)}`);
    const axePhone = await axePopover(phonePage);
    if (axePhone.length) fail(`axe (phone): ${axePhone.join(", ")}`);
    log("axe: 0 violations in the popover (dark, light, phone)");
    await shot(phonePage, "appselect-mobile.png");
    await phone.close();

    if (errors.length) log(`page errors: ${errors.slice(0, 5).join(" | ")}`);
    const v1 = stack.apiPaths.filter((p) => p.startsWith("/v1/"));
    const unprefixed = v1.filter((p) => !PREFIXED.test(p));
    console.log(`APPSELECT-PREFIX requests=${v1.length - unprefixed.length} unprefixed=${unprefixed.length}${unprefixed.length ? ` (${[...new Set(unprefixed)].join(", ")})` : ""}`);
    if (unprefixed.length) fail("unprefixed /v1 requests");
    return `APPSELECT apps=${rows.length} url=${url} persist=${persist} keyboard=${keyboard} focus_return=${focusReturn} switch_ms=${switchMs}`;
  } catch (err) {
    log(stack.logs());
    throw err;
  } finally {
    await browser?.close();
    await stack.stop();
  }
}

try {
  console.log(await main());
  process.exit(0);
} catch (err) {
  console.error(err);
  console.log("APPSELECT failed");
  process.exit(1);
}
