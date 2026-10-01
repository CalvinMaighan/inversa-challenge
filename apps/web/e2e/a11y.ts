/**
 * Accessibility, keyboard, phone layout and reduced motion (gates/leaf-T30.md) on the real stack (e2e/stack.ts)
 * with the real agent (Doppler inversa/dev hands the Next server its model key; the key is never printed).
 *
 *   bun run e2e:a11y           build, run, print the AXE, KEYBOARD, MOBILE and REDUCED-MOTION lines
 *   … -- --app carp|lionfish   the same over that app's UI (default python, described below)
 *   E2E_SKIP_BUILD=1 …         reuse the last e2e build
 *
 * Lines (every one carries the app): `AXE app=<id> serious=<n> critical=<n> scans=<n> (labels)`, full-page
 * scans with serious and critical violations counted once per rule and element; `KEYBOARD-OK app=<id>` only
 * when the app's keyboard path held with a focus ring on every stop (else KEYBOARD-FAIL); `MOBILE app=<id>
 * <state> …` per phone state.
 *
 * Carp (wall clock, like e2e/carp.ts): scans at load, with a briefing drawer open, in as-of mode, with the
 * Layers legend open, in light theme with a drawer, and at 375×812 at load, with the board sheet and with the
 * drawer sheet. Keyboard: Tab to a board row, Enter opens its drawer with focus inside, Esc closes it back to
 * the row; Enter on a map marker opens its site; the stage scrubber goes as-of on an arrow and back to live
 * on End; About opens with focus inside, More data, Tab into the legend, Esc back to the button.
 *
 * Lionfish Watch (page clock 2026-10-01T09:00Z, like e2e/lionfish.ts): scans at load with the banner, with a
 * priority card open, with the ocean-data guide open, with the legend, in light theme with a card, and at
 * 375×812 at load, with the survey sheet and with the card. Keyboard: Enter on an area chip flies there,
 * Space toggles a layer switch, Enter on a ranked place opens its card with focus inside, Enter on the card's
 * guide button moves focus into the guide, Esc returns to the button, Esc again closes the card back to the
 * row; About as for carp.
 *
 * Python:
 * The layout is T40's with T41's chrome: the chat column (Agent and Missions tabs) left of the globe pane, a
 * bottom sheet with collapsed / half / full snaps on phones; in the globe pane the species chips, the About (ⓘ)
 * and Theme icon buttons with their popovers (the Layers legend and Help inside About), the help sheet and the
 * evidence drawer.
 *
 * 1. axe-core (from node_modules, injected into the page) scans the ops page `/` at 1440×900 with data loaded,
 *    after a cited answer, with the evidence drawer open, with the Layers legend open, with the theme popover
 *    open, with the help sheet open and on the Missions tab; and at 375×812 in each phone state below. Serious
 *    and critical violations are counted once per rule and element: `AXE serious=<n> critical=<n>`.
 * 2. Keyboard only (Tab, Shift+Tab, Enter, Esc, arrows): reach the chat composer, type and send, reach a
 *    citation, open the drawer (focus moves into it), close it with Esc (focus returns to the citation), reach
 *    the timeline scrubber and move it with the arrow keys, toggle a species chip with Enter, open About and
 *    its More data section and Tab into the legend, close it with Esc (focus returns to About), open and close
 *    Theme the same way, open the help sheet from About and close it with Esc (focus returns to About),
 *    switch to the Missions tab with the arrow keys and Tab into it. Every stop must show a focus ring (a
 *    non-zero outline that no ancestor clips). `KEYBOARD-OK` when all of that held.
 * 3. 375×812 screenshots in docs/evidence/mobile/: main view (sheet collapsed to the composer), chat as a half
 *    sheet, drawer as a sheet, Missions tab, Layers legend, help sheet. Each state is checked for horizontal
 *    page scroll, content past the viewport edge or out of its HUD surface, and sideways scrolling boxes:
 *    `MOBILE <state> overflow=<n> hscroll=<n> sheet=<yes|no|->`.
 * 4. Both runs use `prefers-reduced-motion: reduce`: the agent's camera move must not fly (the globe's
 *    "flight" render hold never shows up), the phone sheet must snap without a transition, and no infinite
 *    CSS animation may run (live pulses, working rows, voice dots). `REDUCED-MOTION-OK`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { getApp } from "../shared/apps";
import { appArg } from "./args";
import { APP_DIR, buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);
const MOBILE_DIR = path.join(REPO_DIR, "docs/evidence/mobile");
const QUESTION =
  "Fly the map to Shark Valley and show me the Burmese python sightings there around 17:00 UTC on 1 February 2026, during the cold snap. Cite the sighting records.";
const FOLLOW_UP = "Please move the map to those sightings with set_view (time 2026-02-01T17:00:00Z) and cite each sighting record you used.";
const TURN_TIMEOUT_MS = 240_000;
const LOAD_TIMEOUT_MS = 120_000;
const MAX_TABS = 400;
const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];

const COLUMN = "[data-chat-column]";
const QUESTION_BOX = '[data-chat-column] textarea[aria-label="Question"]';
const CITATION = "[data-chat-column] [data-evidence-id]";
const DRAWER = "[data-testid=hud-drawer]";
const SCRUBBER = "[data-hud-scrubber]";
/** T41: the About (ⓘ) and Theme icon buttons; Layers and Help live inside About. */
const STATUS_BUTTON = "[data-testid=status-button]";
const STATUS_POPOVER = "[data-testid=status-popover]";
const THEME_BUTTON = "[data-testid=theme-button]";
const THEME_POPOVER = "[data-testid=theme-popover]";
const PYTHON_CHIP = '[data-species-chip="python"]';
const LAYERS_BUTTON = "[data-testid=layers-button]";
const LEGEND = "[data-testid=layers-legend]";
const HELP_BUTTON = "[data-testid=help-button]";
const HELP = "[data-testid=help-sheet]";
const AGENT_TAB = "#chat-tab-agent";
const MISSIONS_TAB = "#chat-tab-board";
const MISSIONS = "[data-testid=hud-missions]";

