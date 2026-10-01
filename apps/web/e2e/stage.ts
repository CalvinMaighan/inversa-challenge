/**
 * GE1 e2e (docs/GODS_EYE.md GC1, gates/leaf-GE1.md): the stage layout on the real stack (e2e/stack.ts: Axum with
 * the fixture backfill, `next start`, the proxy, all on free ports).
 *
 *   bun run e2e:stage            build, run, print the STAGE, TOPRIGHT, DETAILS and RESPONSIVE lines
 *   E2E_SKIP_BUILD=1 …           reuse the last e2e build
 *
 * 1440×900, python, the fixture window of early September:
 *   STAGE: the circle (`[data-stage]`) is centred on the page (within 2 px), the chat card sits left of it and
 *     the sighting card right of it once a sighting is open, neither reaching the stage centre (the centre point
 *     hits the globe), and the page outside the circle is black: pixels sampled from a screenshot in the
 *     margins and the stage's corners, away from every HUD surface, are all black.
 *   TOPRIGHT: the top bar holds exactly three buttons with accessible names (about, theme, developer) and no
 *     visible text, pinned to the top right; Developer opens `developer-panel` with focus inside, Tab stays in
 *     it, Esc closes it and hands focus back to the button.
 *   DETAILS: no card with nothing selected; a click on a python marker opens its card at the right (open=1);
 *     its close button removes it with the stage still centred (closed=1); Enter on the sighting's label opens
 *     the card again with focus inside, Esc closes it and focus returns to the label (focus=ok).
 * RESPONSIVE: 375×812 keeps the phone docks (chat sheet, full-screen globe, no stage) with no horizontal page
 *   scroll and nothing past the viewport edges; 1024×768 opens a sighting and its card and the chat card overlap
 *   the stage edges without covering its centre.
 *
 * Screenshots: docs/evidence/stage-1440.png (nothing selected), stage-1440-selected.png, stage-1024.png,
 * stage-375.png.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
/** The Axum fixtures were recorded 2026-09-30T20:40Z; the browser clock sits just after. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
/** Early September: the fixture pythons (as e2e/species.ts). */
const AT = "2026-09-09T20:00:00.000Z";
const LINK = "#v=1&c=25.70000,-80.40000,160000,0,-90&t=2026-09-09T20:00Z";
const WINDOW_MS = 168 * 3_600_000;
const REGION = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 };
const PYTHON_TAXON = "1";
const LOAD_TIMEOUT_MS = 120_000;
const DRAWER = '[data-testid="hud-drawer"]';

const log = (...a: unknown[]) => console.error("[e2e:stage]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type Box = { x: number; y: number; width: number; height: number };
const right = (b: Box) => b.x + b.width;
const centreX = (b: Box) => b.x + b.width / 2;

async function box(page: Page, selector: string): Promise<Box> {
  return (await page.locator(selector).first().boundingBox()) ?? fail(`${selector} has no box`);
}

function watch(page: Page, errors: string[], name: string): Page {
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  return page;
}

async function open(browser: Browser, origin: string, viewport: { width: number; height: number }, errors: string[], name: string): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(viewport.width < 768 ? { hasTouch: true } : {}) });
  await context.clock.install({ time: new Date(FIXTURE_CLOCK) });
  const page = watch(await context.newPage(), errors, name);
  await page.goto(`${origin}/${LINK}`, { waitUntil: "load" });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction((id) => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.breakdown?.[id] ?? 0) > 0, PYTHON_TAXON, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(800);
  return page;
}

