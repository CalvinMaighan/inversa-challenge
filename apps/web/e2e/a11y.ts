/**
 * Accessibility, keyboard, phone layout and reduced motion (gates/leaf-T30.md) on the real stack (e2e/stack.ts)
 * with the real agent (Doppler inversa/dev hands the Next server its model key; the key is never printed).
 *
 *   bun run e2e:a11y           build, run, print the AXE, KEYBOARD, MOBILE and REDUCED-MOTION lines
 *   E2E_SKIP_BUILD=1 …         reuse the last e2e build
 *
 * 1. axe-core (from node_modules, injected into the page) scans the ops page `/` with data loaded and the
 *    missions panel open, with the agent card open on a cited answer, and with the evidence drawer open, at
 *    1440×900 and again at 375×812 (card, drawer and missions as bottom sheets). Serious and critical
 *    violations are counted once per rule and element: `AXE serious=<n> critical=<n>`.
 * 2. Keyboard only (Tab, Shift+Tab, Enter, Esc, arrows): reach the orb, open the card, type and send, reach a
 *    citation, open the drawer, close it with Esc (focus returns to the citation), close the card with Esc
 *    (focus returns to the orb), reach the timeline scrubber and move it with the arrow keys, reach the
 *    missions panel. Every stop must show a focus ring (a non-zero outline that no ancestor clips).
 *    `KEYBOARD-OK` when all of that held.
 * 3. 375×812 screenshots in docs/evidence/mobile/: main view, card as a sheet, drawer as a sheet, missions
 *    panel. Each state is checked for horizontal page scroll, content past the viewport edge, and sideways
 *    scrolling boxes: `MOBILE <state> overflow=<n> hscroll=<n> sheet=<yes|no|->`.
 * 4. The desktop walk runs under `prefers-reduced-motion: reduce`: the card must open and close without its
 *    morph beats, the agent's camera move must not fly (the globe's "flight" render hold never shows up), and
 *    no infinite CSS animation may run (orb pulse, live pulses, working rows). `REDUCED-MOTION-OK`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { APP_DIR, buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);
const MOBILE_DIR = path.join(REPO_DIR, "docs/evidence/mobile");
const QUESTION =
  "Fly the map to Coral Gables and show me the green iguana sightings there around 17:00 UTC on 1 February 2026, during the cold snap. Cite the sighting records.";
const FOLLOW_UP = "Please move the map to those sightings with set_view (time 2026-02-01T17:00:00Z) and cite each sighting record you used.";
const TURN_TIMEOUT_MS = 240_000;
const LOAD_TIMEOUT_MS = 120_000;
const MAX_TABS = 400;
const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];

const ORB = '[data-agent-orb] button[aria-haspopup="dialog"]';
const QUESTION_BOX = '[data-agent-card] textarea[aria-label="Question"]';
const CITATION = "[data-agent-card] [data-evidence-id]";
const DRAWER = "[data-testid=hud-drawer]";
const SCRUBBER = "[data-hud-scrubber]";
const MISSIONS = "[data-testid=hud-missions]";

const log = (...a: unknown[]) => console.error("[e2e:a11y]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------------------------------------
// axe-core

type AxeNode = { target: string; summary: string };
type AxeViolation = { id: string; impact: string | null; help: string; nodes: AxeNode[] };

/** rule id + element → impact, across every scan. */
const axeFindings = new Map<string, string>();

async function axeScan(page: Page, label: string): Promise<void> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: AxeViolationIn[] }> } }).axe;
    type AxeViolationIn = { id: string; impact: string | null; help: string; nodes: { target: string[]; failureSummary?: string }[] };
    const res = await axe.run(document, { resultTypes: ["violations"] });
    return res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary ?? "").split("\n").slice(0, 3).join(" / ") })),
    }));
  });
  for (const v of violations as AxeViolation[]) {
    for (const n of v.nodes) axeFindings.set(`${v.id} @ ${n.target}`, v.impact ?? "unknown");
    const tag = v.impact === "serious" || v.impact === "critical" ? "!!" : "  ";
    log(`${tag} axe ${label}: ${v.impact} ${v.id} (${v.help}) ×${v.nodes.length}`);
    if (tag === "!!") for (const n of v.nodes.slice(0, 6)) log(`     ${n.target} :: ${n.summary}`);
  }
  log(`axe ${label}: ${violations.length} rules violated`);
}