/** `--app <id>` (default python): the app whose UI is scanned and walked. */
const APP = appArg();

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

const axeScans: string[] = [];

async function axeScan(page: Page, label: string): Promise<void> {
  axeScans.push(label);
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

/** Motion probe, installed before the page loads: every frame on which the globe's render governor holds for a camera flight. */
function installMotionProbes(): void {
  const w = window as unknown as { __flightFrames: number };
  w.__flightFrames = 0;
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
    () => !document.querySelector('[data-chat-column] [data-status="streaming"], [data-chat-column] [data-status="pending"]'),
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
  let wider = false;
  let taller = false;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const acs = getComputedStyle(a);
    const clipX = acs.overflowX !== "visible";
    const clipY = acs.overflowY !== "visible";
    if (!clipX && !clipY) continue;
    const ar = a.getBoundingClientRect();
    // Tab has already scrolled the element into view, so any cut is what the user sees. An element larger
    // than its scroll box on one axis (a wide table row) cannot fit there; its ring still shows on the
    // other axis, so that axis is not judged.
    // Once a box is too small on an axis, outer boxes on that axis are not judged either: it already clips.
    wider ||= r.width > ar.width + 0.5;
    taller ||= r.height > ar.height + 0.5;
    const cutX = clipX && !wider && (ring.left < ar.left - 0.5 || ring.right > ar.right + 0.5);
    const cutY = clipY && !taller && (ring.top < ar.top - 0.5 || ring.bottom > ar.bottom + 0.5);
    if (cutX || cutY) {
      const box = (b: { left: number; top: number; right: number; bottom: number }) => [b.left, b.top, b.right, b.bottom].map(Math.round).join(",");
      return {
        desc,
        ring: false,
        why: `ring ${box(ring)} (offset ${cs.outlineOffset}) clipped by ${a.tagName.toLowerCase()}.${[...a.classList].join(".")} ${box(ar)} (overflow ${acs.overflowX}/${acs.overflowY})`,
      };
    }
  }
  return { desc, ring: true, why: "" };
}

const stops: FocusStop[] = [];

async function recordStop(page: Page): Promise<void> {
  // Two frames: the reduced-motion reset gives every property a 0.01 ms transition, so styles read in the
  // same task as the focus change still show the unfocused start value.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
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

/**
 * A bottom sheet spans the viewport's width and sits on its bottom edge, or (the evidence drawer) on the top
 * of the collapsed chat sheet, which keeps the composer showing below it.
 */
async function isSheet(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    ([sel, column]) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const chat = el.matches(column) ? null : document.querySelector(column)?.getBoundingClientRect();
      const floor = (y: number) => Math.abs(y - window.innerHeight) <= 1 || (chat !== null && chat !== undefined && Math.abs(y - chat.top) <= 1);
      return Math.abs(r.left) <= 1 && Math.abs(r.right - window.innerWidth) <= 1 && floor(r.bottom);
    },
    [selector, COLUMN] as const,
  );
}

let mobileFailed = false;