/** Fly the camera through the share link and wait for VIEW to settle there (as e2e/species.ts). */
async function flyTo(page: Page, lat: number, lon: number, altitudeM: number): Promise<void> {
  await page.evaluate(([la, lo, alt]) => {
    location.hash = `#v=1&c=${la.toFixed(5)},${lo.toFixed(5)},${alt},0,-90&t=2026-09-09T20:00Z`;
  }, [lat, lon, altitudeM] as const);
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

type Python = { id: string; lat: number; lon: number };

async function pythons(stack: Stack): Promise<Python[]> {
  const atMs = Date.parse(AT);
  const { sightings } = await stack.graphql<{ sightings: (Python & { canonicalId: string | null })[] }>(
    "query($bbox: BBox!, $from: Time!, $to: Time!, $taxa: [ID!]) { sightings(bbox: $bbox, from: $from, to: $to, taxa: $taxa) { id lat lon canonicalId } }",
    { bbox: REGION, from: new Date(atMs - WINDOW_MS + 3_600_000).toISOString(), to: AT, taxa: [PYTHON_TAXON] },
  );
  const list = sightings.filter((s) => s.canonicalId === null);
  if (list.length === 0) fail("Axum holds no python sightings in the fixture window");
  return list;
}

/** Fly to a python until its marker is the one under its projected point; click it; the card opens. */
async function clickPython(page: Page, list: Python[]): Promise<{ id: string; x: number; y: number }> {
  const canvas = await box(page, "[data-globe] canvas");
  for (const s of list.slice(0, 12)) {
    await flyTo(page, s.lat, s.lon, 4_000);
    const p = await page.evaluate(([lon, lat]) => window.__inversa!.project(lon, lat), [s.lon, s.lat] as const);
    if (!p) continue;
    const picked = await page.evaluate(([x, y]) => window.__inversa!.pick(x, y), [p.x, p.y] as const);
    if (picked !== `sighting:${s.id}`) continue;
    await page.mouse.click(canvas.x + p.x, canvas.y + p.y);
    const want = `sighting:${s.id}`;
    await page.waitForFunction((id) => (window.__inversa?.state("SELECTION") as { evidenceId?: string } | undefined)?.evidenceId === id, want, { timeout: 15_000 });
    await page.locator(DRAWER).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    log(`clicked sighting:${s.id} at (${Math.round(canvas.x + p.x)}, ${Math.round(canvas.y + p.y)})`);
    return { id: want, x: canvas.x + p.x, y: canvas.y + p.y };
  }
  fail("no python sighting marker could be hit");
}

/** The element at the stage centre belongs to the globe (no card or bar covers it). */
async function centreIsGlobe(page: Page, stage: Box): Promise<boolean> {
  return page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-globe]"), [centreX(stage), stage.y + stage.height / 2] as const);
}

/**
 * Black margins: screenshot pixels outside the circle (the right margin and the corners of the stage square),
 * away from every HUD surface, the chat card and the attribution. Returns [black, sampled, worst pixel].
 */
async function blackMargins(page: Page, stage: Box): Promise<{ black: number; total: number; worst: string }> {
  const shot = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ([b64, s]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const covers = [...document.querySelectorAll("[data-hud-obstacle], [data-testid='hud-topbar'], [data-chat-column], [data-globe-credits], [data-testid='hud-timeline'], [data-testid='hud-labels'] > *")]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      const top = document.querySelector("[data-hud-chrome] > div")?.getBoundingClientRect().bottom ?? 60;
      const cx = s.x + s.width / 2;
      const cy = s.y + s.height / 2;
      const r = s.width / 2;
      const points: [number, number][] = [];
      // The right margin, between the top row and the timeline.
      for (let x = s.x + s.width + 10; x < img.width - 6; x += 24) for (let y = top + 12; y < img.height - 140; y += 24) points.push([x, y]);
      // Inside the stage square but outside the circle: its four corners.
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ])
        for (const k of [0.46, 0.48]) points.push([cx + dx * k * s.width, cy + dy * k * s.height]);
      let black = 0;
      let total = 0;
      let worst = "";
      let worstMax = -1;
      for (const [x, y] of points) {
        if (Math.hypot(x - cx, y - cy) <= r + 2) continue;
        if (covers.some((c) => x >= c.left - 4 && x <= c.right + 4 && y >= c.top - 4 && y <= c.bottom + 4)) continue;
        const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        const max = Math.max(d[0]!, d[1]!, d[2]!);
        total += 1;
        if (max <= 12) black += 1;
        if (max > worstMax) {
          worstMax = max;
          worst = `(${Math.round(x)},${Math.round(y)}) rgb(${d[0]},${d[1]},${d[2]})`;
        }
      }
      return { black, total, worst };
    },
    [shot, stage] as const,
  );
}