// ---------------------------------------------------------------------------------------------------------
// Agent turns (a tee of the stream, installed before the page loads; see e2e/convo.ts)

type Tapped = { status: number; text: string; done: boolean };

function tapAgentStreams(): void {
  const w = window as unknown as { __agentStreams: Tapped[] };
  w.__agentStreams = [];
  const original = window.fetch.bind(window);
  const tapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/agent/stream") || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    const entry: Tapped = { status: res.status, text: "", done: false };
    w.__agentStreams.push(entry);
    void (async () => {
      const reader = mine.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        entry.text += decoder.decode(value, { stream: true });
      }
      entry.done = true;
    })();
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  window.fetch = tapped as typeof fetch;
}

/**
 * Motion probes, installed before the page loads: every `data-stage` the agent card shows, and every frame
 * on which the globe's render governor holds for a camera flight.
 */
function installMotionProbes(): void {
  const w = window as unknown as { __stages: string[]; __flightFrames: number };
  w.__stages = [];
  w.__flightFrames = 0;
  new MutationObserver((records) => {
    for (const r of records) {
      const nodes = r.type === "attributes" ? [r.target] : [...r.addedNodes];
      for (const n of nodes) {
        if (!(n instanceof Element)) continue;
        const card = n.matches("[data-agent-card]") ? n : n.querySelector("[data-agent-card]");
        const stage = card?.getAttribute("data-stage");
        if (stage && w.__stages.at(-1) !== stage) w.__stages.push(stage);
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stage"] });
  const tick = () => {
    const holds = (window as unknown as { __inversa?: { globe(): { governor: { holds: string[] } } | null } }).__inversa?.globe()?.governor.holds ?? [];
    if (holds.includes("flight")) w.__flightFrames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

type StreamEvent = { type: string; message?: string };

/** Type with the keyboard into the focused question box, send with Enter, return the turn's events. */
async function askByKeyboard(page: Page, text: string): Promise<StreamEvent[]> {
  const before = await page.evaluate(() => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams.length);
  await page.keyboard.type(text, { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n] !== undefined, before, { timeout: 30_000 });
  // Mid-turn: the working rows and the phase line pulse without reduced motion.
  await page.waitForTimeout(1_500);
  motionOffenders.push(...(await page.evaluate(infiniteAnimations)).map((o) => `mid-turn ${o}`));
  await page.waitForFunction((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]?.done === true, before, { timeout: TURN_TIMEOUT_MS });
  const res = await page.evaluate((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]!, before);
  await page.waitForFunction(
    () => !document.querySelector('[data-agent-card] [data-status="streaming"], [data-agent-card] [data-status="pending"]'),
    undefined,
    { timeout: 30_000 },
  );
  const events = res.text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as StreamEvent;
      } catch {
        return { type: "unparsed" };
      }
    });
  if (res.status !== 200) fail(`agent stream answered ${res.status}: ${res.text.slice(0, 300)}`);
  const error = events.find((e) => e.type === "error");
  if (error) fail(`the agent turn failed: ${error.message ?? JSON.stringify(error)}`);
  return events;
}

// ---------------------------------------------------------------------------------------------------------
// Focus rings

type FocusStop = { desc: string; ring: boolean; why: string };

/** The focused element and whether it shows a ring: a visible outline that no clipping ancestor cuts off. */
function focusStop(): FocusStop | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return null;
  const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (el.textContent ?? "").trim().slice(0, 30);
  const desc = `${el.tagName.toLowerCase()}${el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""} "${label}"`;
  const cs = getComputedStyle(el);
  const width = parseFloat(cs.outlineWidth) || 0;
  const transparent = /rgba\(.*,\s*0\)$|transparent/.test(cs.outlineColor);
  if (cs.outlineStyle === "none" || width < 1 || transparent) return { desc, ring: false, why: `outline ${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}` };
  const extent = Math.max(0, (parseFloat(cs.outlineOffset) || 0) + width);
  const r = el.getBoundingClientRect();
  const ring = { left: r.left - extent, top: r.top - extent, right: r.right + extent, bottom: r.bottom + extent };
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const acs = getComputedStyle(a);
    const clipX = acs.overflowX !== "visible";
    const clipY = acs.overflowY !== "visible";
    if (!clipX && !clipY) continue;
    const ar = a.getBoundingClientRect();
    // A scroll box scrolls the element into view; only a box with no room for the ring clips it.
    const tooWide = clipX && ring.right - ring.left > ar.width + 0.5;
    const tooTall = clipY && ring.bottom - ring.top > ar.height + 0.5;
    const scrolls = /auto|scroll/.test(acs.overflowX + acs.overflowY);
    const cutX = clipX && !scrolls && (ring.left < ar.left - 0.5 || ring.right > ar.right + 0.5);
    const cutY = clipY && !scrolls && (ring.top < ar.top - 0.5 || ring.bottom > ar.bottom + 0.5);
    if (tooWide || tooTall || cutX || cutY) {
      return { desc, ring: false, why: `ring clipped by ${a.tagName.toLowerCase()}.${[...a.classList].join(".")} (overflow ${acs.overflowX}/${acs.overflowY})` };
    }
  }
  return { desc, ring: true, why: "" };
}

const stops: FocusStop[] = [];

async function recordStop(page: Page): Promise<void> {
  const stop = await page.evaluate(focusStop);
  if (stop) stops.push(stop);
}

/** Tab (or Shift+Tab) until the focused element matches `selector`; every stop on the way is checked. */
async function tabTo(page: Page, selector: string, reverse = false): Promise<number> {
  for (let i = 1; i <= MAX_TABS; i++) {
    await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
    await recordStop(page);
    if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return i;
  }
  fail(`${MAX_TABS} ${reverse ? "Shift+Tab" : "Tab"} presses never reached ${selector}`);
}

const focusIn = (page: Page, selector: string) => page.evaluate((sel) => document.activeElement?.closest(sel) !== null && document.activeElement !== null, selector);

// ---------------------------------------------------------------------------------------------------------
// Reduced motion

const motionOffenders: string[] = [];

/** Elements (and ::before/::after) running an animation that never ends and lasts longer than a blink. */
function infiniteAnimations(): string[] {
  const out: string[] = [];
  const ms = (v: string) => Math.max(...v.split(",").map((s) => (s.trim().endsWith("ms") ? parseFloat(s) : parseFloat(s) * 1000)));
  for (const el of document.querySelectorAll("*")) {
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.animationName === "none" || cs.animationPlayState === "paused") continue;
      if (cs.animationIterationCount.includes("infinite") && ms(cs.animationDuration) > 1) {
        out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${pseudo ?? ""} ${cs.animationName} ${cs.animationDuration}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Phone layout

type Overflow = { overflow: string[]; hscroll: string[]; pageScroll: number };

/** Content past the viewport's side edges (after clipping by ancestors), sideways scroll boxes, page scroll. */
function horizontalOverflow(): Overflow {
  const vw = document.documentElement.clientWidth;
  const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${[...el.classList].slice(0, 2).join(".")}`;
  const overflow: string[] = [];
  const hscroll: string[] = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
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
    // Content sticking out of the HUD surface it belongs to (a control row wider than its bar).
    const box = el.parentElement?.closest("[data-hud-obstacle]");
    if (box && right - left > 0) {
      const br = box.getBoundingClientRect();
      if (left < br.left - 1 || right > br.right + 1) overflow.push(`${name(el)} ${Math.round(left)}..${Math.round(right)} outside ${name(box)} ${Math.round(br.left)}..${Math.round(br.right)}`);
    }
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) hscroll.push(`${name(el)} ${el.scrollWidth}>${el.clientWidth}`);
  }
  const root = document.scrollingElement ?? document.documentElement;
  return { overflow, hscroll, pageScroll: root.scrollWidth - root.clientWidth };
}

/** A bottom sheet spans the viewport's width and sits on its bottom edge. */
async function isSheet(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return Math.abs(r.left) <= 1 && Math.abs(r.right - window.innerWidth) <= 1 && Math.abs(r.bottom - window.innerHeight) <= 1;
  }, selector);
}

let mobileFailed = false;

async function mobileState(page: Page, name: string, sheet: string | null): Promise<void> {
  await page.waitForTimeout(1_500);
  const file = path.join(MOBILE_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  const o = await page.evaluate(horizontalOverflow);
  const asSheet = sheet ? await isSheet(page, sheet) : null;
  console.log(`MOBILE ${name} overflow=${o.overflow.length} hscroll=${o.hscroll.length} pagescroll=${o.pageScroll} sheet=${asSheet === null ? "-" : asSheet ? "yes" : "no"} → ${path.relative(REPO_DIR, file)}`);
  for (const line of [...o.overflow, ...o.hscroll].slice(0, 12)) log(`   ${name}: ${line}`);
  if (o.overflow.length || o.hscroll.length || o.pageScroll > 0 || asSheet === false) mobileFailed = true;
  await axeScan(page, `375 ${name}`);
}

// ---------------------------------------------------------------------------------------------------------

async function waitForData(page: Page): Promise<void> {
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && window.__inversa?.globe() !== null, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "hotspots")?.frame ?? -1) >= 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(2_000);
}

type DesktopResult = { citation: string; keyboard: boolean; reduced: boolean };

async function desktop(browser: Browser, origin: string): Promise<DesktopResult> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(TURN_TIMEOUT_MS);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(tapAgentStreams);
  await page.addInitScript(installMotionProbes);
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await waitForData(page);
  if (!(await page.locator(MISSIONS).isVisible())) fail("the missions panel is not open on desktop");
  await axeScan(page, "1440 loaded+missions");
  motionOffenders.push(...(await page.evaluate(infiniteAnimations)).map((o) => `idle ${o}`));

  // Keyboard walk. Start from the document, as after a fresh load.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const toOrb = await tabTo(page, ORB);
  log(`orb after ${toOrb} Tab`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((sel) => document.activeElement?.matches(sel) ?? false, QUESTION_BOX, { timeout: 10_000 });
  await recordStop(page);
  const stagesOpen = await page.evaluate(() => (window as unknown as { __stages: string[] }).__stages.slice());
  log(`card open, focus in the question box; stages ${stagesOpen.join(" → ")}`);

  let events = await askByKeyboard(page, QUESTION);
  if ((await page.locator(CITATION).count()) === 0 || !events.some((e) => e.type === "view")) {
    log("no citation or view on turn 1; asking the follow-up");
    if (!(await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, QUESTION_BOX))) fail("the question box lost focus after sending");
    events = [...events, ...(await askByKeyboard(page, FOLLOW_UP))];
  }
  if ((await page.locator(CITATION).count()) === 0) fail("the answer has no citations");
  const sawView = events.some((e) => e.type === "view");
  await axeScan(page, "1440 card");

  const toCite = await tabTo(page, CITATION, true);
  const citation = (await page.evaluate(() => document.activeElement?.getAttribute("data-evidence-id"))) ?? fail("focused citation without an id");
  log(`citation ${citation} after ${toCite} Shift+Tab`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((want) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent?.trim() === want, citation, { timeout: 30_000 });
  await page.waitForTimeout(500);
  if (!(await focusIn(page, DRAWER))) fail("opening evidence from a citation did not move focus into the drawer");
  await recordStop(page);
  await page.locator(`${DRAWER} section[aria-label="Normalized record"]`).waitFor({ timeout: 30_000 });
  await axeScan(page, "1440 drawer");

  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), DRAWER, { timeout: 10_000 });
  if (!(await page.evaluate((id) => document.activeElement?.getAttribute("data-evidence-id") === id, citation))) fail("Esc closed the drawer but focus did not return to the citation");
  if (!(await page.locator("[data-agent-card]").isVisible())) fail("Esc in the drawer also closed the agent card");
  log("Esc closed the drawer; focus back on the citation, card still open");

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-agent-card]"), undefined, { timeout: 10_000 });
  if (!(await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, ORB))) fail("Esc closed the card but focus did not return to the orb");
  const stages = await page.evaluate(() => (window as unknown as { __stages: string[] }).__stages.slice());
  log(`Esc closed the card; focus back on the orb; stages ${stages.join(" → ")}`);

  const toScrub = await tabTo(page, SCRUBBER, true);
  const before = (await page.evaluate(() => (window.__inversa!.state("TIME") as { at: string }).at)) ?? "";
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const back = (await page.evaluate(() => (window.__inversa!.state("TIME") as { at: string }).at)) ?? "";
  await page.keyboard.press("ArrowRight");
  const fwd = (await page.evaluate(() => (window.__inversa!.state("TIME") as { at: string }).at)) ?? "";
  const moved = Date.parse(back) < Date.parse(before) && Date.parse(fwd) > Date.parse(back);
  log(`scrubber after ${toScrub} Shift+Tab: ${before} ←← ${back} → ${fwd}`);
  if (!moved) fail("the arrow keys did not move the scrubber");
  mkdirSync(path.join(REPO_DIR, "docs/evidence"), { recursive: true });
  await page.screenshot({ path: path.join(REPO_DIR, "docs/evidence/a11y-scrubber-focus.png") });

  const toMissions = await tabTo(page, `${MISSIONS} *`, true);
  log(`missions panel after ${toMissions} Shift+Tab (${stops.at(-1)?.desc})`);

  const ringless = stops.filter((s) => !s.ring);
  const unique = [...new Map(ringless.map((s) => [s.desc, s])).values()];
  log(`${stops.length} focus stops, ${unique.length} without a visible ring`);
  for (const s of unique) log(`   no ring: ${s.desc} (${s.why})`);
  if (errors.length) log(`page errors: ${errors.join(" | ")}`);
  const keyboard = unique.length === 0 && errors.length === 0;

  // Reduced motion: the card appeared and left in place, no camera flight, no endless animation.
  const morphed = stages.some((s) => /^morph-/.test(s));
  const flightFrames = await page.evaluate(() => (window as unknown as { __flightFrames: number }).__flightFrames);
  motionOffenders.push(...(await page.evaluate(infiniteAnimations)).map((o) => `end ${o}`));
  const offenders = [...new Set(motionOffenders)];
  for (const o of offenders.slice(0, 10)) log(`   animation under reduced motion: ${o}`);
  log(`reduced motion: stages ${stages.join(",")}; view event ${sawView}; flight frames ${flightFrames}; endless animations ${offenders.length}`);
  const reduced = !morphed && sawView && flightFrames === 0 && offenders.length === 0;
  if (reduced) console.log(`REDUCED-MOTION-OK morph=instant flights=0 infinite-animations=0`);
  else console.log(`REDUCED-MOTION-FAIL morph=${morphed ? "animated" : "instant"} view=${sawView} flights=${flightFrames} infinite-animations=${offenders.length}`);

  await context.close();
  return { citation, keyboard, reduced };
}

async function phone(browser: Browser, origin: string, citation: string): Promise<void> {
  mkdirSync(MOBILE_DIR, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(LOAD_TIMEOUT_MS);
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await waitForData(page);
  await mobileState(page, "main", null);

  await page.locator(ORB).tap();
  await page.locator('[data-agent-card][data-stage="open"]').waitFor({ timeout: 10_000 });
  await page.locator(QUESTION_BOX).fill("Which feeds are stale?");
  await mobileState(page, "card-sheet", "[data-agent-card]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-agent-card]"), undefined, { timeout: 10_000 });

  // The share link carries a selection (`e=`), which opens the drawer: the citation from the desktop answer.
  await page.goto(`${origin}/#v=1&e=${encodeURIComponent(citation)}`, { waitUntil: "load" });
  await page.reload({ waitUntil: "load" });
  await waitForData(page);
  await page.locator(`${DRAWER} section[aria-label="Normalized record"]`).waitFor({ timeout: 30_000 });
  await mobileState(page, "drawer-sheet", DRAWER);
  await page.locator(DRAWER).getByRole("button", { name: "Close panel" }).tap();
  await page.waitForFunction((sel) => !document.querySelector(sel), DRAWER, { timeout: 10_000 });

  await page.locator(`[data-testid=hud-missions-tab]`).tap();
  await page.locator(MISSIONS).waitFor({ timeout: 10_000 });
  await mobileState(page, "missions-sheet", MISSIONS);
  await context.close();
}

async function main() {
  buildApi(log);
  buildWeb(log);
  const nextPrefix = process.env.OPENROUTER_API_KEY ? [] : DOPPLER;
  log(nextPrefix.length ? "model key from Doppler (inversa/dev)" : "model key from the environment");
  const stack = await startStack({ name: "a11y", scene: true, nextPrefix });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let ok = true;
  try {
    const d = await desktop(browser, stack.origin);
    await phone(browser, stack.origin, d.citation);
    const impacts = [...axeFindings.values()];
    const serious = impacts.filter((i) => i === "serious").length;
    const critical = impacts.filter((i) => i === "critical").length;
    console.log(`AXE serious=${serious} critical=${critical} (scans: 1440 loaded+missions, card, drawer; 375 main, card, drawer, missions)`);
    if (d.keyboard) console.log("KEYBOARD-OK");
    else console.log("KEYBOARD-FAIL");
    ok = serious === 0 && critical === 0 && d.keyboard && d.reduced && !mobileFailed;
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
    ok = false;
  } finally {
    await browser.close();
    await stack.stop();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