async function mobileState(page: Page, name: string, sheet: string | null): Promise<void> {
  await page.waitForTimeout(1_500);
  const file = path.join(MOBILE_DIR, APP === "python" ? `${name}.png` : `${APP}-${name}.png`);
  await page.screenshot({ path: file });
  const o = await page.evaluate(horizontalOverflow);
  const asSheet = sheet ? await isSheet(page, sheet) : null;
  console.log(`MOBILE app=${APP} ${name} overflow=${o.overflow.length} hscroll=${o.hscroll.length} pagescroll=${o.pageScroll} sheet=${asSheet === null ? "-" : asSheet ? "yes" : "no"} → ${path.relative(REPO_DIR, file)}`);
  for (const line of [...o.overflow, ...o.hscroll].slice(0, 12)) log(`   ${name}: ${line}`);
  if (o.overflow.length || o.hscroll.length || o.pageScroll > 0 || asSheet === false) mobileFailed = true;
  await axeScan(page, `375 ${APP === "python" ? "" : `${APP} `}${name}`);
}

// ---------------------------------------------------------------------------------------------------------

async function waitForData(page: Page): Promise<void> {
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && window.__inversa?.globe() !== null, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.frame ?? -1) >= 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(2_000);
}


const isFocused = (page: Page, selector: string) => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);