async function desktop(browser: Browser, stack: Stack, list: Python[], errors: string[]): Promise<string[]> {
  const page = await open(browser, stack.origin, { width: 1440, height: 900 }, errors, "1440");
  const vw = 1440;

  // ---- STAGE, nothing selected ------------------------------------------------------------------------------
  if ((await page.locator(DRAWER).count()) !== 0) fail("a sighting card is open with nothing selected");
  const layout = await page.getAttribute("[data-shell]", "data-layout");
  if (layout !== "stage") fail(`shell layout ${layout}, want stage at 1440 px`);
  const stage = await box(page, "[data-stage]");
  const chat = await box(page, "[data-chat-column]");
  log(`stage ${JSON.stringify(stage)} chat ${JSON.stringify(chat)}`);
  const centred = Math.abs(centreX(stage) - vw / 2) <= 2;
  const pageBg = await page.evaluate(() => getComputedStyle(document.querySelector("[data-shell]")!).backgroundColor);
  const margins = await blackMargins(page, stage);
  log(`page ${pageBg}; margin pixels ${margins.black}/${margins.total} black, brightest ${margins.worst}`);
  const black = pageBg === "rgb(0, 0, 0)" && margins.total >= 40 && margins.black === margins.total;
  await page.screenshot({ path: path.join(SHOT_DIR, "stage-1440.png") });

  // ---- TOPRIGHT ---------------------------------------------------------------------------------------------
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="hud-topbar"] button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.getAttribute("aria-label") ?? "", text: b.innerText.trim(), right: r.right, top: r.top, id: b.dataset.testid ?? "" };
    }),
  );
  log(`top right: ${JSON.stringify(buttons.map((b) => `${b.id} "${b.name}" r=${Math.round(b.right)} t=${Math.round(b.top)}`))}`);
  const wants = [/about/i, /theme/i, /developer/i];
  const namesOk =
    buttons.length === 3 &&
    buttons.every((b) => b.name.length > 0 && b.text === "" && b.top <= 24) &&
    Math.max(...buttons.map((b) => b.right)) >= vw - 24 &&
    wants.every((re, i) => re.test(buttons[i]!.name));
  if (!namesOk) fail(`top right buttons ${JSON.stringify(buttons)}`);
  const dev = page.locator('[data-testid="developer-button"]');
  await dev.click();
  await page.locator('[data-testid="developer-panel"]').waitFor({ timeout: 5_000 });
  const devInside = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="developer-panel"]'));
  if ((await dev.getAttribute("aria-expanded")) !== "true" || !devInside) fail("Developer did not open its panel with focus inside");
  // A modal: Tab and Shift+Tab stay inside it.
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    if (!(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="developer-panel"]')))) fail(`${key} left the Developer panel`);
  }
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="developer-panel"]').waitFor({ state: "detached", timeout: 5_000 });
  const devBack = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "developer-button");
  if (!devBack) fail("Esc closed the Developer panel but focus did not return to its button");
  log("Developer: panel opened with focus inside, Tab kept inside; Esc closed it, focus back on the button");

  // ---- DETAILS ----------------------------------------------------------------------------------------------
  const hit = await clickPython(page, list);
  const drawers = await page.locator(DRAWER).count();
  const details = await box(page, DRAWER);
  const stageOpen = await box(page, "[data-stage]");
  const chatOpen = await box(page, "[data-chat-column]");
  const centreClear = await centreIsGlobe(page, stageOpen);
  log(`details ${JSON.stringify(details)} chat ${JSON.stringify(chatOpen)} centre clear ${centreClear}`);
  const chatLeft = right(chatOpen) < centreX(stageOpen) && centreX(chatOpen) < stageOpen.x;
  const detailsRight = details.x > centreX(stageOpen) && centreX(details) > right(stageOpen);
  await page.screenshot({ path: path.join(SHOT_DIR, "stage-1440-selected.png") });
  const open1 = drawers === 1 && detailsRight ? 1 : 0;

  await page.locator(`${DRAWER} button[aria-label="Close panel"]`).click();
  await page.locator(DRAWER).waitFor({ state: "detached", timeout: 5_000 });
  const stageClosed = await box(page, "[data-stage]");
  const closed1 = (await page.locator(DRAWER).count()) === 0 && Math.abs(centreX(stageClosed) - vw / 2) <= 2 ? 1 : 0;

  // Keyboard: the selected sighting keeps its bracket label; Enter opens the card with focus inside, Esc returns.
  const label = page.locator(`[data-testid="hud-labels"] [data-evidence="${hit.id}"]`);
  await label.waitFor({ timeout: 10_000 });
  await label.focus();
  await page.keyboard.press("Enter");
  await page.locator(DRAWER).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const inside = await page.evaluate((sel) => !!document.activeElement?.closest(sel), DRAWER);
  await page.keyboard.press("Escape");
  await page.locator(DRAWER).waitFor({ state: "detached", timeout: 5_000 });
  const back = await page.evaluate((id) => document.activeElement?.getAttribute("data-evidence") === id, hit.id);
  log(`keyboard: Enter on the label put focus inside the card=${inside}; Esc returned focus to the label=${back}`);
  await page.context().close();

  return [
    `STAGE centered=${centred ? "ok" : "no"} chat=${chatLeft && centreClear ? "left" : "no"} details=${detailsRight && centreClear ? "right" : "no"} margins=${black ? "black" : "no"}`,
    `TOPRIGHT buttons=${buttons.length} names=${namesOk ? "ok" : "no"}`,
    `DETAILS open=${open1} closed=${closed1} focus=${inside && back ? "ok" : "no"}`,
  ];
}