const timeAt = (page: Page) => page.evaluate(() => (window.__inversa!.state("TIME") as { at: string }).at ?? "");

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
  if (!(await page.locator(COLUMN).isVisible())) fail("the chat column is not visible on desktop");
  await axeScan(page, "1440 loaded");
  motionOffenders.push(...(await page.evaluate(infiniteAnimations)).map((o) => `idle ${o}`));

  // Keyboard walk. Start from the document, as after a fresh load.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const toComposer = await tabTo(page, QUESTION_BOX);
  log(`composer after ${toComposer} Tab`);

  let events = await askByKeyboard(page, QUESTION);
  if ((await page.locator(CITATION).count()) === 0 || !events.some((e) => e.type === "view")) {
    log("no citation or view on turn 1; asking the follow-up");
    if (!(await isFocused(page, QUESTION_BOX))) fail("the question box lost focus after sending");
    events = [...events, ...(await askByKeyboard(page, FOLLOW_UP))];
  }
  if ((await page.locator(CITATION).count()) === 0) fail("the answer has no citations");
  const sawView = events.some((e) => e.type === "view");
  await axeScan(page, "1440 answer");

  // Citation → drawer → Esc.
  const toCite = await tabTo(page, CITATION, true);
  const citation = (await page.evaluate(() => document.activeElement?.getAttribute("data-evidence-id"))) ?? fail("focused citation without an id");
  log(`citation ${citation} after ${toCite} Shift+Tab`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((want) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent?.trim() === want, citation, { timeout: 30_000 });
  await page.waitForTimeout(500);
  if (!(await focusIn(page, DRAWER))) fail("opening evidence from a citation did not move focus into the drawer");
  await recordStop(page);
  await page.locator(`${DRAWER} section[aria-label="Normalized record"]`).waitFor({ state: "attached", timeout: 30_000 });
  await axeScan(page, "1440 drawer");
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), DRAWER, { timeout: 10_000 });
  if (!(await page.evaluate((id) => document.activeElement?.getAttribute("data-evidence-id") === id, citation))) fail("Esc closed the drawer but focus did not return to the citation");
  log("Esc closed the drawer; focus back on the citation");

  // Timeline scrubber, moved with the arrow keys.
  const toScrub = await tabTo(page, SCRUBBER);
  const before = await timeAt(page);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const back = await timeAt(page);
  await page.keyboard.press("ArrowRight");
  const fwd = await timeAt(page);
  log(`scrubber after ${toScrub} Tab: ${before} ←← ${back} → ${fwd}`);
  if (!(Date.parse(back) < Date.parse(before) && Date.parse(fwd) > Date.parse(back))) fail("the arrow keys did not move the scrubber");
  mkdirSync(path.join(REPO_DIR, "docs/evidence"), { recursive: true });
  await page.screenshot({ path: path.join(REPO_DIR, "docs/evidence/a11y-scrubber-focus.png") });

  // Species chip (T41): reach it, Enter hides the species, Enter again shows it.
  const toChip = await tabTo(page, PYTHON_CHIP);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window.__inversa!.state("LAYERS") as { species: Record<string, unknown> }).species.python === false, undefined, { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window.__inversa!.state("LAYERS") as { species: Record<string, unknown> }).species.python !== false, undefined, { timeout: 10_000 });
  await recordStop(page);
  log(`species chip after ${toChip} Tab: Enter hid and showed python`);

  // About (ⓘ): Enter opens it with focus inside; More data opens the Layers legend; Tab reaches the legend; Esc
  // closes the popover and hands focus back to the button.
  const toAbout = await tabTo(page, STATUS_BUTTON);
  await page.keyboard.press("Enter");
  await page.locator(STATUS_POPOVER).waitFor({ timeout: 10_000 });
  if (!(await focusIn(page, STATUS_POPOVER))) fail("opening About did not move focus into its popover");
  await tabTo(page, LAYERS_BUTTON);
  await page.keyboard.press("Enter");
  await page.locator(LEGEND).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Tab");
  await recordStop(page);
  if (!(await focusIn(page, LEGEND))) fail("Tab after opening More data did not land in the legend");
  await axeScan(page, "1440 legend");
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), STATUS_POPOVER, { timeout: 10_000 });
  if (!(await isFocused(page, STATUS_BUTTON))) fail("Esc closed About but focus did not return to its button");
  log(`About after ${toAbout} Tab: opened, More data → legend entered, Esc back to the button`);

  // Theme: Enter opens the choices, Esc returns to the button.
  const toTheme = await tabTo(page, THEME_BUTTON);
  await page.keyboard.press("Enter");
  await page.locator(THEME_POPOVER).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Tab");
  await recordStop(page);
  await axeScan(page, "1440 theme");
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), THEME_POPOVER, { timeout: 10_000 });
  if (!(await isFocused(page, THEME_BUTTON))) fail("Esc closed Theme but focus did not return to its button");
  log(`Theme after ${toTheme} Tab: opened, Esc back to the button`);

  // Help sheet (About → Help): focus moves into the sheet, Esc closes it back to the About button.
  await tabTo(page, STATUS_BUTTON);
  await page.keyboard.press("Enter");
  await page.locator(STATUS_POPOVER).waitFor({ timeout: 10_000 });
  const toHelp = await tabTo(page, HELP_BUTTON);
  await page.keyboard.press("Enter");
  await page.locator(HELP).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(200);
  if (!(await focusIn(page, HELP))) fail("opening help did not move focus into the sheet");
  await recordStop(page);
  await axeScan(page, "1440 help");
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), HELP, { timeout: 10_000 });
  if (!(await isFocused(page, STATUS_BUTTON))) fail("Esc closed help but focus did not return to the About button");
  log(`help after ${toHelp} Tab inside About: opened, Esc back to the About button`);

  // Missions tab: reach the selected tab, arrow to Missions, Tab into the board.
  const toTab = await tabTo(page, AGENT_TAB);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-selected") === "true", MISSIONS_TAB, { timeout: 10_000 });
  if (!(await isFocused(page, MISSIONS_TAB))) fail("ArrowRight selected Missions but focus did not follow");
  await recordStop(page);
  const intoBoard = await tabTo(page, `${MISSIONS} *`);
  log(`Missions tab after ${toTab} Tab + ArrowRight; board after ${intoBoard} Tab (${stops.at(-1)?.desc})`);
  await axeScan(page, "1440 missions");

  const ringless = stops.filter((s) => !s.ring);
  const unique = [...new Map(ringless.map((s) => [s.desc, s])).values()];
  log(`${stops.length} focus stops, ${unique.length} without a visible ring`);
  for (const s of unique) log(`   no ring: ${s.desc} (${s.why})`);
  if (errors.length) log(`page errors: ${errors.join(" | ")}`);
  const keyboard = unique.length === 0 && errors.length === 0;

  // Reduced motion: no camera flight for the answer's view, no endless animation.
  const flightFrames = await page.evaluate(() => (window as unknown as { __flightFrames: number }).__flightFrames);
  motionOffenders.push(...(await page.evaluate(infiniteAnimations)).map((o) => `end ${o}`));
  log(`reduced motion (desktop): view event ${sawView}; flight frames ${flightFrames}`);
  await context.close();
  return { citation, keyboard, reduced: sawView && flightFrames === 0 };
}

const sheetSnap = (page: Page) => page.evaluate((sel) => document.querySelector(sel)?.getAttribute("data-sheet") ?? null, COLUMN);