/** Elements past the viewport's side edges (after clipping by ancestors), sideways scroll boxes, page scroll. */
function sideways(): { overflow: string[]; hscroll: string[]; pageScroll: number } {
  const vw = document.documentElement.clientWidth;
  const overflow: string[] = [];
  const hscroll: string[] = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (!el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    let left = r.left;
    let rightEdge = r.right;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === "visible") continue;
      const ar = a.getBoundingClientRect();
      left = Math.max(left, ar.left);
      rightEdge = Math.min(rightEdge, ar.right);
    }
    if (rightEdge - left > 0 && (left < -1 || rightEdge > vw + 1)) overflow.push(`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 1).join(".")} ${Math.round(r.left)}..${Math.round(r.right)}`);
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) hscroll.push(`${el.tagName.toLowerCase()} ${el.scrollWidth}>${el.clientWidth}`);
  }
  const root = document.scrollingElement ?? document.documentElement;
  return { overflow, hscroll, pageScroll: root.scrollWidth - root.clientWidth };
}

async function phone(browser: Browser, stack: Stack, errors: string[]): Promise<boolean> {
  const page = await open(browser, stack.origin, { width: 375, height: 812 }, errors, "375");
  const layout = await page.getAttribute("[data-shell]", "data-layout");
  const sheet = await page.getAttribute("[data-chat-column]", "data-layout");
  const chat = await box(page, "[data-chat-column]");
  const globe = await box(page, "[data-globe]");
  const stageShown = await page.locator("[data-stage]").isVisible();
  const o = await page.evaluate(sideways);
  await page.screenshot({ path: path.join(SHOT_DIR, "stage-375.png") });
  log(`phone: shell ${layout}, chat ${sheet} ${JSON.stringify(chat)}, globe ${JSON.stringify(globe)}, stage shown ${stageShown}, overflow ${o.overflow.length} hscroll ${o.hscroll.length} pagescroll ${o.pageScroll}`);
  for (const line of [...o.overflow, ...o.hscroll].slice(0, 10)) log(`   ${line}`);
  await page.context().close();
  const docked = layout === "dock" && sheet === "sheet" && Math.abs(chat.width - 375) <= 1 && Math.abs(chat.y + chat.height - 812) <= 1;
  const fullGlobe = globe.x === 0 && Math.abs(globe.width - 375) <= 1 && globe.y === 0;
  return docked && fullGlobe && !stageShown && o.overflow.length === 0 && o.hscroll.length === 0 && o.pageScroll === 0;
}

async function tablet(browser: Browser, stack: Stack, list: Python[], errors: string[]): Promise<boolean> {
  const page = await open(browser, stack.origin, { width: 1024, height: 768 }, errors, "1024");
  await clickPython(page, list);
  const stage = await box(page, "[data-stage]");
  const chat = await box(page, "[data-chat-column]");
  const details = await box(page, DRAWER);
  const clear = await centreIsGlobe(page, stage);
  const o = await page.evaluate(sideways);
  await page.screenshot({ path: path.join(SHOT_DIR, "stage-1024.png") });
  await page.context().close();
  const cx = centreX(stage);
  const overlapsEdges = right(chat) > stage.x && details.x < right(stage);
  log(`tablet: stage ${JSON.stringify(stage)} chat ${JSON.stringify(chat)} details ${JSON.stringify(details)}; edges overlapped ${overlapsEdges}, centre clear ${clear}, page scroll ${o.pageScroll}`);
  return Math.abs(cx - 512) <= 2 && right(chat) < cx && details.x > cx && overlapsEdges && clear && o.pageScroll === 0;
}

async function main() {
  buildApi(log);
  buildWeb(log);
  mkdirSync(SHOT_DIR, { recursive: true });
  const stack = await startStack({ name: "stage" });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  try {
    const list = await pythons(stack);
    log(`Axum: ${list.length} distinct python sightings in the window`);
    const lines = await desktop(browser, stack, list, errors);
    const mobileOk = await phone(browser, stack, errors);
    const tabletOk = await tablet(browser, stack, list, errors);
    lines.push(`RESPONSIVE mobile=${mobileOk ? "ok" : "no"} tablet=${tabletOk ? "ok" : "no"}`);
    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    for (const line of lines) console.log(line);
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