async function phone(browser: Browser, origin: string, citation: string): Promise<boolean> {
  mkdirSync(MOBILE_DIR, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(LOAD_TIMEOUT_MS);
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await waitForData(page);
  if ((await sheetSnap(page)) !== "collapsed") fail(`phone chat sheet starts ${await sheetSnap(page)}, not collapsed`);
  const sheetMs = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute("data-motion-ms") ?? null, COLUMN);
  log(`phone sheet motion under reduced motion: ${sheetMs} ms`);
  await mobileState(page, "main", COLUMN);

  // Chat as a half sheet: focusing the composer grows it.
  await page.locator(QUESTION_BOX).tap();
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-sheet") === "half", COLUMN, { timeout: 10_000 });
  await page.locator(QUESTION_BOX).fill("Which feeds are stale?");
  await mobileState(page, "chat-sheet", COLUMN);

  // Missions tab inside the sheet.
  await page.locator(MISSIONS_TAB).tap();
  await page.locator(MISSIONS).waitFor({ state: "visible", timeout: 10_000 });
  await mobileState(page, "missions-sheet", COLUMN);
  await page.locator(AGENT_TAB).tap();

  // The share link carries a selection (`e=`), which opens the drawer: the citation from the desktop answer.
  await page.goto(`${origin}/#v=1&e=${encodeURIComponent(citation)}`, { waitUntil: "load" });
  await page.reload({ waitUntil: "load" });
  await waitForData(page);
  await page.locator(`${DRAWER} section[aria-label="Normalized record"]`).waitFor({ state: "attached", timeout: 30_000 });
  await mobileState(page, "drawer-sheet", DRAWER);
  await page.locator(DRAWER).getByRole("button", { name: "Close panel" }).tap();
  await page.waitForFunction((sel) => !document.querySelector(sel), DRAWER, { timeout: 10_000 });

  // About on a phone: the popover, then More data (the legend), closed with its button.
  await page.locator(STATUS_BUTTON).tap();
  await page.locator(STATUS_POPOVER).waitFor({ timeout: 10_000 });
  await page.locator(LAYERS_BUTTON).tap();
  await page.locator(LEGEND).waitFor({ timeout: 10_000 });
  await mobileState(page, "legend", null);
  await page.locator(STATUS_BUTTON).tap();
  await page.waitForFunction((sel) => !document.querySelector(sel), STATUS_POPOVER, { timeout: 10_000 });

  await page.locator(STATUS_BUTTON).tap();
  await page.locator(HELP_BUTTON).tap();
  await page.locator(HELP).waitFor({ timeout: 10_000 });
  await mobileState(page, "help", null);
  await context.close();
  return sheetMs === "0";
}

// ---------------------------------------------------------------------------------------------------------
// Carp and Lionfish Watch: the same scans, keyboard rings and phone checks over each app's own controls.

type ContextOpts = { width: number; height: number; mobile?: boolean; light?: boolean; clockMs?: number };

async function appPage(browser: Browser, o: ContextOpts): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: o.mobile ? 2 : 1,
    isMobile: o.mobile ?? false,
    hasTouch: o.mobile ?? false,
    reducedMotion: "reduce",
  });
  if (o.light) await context.addInitScript(() => localStorage.setItem("inversa:THEME", JSON.stringify("light")));
  const page = await context.newPage();
  page.setDefaultTimeout(LOAD_TIMEOUT_MS);
  if (o.clockMs !== undefined) await page.clock.setFixedTime(o.clockMs);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors, close: () => context.close() };
}

async function requireLight(page: Page): Promise<void> {
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "light") fail("light theme not applied");
}

/** Keyboard checks: each named step held, every focus stop shows a ring, no page error. */
function keyboardVerdict(steps: Record<string, boolean>, errors: string[]): boolean {
  const failed = Object.entries(steps).filter(([, v]) => !v).map(([k]) => k);
  log(`keyboard steps: ${Object.entries(steps).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const ringless = [...new Map(stops.filter((s) => !s.ring).map((s) => [s.desc, s])).values()];
  log(`${stops.length} focus stops, ${ringless.length} without a visible ring`);
  for (const s of ringless) log(`   no ring: ${s.desc} (${s.why})`);
  if (errors.length) log(`page errors: ${errors.join(" | ")}`);
  return failed.length === 0 && ringless.length === 0 && errors.length === 0;
}

/** About (ⓘ) by keyboard: focus moves into the popover, More data opens the legend, Esc returns to the button. */
async function aboutByKeyboard(page: Page, label: string): Promise<boolean> {
  await tabTo(page, STATUS_BUTTON);
  await page.keyboard.press("Enter");
  await page.locator(STATUS_POPOVER).waitFor({ timeout: 10_000 });
  const inside = await focusIn(page, STATUS_POPOVER);
  await tabTo(page, LAYERS_BUTTON);
  await page.keyboard.press("Enter");
  await page.locator(LEGEND).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Tab");
  await recordStop(page);
  const inLegend = await focusIn(page, LEGEND);
  await axeScan(page, `${label} legend`);
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => !document.querySelector(sel), STATUS_POPOVER, { timeout: 10_000 });
  const back = await isFocused(page, STATUS_BUTTON);
  log(`About: focus inside=${inside} legend=${inLegend} Esc back=${back}`);
  return inside && inLegend && back;
}

const CARP_ROW = "[data-carp-row]";
const CARP_DRAWER = '[data-testid="carp-drawer"]';
const CARP_DRAWER_PANEL = '[data-testid="carp-drawer-panel"]';
const CARP_TIMELINE = '[data-testid="carp-timeline"]';

async function carpReady(page: Page): Promise<void> {
  await page.locator('[data-testid="app-select-button"][data-app="carp"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(
    () => document.querySelectorAll("[data-carp-row]").length === 8 && [...document.querySelectorAll("[data-carp-site]")].every((m) => m.getAttribute("data-status") !== "loading"),
    undefined,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

const carpBriefing = (page: Page, lid: string) => page.locator(`${CARP_DRAWER}[data-site="${lid}"] [data-testid="carp-changed"]`).waitFor({ timeout: 30_000 });
const carpMode = (page: Page) => page.getAttribute(CARP_TIMELINE, "data-mode");

async function carpDesktop(browser: Browser, origin: string): Promise<boolean> {
  const { page, errors, close } = await appPage(browser, { width: 1440, height: 900 });
  await page.goto(`${origin}/?app=carp`, { waitUntil: "load" });
  await carpReady(page);
  await page.waitForTimeout(1_000);
  await axeScan(page, "carp 1440 loaded");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Board row: Enter opens the briefing drawer with focus inside; Esc closes it and focus returns to the row.
  const toRow = await tabTo(page, CARP_ROW);
  const lid = (await page.evaluate(() => document.activeElement?.getAttribute("data-carp-row"))) ?? fail("focused row without a site");
  await page.keyboard.press("Enter");
  await page.locator(`${CARP_DRAWER}[data-site="${lid}"]`).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const rowInDrawer = await focusIn(page, CARP_DRAWER_PANEL);
  await recordStop(page);
  await carpBriefing(page, lid);
  await axeScan(page, "carp 1440 drawer");
  await page.keyboard.press("Escape");
  await page.locator(CARP_DRAWER).waitFor({ state: "detached", timeout: 10_000 });
  const rowBack = await page.evaluate((id) => document.activeElement?.getAttribute("data-carp-row") === id, lid);
  log(`board row ${lid} after ${toRow} Tab: drawer focus=${rowInDrawer}, Esc back=${rowBack}`);

  // Map marker: Enter opens that site.
  const toMarker = await tabTo(page, "[data-carp-site]:not([data-hidden])");
  const site = (await page.evaluate(() => document.activeElement?.getAttribute("data-carp-site"))) ?? fail("focused marker without a site");
  await page.keyboard.press("Enter");
  const markerOpens = await page
    .locator(`${CARP_DRAWER}[data-site="${site}"]`)
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  log(`marker ${site} after ${toMarker} Tab: drawer=${markerOpens}`);

  // Stage scrubber: an arrow goes back in time (as-of), End returns to live.
  const toScrub = await tabTo(page, "[data-carp-scrubber]");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("PageDown");
  const asof = await page
    .waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-mode") === "asof", CARP_TIMELINE, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const asofMode = await carpMode(page);
  await axeScan(page, "carp 1440 as-of");
  await page.keyboard.press("End");
  const live = await page
    .waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-mode") === "live", CARP_TIMELINE, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  log(`scrubber after ${toScrub} Tab: as-of=${asof} (${asofMode}), End live=${live} (${await carpMode(page)})`);

  const about = await aboutByKeyboard(page, "carp 1440");
  const keyboard = keyboardVerdict({ rowInDrawer, rowBack, markerOpens, asof, live, about }, errors);
  await close();

  const light = await appPage(browser, { width: 1440, height: 900, light: true });
  await light.page.goto(`${origin}/?app=carp#v=2&app=carp&site=MCGL1`, { waitUntil: "load" });
  await carpReady(light.page);
  await carpBriefing(light.page, "MCGL1");
  await requireLight(light.page);
  await axeScan(light.page, "carp 1440 light drawer");
  await light.close();
  return keyboard;
}

async function carpPhone(browser: Browser, origin: string): Promise<void> {
  mkdirSync(MOBILE_DIR, { recursive: true });
  const { page, close } = await appPage(browser, { width: 375, height: 812, mobile: true });
  await page.goto(`${origin}/?app=carp`, { waitUntil: "load" });
  await page.locator('[data-testid="carp-board-panel-tab"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => [...document.querySelectorAll("[data-carp-site]")].every((m) => m.getAttribute("data-status") !== "loading"), undefined, { timeout: LOAD_TIMEOUT_MS });
  await mobileState(page, "main", COLUMN);
  await page.locator('[data-testid="carp-board-panel-tab"]').tap();
  await carpReady(page);
  await mobileState(page, "board", '[data-testid="carp-board-panel"]');
  await page.locator('[data-carp-row="KRZL1"]').tap();
  await carpBriefing(page, "KRZL1");
  await mobileState(page, "drawer", CARP_DRAWER_PANEL);
  await close();
}

const LIONFISH = getApp("lionfish");
const LIONFISH_LIVE_MS = Date.parse("2026-10-01T09:00:00Z");
const CARD = '[data-testid="lionfish-card"] [data-testid="lionfish-components"]';
const CARD_PANEL = '[data-testid="lionfish-card-panel"]';
const GUIDE = '[data-testid="lionfish-help"]';

async function lionfishReady(page: Page): Promise<void> {
  await page.locator('[data-testid="app-select-button"][data-app="lionfish"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.locator('[data-testid="lionfish-hud"][data-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
}

async function dismissBanner(page: Page): Promise<void> {
  const dismiss = page.locator('[data-testid="lionfish-banner-dismiss"]');
  if (await dismiss.count()) await dismiss.click();
}

async function lionfishDesktop(browser: Browser, origin: string): Promise<boolean> {
  const { page, errors, close } = await appPage(browser, { width: 1440, height: 900, clockMs: LIONFISH_LIVE_MS });
  await page.goto(`${origin}/?app=lionfish`, { waitUntil: "load" });
  await lionfishReady(page);
  await page.waitForTimeout(1_000);
  await axeScan(page, "lionfish 1440 loaded (banner)");
  await dismissBanner(page);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Area chip: Enter flies there; Enter again shows every area.
  const toChip = await tabTo(page, "[data-area]");
  const areaId = (await page.evaluate(() => document.activeElement?.getAttribute("data-area"))) ?? fail("focused chip without an area");
  const region = LIONFISH.regions.find((r) => r.id === areaId) ?? fail(`unknown area ${areaId}`);
  await page.keyboard.press("Enter");
  const pressed = (await page.getAttribute(`[data-area="${areaId}"]`, "aria-pressed")) === "true";
  const flew = await page
    .waitForFunction(
      ({ lat, lon }) => {
        const v = window.__inversa?.state("VIEW") as { lat: number; lon: number } | undefined;
        return !!v && Math.abs(v.lat - lat) < 0.3 && Math.abs(v.lon - lon) < 0.3;
      },
      { lat: region.camera.lat, lon: region.camera.lon },
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  await page.keyboard.press("Enter");
  const unpressed = (await page.getAttribute(`[data-area="${areaId}"]`, "aria-pressed")) === "false";
  log(`area ${areaId} after ${toChip} Tab: pressed=${pressed} flew=${flew} Enter again=${unpressed}`);

  // Layer switch: Space turns the heat layer off and on.
  const toLayer = await tabTo(page, 'input[data-layer="heat"]');
  await page.keyboard.press("Space");
  const layerOff = !(await page.isChecked('input[data-layer="heat"]'));
  await page.keyboard.press("Space");
  const layerOn = await page.isChecked('input[data-layer="heat"]');
  log(`heat switch after ${toLayer} Tab: Space off=${layerOff} Space on=${layerOn}`);

  // Ranked place: Enter opens its card with focus inside; the guide opens from the card; Esc twice walks back.
  const toRow = await tabTo(page, "[data-cell-row]");
  const cell = (await page.evaluate(() => document.activeElement?.getAttribute("data-cell-row"))) ?? fail("focused row without a cell");
  await page.keyboard.press("Enter");
  await page.locator(CARD).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(300);
  const inCard = await focusIn(page, CARD_PANEL);
  await recordStop(page);
  await axeScan(page, "lionfish 1440 card");
  await tabTo(page, '[data-testid="lionfish-card-help"]');
  await page.keyboard.press("Enter");
  await page.locator(GUIDE).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const inGuide = await focusIn(page, GUIDE);
  await recordStop(page);
  await axeScan(page, "lionfish 1440 guide");
  await page.keyboard.press("Escape");
  await page.locator(GUIDE).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  const guideBack = await isFocused(page, '[data-testid="lionfish-card-help"]');
  await page.keyboard.press("Escape");
  const cardClosed = await page
    .locator(CARD_PANEL)
    .waitFor({ state: "detached", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const rowBack = await page.evaluate((c) => document.activeElement?.getAttribute("data-cell-row") === c, cell);
  log(`place ${cell} after ${toRow} Tab: card focus=${inCard} guide focus=${inGuide} Esc→guide button=${guideBack} Esc→card closed=${cardClosed} row=${rowBack}`);

  const about = await aboutByKeyboard(page, "lionfish 1440");
  const keyboard = keyboardVerdict({ pressed, flew, unpressed, layerOff, layerOn, inCard, inGuide, guideBack, cardClosed, rowBack, about }, errors);
  await close();

  const light = await appPage(browser, { width: 1440, height: 900, light: true, clockMs: LIONFISH_LIVE_MS });
  await light.page.goto(`${origin}/?app=lionfish`, { waitUntil: "load" });
  await lionfishReady(light.page);
  await requireLight(light.page);
  await dismissBanner(light.page);
  await light.page.click('[data-area="fl-keys"]');
  await light.page.click(`[data-cell-row="${(await light.page.getAttribute("[data-cell-row]", "data-cell-row"))!}"]`);
  await light.page.locator(CARD).waitFor({ timeout: 30_000 });
  await axeScan(light.page, "lionfish 1440 light card");
  await light.close();
  return keyboard;
}

async function lionfishPhone(browser: Browser, origin: string): Promise<void> {
  mkdirSync(MOBILE_DIR, { recursive: true });
  const { page, close } = await appPage(browser, { width: 375, height: 812, mobile: true, clockMs: LIONFISH_LIVE_MS });
  await page.goto(`${origin}/?app=lionfish`, { waitUntil: "load" });
  await lionfishReady(page);
  await mobileState(page, "main", COLUMN);
  await dismissBanner(page);
  await page.locator('[data-testid="lionfish-panel-tab"]').tap();
  await page.locator('[data-testid="lionfish-panel"]').waitFor();
  await mobileState(page, "panel", '[data-testid="lionfish-panel"]');
  await page.locator('[data-area="fl-keys"]').tap();
  await page.locator('[data-testid="lionfish-panel-tab"]').tap();
  const row = (await page.getAttribute("[data-cell-row]", "data-cell-row")) ?? fail("no ranked place on the phone");
  await page.locator(`[data-cell-row="${row}"]`).tap();
  await page.locator(CARD).waitFor({ timeout: 30_000 });
  await mobileState(page, "card", CARD_PANEL);
  await close();
}

function printAxe(): { serious: number; critical: number } {
  const impacts = [...axeFindings.values()];
  const serious = impacts.filter((i) => i === "serious").length;
  const critical = impacts.filter((i) => i === "critical").length;
  for (const [k, impact] of axeFindings) if (impact === "serious" || impact === "critical") log(`   ${impact}: ${k}`);
  console.log(`AXE app=${APP} serious=${serious} critical=${critical} scans=${axeScans.length} (${axeScans.join(", ")})`);
  return { serious, critical };
}

async function main() {
  buildApi(log);
  buildWeb(log);
  const nextPrefix = process.env.OPENROUTER_API_KEY ? [] : DOPPLER;
  log(nextPrefix.length ? "model key from Doppler (inversa/dev)" : "model key from the environment");
  const stack = await startStack({ name: "a11y", app: APP, apps: [APP], scene: APP === "python", nextPrefix });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let ok = true;
  try {
    if (APP !== "python") {
      let keyboard = false;
      try {
        keyboard = APP === "carp" ? await carpDesktop(browser, stack.origin) : await lionfishDesktop(browser, stack.origin);
      } catch (err) {
        log(`desktop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await (APP === "carp" ? carpPhone(browser, stack.origin) : lionfishPhone(browser, stack.origin));
      } catch (err) {
        log(`phone failed: ${err instanceof Error ? err.message : String(err)}`);
        mobileFailed = true;
      }
      const { serious, critical } = printAxe();
      console.log(keyboard ? `KEYBOARD-OK app=${APP}` : `KEYBOARD-FAIL app=${APP}`);
      ok = serious === 0 && critical === 0 && keyboard && !mobileFailed;
    } else {
      const d = await desktop(browser, stack.origin);
      const sheetSnaps = await phone(browser, stack.origin, d.citation);
      const offenders = [...new Set(motionOffenders)];
      for (const o of offenders.slice(0, 10)) log(`   animation under reduced motion: ${o}`);
      const reduced = d.reduced && sheetSnaps && offenders.length === 0;
      console.log(
        reduced
          ? "REDUCED-MOTION-OK flights=0 sheet=instant infinite-animations=0"
          : `REDUCED-MOTION-FAIL flights-ok=${d.reduced} sheet-instant=${sheetSnaps} infinite-animations=${offenders.length}`,
      );
      const { serious, critical } = printAxe();
      console.log(d.keyboard ? `KEYBOARD-OK app=${APP}` : `KEYBOARD-FAIL app=${APP}`);
      ok = serious === 0 && critical === 0 && d.keyboard && reduced && !mobileFailed;
    }
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
