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
 *
 * GE7 (gates/leaf-GE7.md), on the same stack with every app's fixtures, at 1440×900 and 1024×768:
 *   FRAMING: framed targets land inside the stage circle and under no card or bar: the real agent's `set_view`
 *     (one turn through the chat card, OpenRouter via Doppler; 1440 only), a python marker clicked off centre (at
 *     1024 the sighting card opens over it and the camera glides it back into view), carp's first view of its
 *     eight sites and a lionfish area chosen in the survey panel. Each target's points are projected with the
 *     globe's own `project` (read only). `FRAMING inside=<n> outside=<m>`.
 *   PANELS: carp's "Locations to review" and the lionfish survey panel sit in the right card region, clear of the
 *     circle's centre (the centre point hits the globe). `PANELS carp=ok lionfish=ok`.
 *   LAYERSBAR: the bottom bar's Layers button opens its popover in each app; it lists the switches, a Ships group
 *     in carp and lionfish only, Water and weather everywhere, only sightings and notes on at first load, and the
 *     keyboard walk (Enter opens with focus inside, Tab reaches a switch, Esc closes back onto the button).
 *     `LAYERSBAR items=<python's switches> ships=carp,lionfish water=all defaults=ok`.
 *
 * GE9 (gates/leaf-GE9.md), on the same pages:
 *   SPACING: every pair of neighbouring chrome surfaces is one `--gap-m` (12 px, within 0.5 px), measured by
 *     e2e/spacing.ts: python at 1440×900 and 1024×768 (with and without the sighting card) prints
 *     `SPACING pairs=<n> off=<k>`; carp and lionfish with their panels at 1440×900, 1024×768 and 768×1024 plus python
 *     at 768×1024, and all three on the phone docks at 375×812, print `SPACING apps=python,carp,lionfish off=<k>
 *     mobile_off=<m>`. Every pair is logged.
 *   LOOKBTN: Look is the third of the four top-right icon buttons, its popover opens under it with right edges
 *     aligned and stays inside the viewport at 1440×900 and 375×812, and the bottom bar has no Look.
 *   CREDIT: the globe's attribution sits in the chat card's header row, on the tabs' line, right-aligned, one row
 *     at the 420 px card (and at the narrowest, 360 px), the "Data attribution" lightbox opens and closes by keyboard
 *     over the whole page, its links open a new tab; in the phone dock it stays visible. `CREDIT-3D`: once with Google
 *     3D active (the build's browser key from Doppler; never read here), Google's credit shows in the header.
 *   Screenshots: docs/evidence/ge9-*.png.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { sitesOf } from "../client/carp/model";
import { getApp, type AppId } from "../shared/apps";
import { ask, tapAgentStreams, type Tapped } from "./agent-ui";
import { offPairs } from "./spacing";
import { creditsInDock, creditsInHeader, creditsNarrow, creditsWithGoogle3d, lookButton, measureSpacing, spacing, type CreditCheck, type LookButtonCheck } from "./stage-ge9";
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
  await context.addInitScript(tapAgentStreams);
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

// ---- GE7: framing, panels, layers bar ----------------------------------------------------------------------------

const M_PER_DEG = 111_320;
const AGENT_TIMEOUT_MS = 150_000;
/** A question whose answer flies the map (geocode, set_view) and nothing else to read. */
const AGENT_FLY_QUESTION = "Fly the map to Flamingo in Everglades National Park.";
type LatLon = { lat: number; lon: number };
/** GE9 results gathered across the pages. */
const ge9 = { look: [] as LookButtonCheck[], credit: null as CreditCheck | null, narrow: false, dock: false };

/** Framed targets so far, over both viewports. */
const framing = { inside: 0, outside: 0 };
/** The Layers popover per app, at 1440. */
const layersByApp: Partial<Record<AppId, LayersBarCheck>> = {};

/** Wait for the camera to come to rest: VIEW unchanged over three reads 400 ms apart, after the longest flight. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(1_800);
  let last = "";
  let same = 0;
  for (let i = 0; i < 40 && same < 3; i++) {
    const v = JSON.stringify(await page.evaluate(() => {
      const view = window.__inversa?.state("VIEW") as { lat: number; lon: number; altitudeM: number } | undefined;
      return view ? [view.lat.toFixed(5), view.lon.toFixed(5), Math.round(view.altitudeM)] : null;
    }));
    same = v === last ? same + 1 : 0;
    last = v;
    await page.waitForTimeout(400);
  }
}

/**
 * One framed target: every point projected by the globe lies inside the stage circle and under none of the HUD's
 * surfaces (cards, bars, buttons, the chat card). Counted once per target in `framing`.
 */
async function framed(page: Page, name: string, points: readonly LatLon[]): Promise<boolean> {
  const result = await page.evaluate(
    (pts) => {
      const s = document.querySelector("[data-stage]")!.getBoundingClientRect();
      const cx = s.left + s.width / 2;
      const cy = s.top + s.height / 2;
      const r = s.width / 2;
      const covers = [...document.querySelectorAll("[data-hud-obstacle], [data-chat-column], [data-testid='hud-topbar'] button, [data-testid='hud-drawer']")]
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0);
      return pts.map((p) => {
        const at = window.__inversa!.project(p.lon, p.lat);
        if (!at) return { ok: false, why: "off screen", at: null };
        const d = Math.hypot(at.x - cx, at.y - cy);
        const under = covers.find((b) => at.x >= b.left && at.x <= b.right && at.y >= b.top && at.y <= b.bottom);
        return { ok: d <= r && !under, why: d > r ? `outside the circle (${Math.round(d)} > ${Math.round(r)} px)` : under ? `under a surface at ${Math.round(under.left)},${Math.round(under.top)}` : "", at: { x: Math.round(at.x), y: Math.round(at.y), d: Math.round(d), r: Math.round(r) } };
      });
    },
    points.map((p) => ({ lat: p.lat, lon: p.lon })),
  );
  const ok = result.every((p) => p.ok);
  if (ok) framing.inside += 1;
  else framing.outside += 1;
  log(`framing ${name}: ${ok ? "inside" : "OUTSIDE"} ${result.map((p) => (p.at ? `(${p.at.x},${p.at.y} d=${p.at.d}/${p.at.r})${p.ok ? "" : ` ${p.why}`}` : p.why)).join(" ")}`);
  return ok;
}

const corners = (b: { west: number; south: number; east: number; north: number }): LatLon[] => [
  { lat: b.south, lon: b.west },
  { lat: b.south, lon: b.east },
  { lat: b.north, lon: b.west },
  { lat: b.north, lon: b.east },
];

/** The real agent flies the map (set_view): its view event's box, or its highlighted results, land in the circle. */
async function agentFraming(page: Page): Promise<void> {
  const before = await page.evaluate(() => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams.length);
  await ask(page, AGENT_FLY_QUESTION, AGENT_TIMEOUT_MS);
  const events = await page.evaluate((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]?.events ?? [], before);
  const tools = events.filter((e) => e.type === "tool_start").map((e) => String(e.capabilityName));
  const view = events.filter((e) => e.type === "view").at(-1) as { bbox?: { west: number; south: number; east: number; north: number } } | undefined;
  log(`agent: "${AGENT_FLY_QUESTION}" tools ${tools.join(", ")}; view ${JSON.stringify(view?.bbox ?? null)}`);
  await settle(page);
  if (!view?.bbox) {
    framing.outside += 1;
    log("framing agent set_view: OUTSIDE (no view event: set_view was not called)");
    return;
  }
  // A turn with result panels ends framing its primary result and highlights (showTurn); otherwise the view's box.
  const highlight = (await page.evaluate(() => (window.__inversa?.state("AGENT_HIGHLIGHT") as { targets?: { lat?: number; lon?: number }[] } | undefined)?.targets ?? [])).filter((t): t is LatLon => typeof t.lat === "number" && typeof t.lon === "number");
  const b = view.bbox;
  await framed(page, `agent set_view ${highlight.length ? `(${highlight.length} highlighted results)` : "(its box)"}`, highlight.length ? highlight : [...corners(b), { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 }]);
}

/**
 * A python marker clicked `share` of the circle's radius right of its centre (camera straight down at 4 km). At 1024
 * px the sighting card then opens over it; the camera must glide it back into the visible circle.
 */
async function offsetClick(page: Page, list: Python[], share: number, label: string): Promise<void> {
  const vp = page.viewportSize()!;
  const stage = await box(page, "[data-stage]");
  const dx = share * (stage.width / 2);
  const altitudeM = 4_000;
  const mpp = (altitudeM * 2 * Math.tan(Math.PI / 6)) / Math.max(vp.width, vp.height);
  if ((await page.locator(DRAWER).count()) > 0) {
    await page.locator(`${DRAWER} button[aria-label="Close panel"]`).click();
    await page.locator(DRAWER).waitFor({ state: "detached", timeout: 5_000 });
  }
  for (const s of list.slice(0, 12)) {
    const lon = s.lon - (dx * mpp) / (M_PER_DEG * Math.cos((s.lat * Math.PI) / 180));
    await flyTo(page, s.lat, lon, altitudeM);
    const p = await page.evaluate(([lo, la]) => window.__inversa!.project(lo, la), [s.lon, s.lat] as const);
    if (!p) continue;
    if ((await page.evaluate(([x, y]) => window.__inversa!.pick(x, y), [p.x, p.y] as const)) !== `sighting:${s.id}`) continue;
    log(`${label}: python sighting:${s.id} at x=${Math.round(p.x)} (stage centre ${Math.round(centreX(stage))}, ${Math.round(dx)} px right)`);
    await page.mouse.click(p.x, p.y);
    await page.locator(DRAWER).waitFor({ timeout: 15_000 });
    await settle(page);
    await framed(page, `${label} sighting click`, [s]);
    await page.locator(`${DRAWER} button[aria-label="Close panel"]`).click();
    await page.locator(DRAWER).waitFor({ state: "detached", timeout: 5_000 });
    return;
  }
  framing.outside += 1;
  log(`framing ${label} sighting click: OUTSIDE (no python marker could be hit off centre)`);
}

type LayersBarCheck = { items: number; ids: string[]; on: string[]; ships: boolean; water: boolean; defaults: boolean; keyboard: boolean };

/** The Layers popover: its switches and groups, the defaults, and the keyboard walk. */
async function layersBar(page: Page, app: AppId): Promise<LayersBarCheck> {
  const button = page.locator('[data-testid="layers-bar-button"]');
  await button.focus();
  await page.keyboard.press("Enter");
  const pop = page.locator('[data-testid="layers-popover"]');
  await pop.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const focusIn = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="layers-popover"]'));
  await page.keyboard.press("Tab");
  const onSwitch = await page.evaluate(() => document.activeElement?.getAttribute("role") === "switch" || (document.activeElement as HTMLInputElement | null)?.type === "checkbox");
  const toggles = await pop.locator('input[data-testid^="legend-toggle-"]').evaluateAll((els) => els.map((el) => ({ id: el.getAttribute("data-testid")!.slice("legend-toggle-".length), on: (el as HTMLInputElement).checked, named: !!el.getAttribute("aria-label") })));
  const ships = (await pop.locator('[data-testid="legend-group-ships"]').count()) > 0;
  const water = (await pop.locator('[data-testid="water-weather"]').count()) > 0;
  await page.screenshot({ path: path.join(SHOT_DIR, `layers-${app}-1440.png`) });
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "detached", timeout: 5_000 });
  const back = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "layers-bar-button");
  const cfg = getApp(app);
  const novice = ["sightings", "notes"].filter((id) => cfg.layers.some((l) => l.id === id));
  const on = toggles.filter((t) => t.on).map((t) => t.id);
  const defaults = on.length === novice.length && novice.every((id) => on.includes(id));
  const keyboard = focusIn && onSwitch && back && toggles.every((t) => t.named);
  log(`layers ${app}: ${toggles.map((t) => `${t.id}${t.on ? "*" : ""}`).join(" ")}; ships ${ships} water ${water}; keyboard focus-in ${focusIn} tab-to-switch ${onSwitch} esc-back ${back}`);
  return { items: toggles.length, ids: toggles.map((t) => t.id), on, ships, water, defaults, keyboard };
}

/** Open an app's page with no camera in the link, so it frames itself. */
async function openApp(browser: Browser, origin: string, app: AppId, viewport: { width: number; height: number }, errors: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.clock.install({ time: new Date(FIXTURE_CLOCK) });
  const page = watch(await context.newPage(), errors, `${app}-${viewport.width}`);
  await page.goto(`${origin}/?app=${app}#v=2&app=${app}`, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-testid="app-select-button"][data-app="${app}"]`).waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => !!window.__inversa?.globe(), undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(1_000);
  return page;
}

/**
 * Carp and lionfish at one viewport: the left panel opens in the right card region clear of the circle's centre,
 * the app frames itself inside the circle (carp's sites at load, a lionfish area chosen in the panel), and at 1440 the
 * Layers popover.
 */
async function appChecks(browser: Browser, stack: Stack, app: "carp" | "lionfish", viewport: { width: number; height: number }, errors: string[]): Promise<{ panel: boolean; layers: LayersBarCheck | null }> {
  const page = await openApp(browser, stack.origin, app, viewport, errors);
  const panelSel = app === "carp" ? '[data-testid="carp-board-panel"]' : '[data-testid="lionfish-panel"]';
  await page.locator(panelSel).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  const stage = await box(page, "[data-stage]");
  const panel = await box(page, panelSel);
  // The centre shows the map: the globe or a map marker drawn over it (a carp site can sit there), never a card or bar.
  const clear = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return !!el && (!!el.closest("[data-globe]") || !!el.closest("[data-carp-site]")) && !el.closest("[data-hud-obstacle], [data-chat-column]");
  }, [centreX(stage), stage.y + stage.height / 2] as const);
  const right = panel.x > centreX(stage);
  log(`panel ${app} ${viewport.width}: ${JSON.stringify(panel)}; stage centre ${Math.round(centreX(stage))}; right of centre ${right}; centre shows the map ${clear}`);
  await page.screenshot({ path: path.join(SHOT_DIR, `stage-${app}-${viewport.width}.png`) });
  await measureSpacing(page, `${app} ${viewport.width}`, "apps");
  let aligned = true;
  if (app === "carp") {
    await settle(page);
    const sites = sitesOf(getApp("carp").locations);
    await framed(page, `carp ${viewport.width} sites at load`, sites);
    // The site buttons sit over their globe points (canvas pixels), not shifted by the chat card's width.
    const offsets = await page.evaluate(
      (list) =>
        list.map((s) => {
          const el = document.querySelector(`[data-carp-site="${s.lid}"]`);
          const p = window.__inversa!.project(s.lon, s.lat);
          if (!el || !p) return null;
          const r = el.getBoundingClientRect();
          return Math.round(Math.hypot(r.left + r.width / 2 - p.x, r.top + r.height / 2 - p.y));
        }),
      sites.map((s) => ({ lid: s.lid, lat: s.lat, lon: s.lon })),
    );
    aligned = offsets.every((d) => d !== null && d <= 4);
    log(`carp ${viewport.width} site buttons off their globe points by ${offsets.join(", ")} px`);
  } else {
    const area = getApp("lionfish").regions[0]!;
    await page.locator(`${panelSel} button[data-area="${area.id}"]`).click();
    await settle(page);
    await framed(page, `lionfish ${viewport.width} area ${area.id}`, corners(area.bbox));
  }
  const layers = viewport.width >= 1440 ? await layersBar(page, app) : null;
  await page.context().close();
  return { panel: right && clear && aligned, layers };
}

/** The last Google 3D credit verification (gitignored `.cache`), when under 12 h old. */
const GOOGLE3D_CACHE = path.join(REPO_DIR, "apps/web/.cache/ge9-google3d.json");
type Google3dResult = { visible: boolean; state: string; shot: string | null; at: string };
function readGoogle3d(): Google3dResult | null {
  try {
    const r = JSON.parse(readFileSync(GOOGLE3D_CACHE, "utf8")) as Google3dResult;
    return r.visible && Date.now() - Date.parse(r.at) < 12 * 3_600_000 ? r : null;
  } catch {
    return null;
  }
}
function writeGoogle3d(r: Omit<Google3dResult, "at">): void {
  mkdirSync(path.dirname(GOOGLE3D_CACHE), { recursive: true });
  writeFileSync(GOOGLE3D_CACHE, JSON.stringify({ ...r, at: new Date().toISOString() }));
}

/** GE9: one app at one viewport, its panel open where it has one, measured for spacing only. */
async function spacingOnly(browser: Browser, stack: Stack, app: AppId, viewport: { width: number; height: number }, group: "apps" | "mobile", errors: string[]): Promise<void> {
  const page = await openApp(browser, stack.origin, app, viewport, errors);
  const panel = app === "carp" ? '[data-testid="carp-board-panel"]' : app === "lionfish" ? '[data-testid="lionfish-panel"]' : null;
  if (panel && viewport.width >= 768) await page.locator(panel).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await measureSpacing(page, `${app} ${viewport.width}x${viewport.height}`, group);
  await page.screenshot({ path: path.join(SHOT_DIR, `ge9-${app}-${viewport.width}.png`) });
  await page.context().close();
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

  // ---- GE9: spacing, the Look button, the attribution in the chat header --------------------------------------------
  await measureSpacing(page, "python 1440", "python");
  ge9.look.push(await lookButton(page, "1440", path.join(SHOT_DIR, "ge9-look-1440.png")));
  ge9.credit = await creditsInHeader(page, path.join(SHOT_DIR, "ge9-credit-header.png"));
  // The narrowest card (360 px): Home on the resize handle; a double click puts the default back.
  const handle = page.locator("[data-column-resize]");
  await handle.focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);
  ge9.narrow = await creditsNarrow(page);
  await page.screenshot({ path: path.join(SHOT_DIR, "ge9-credit-header-360.png"), clip: { x: 0, y: 0, width: 400, height: 80 } });
  await handle.dblclick();
  await page.waitForTimeout(400);

  // ---- TOPRIGHT ---------------------------------------------------------------------------------------------
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="hud-topbar"] button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.getAttribute("aria-label") ?? "", text: b.innerText.trim(), right: r.right, top: r.top, id: b.dataset.testid ?? "" };
    }),
  );
  log(`top right: ${JSON.stringify(buttons.map((b) => `${b.id} "${b.name}" r=${Math.round(b.right)} t=${Math.round(b.top)}`))}`);
  const wants = [/about/i, /theme/i, /look/i, /developer/i];
  const namesOk =
    buttons.length === 4 &&
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
  await measureSpacing(page, "python 1440 sighting open", "python", path.join(SHOT_DIR, "ge9-spacing-1440.png"));
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

  // ---- GE7: the Layers popover, a marker clicked off centre, the real agent flying the map ------------------------
  layersByApp.python = await layersBar(page, "python");
  await offsetClick(page, list, 0.45, "1440");
  try {
    // Iterating on layout only (never in a gate run): E2E_STAGE_NO_AGENT=1 skips the paid agent turn.
    if (process.env.E2E_STAGE_NO_AGENT === "1") throw new Error("skipped: E2E_STAGE_NO_AGENT=1");
    await agentFraming(page);
  } catch (err) {
    // A failed turn (no credit, a network error) is a framing that did not happen, not a reason to lose the other lines.
    framing.outside += 1;
    log(`framing agent set_view: OUTSIDE (the turn failed: ${err instanceof Error ? err.message : String(err)})`);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, "stage-1440-agent.png") });
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
  await measureSpacing(page, "python 375", "mobile", path.join(SHOT_DIR, "ge9-spacing-375.png"));
  ge9.dock = await creditsInDock(page);
  ge9.look.push(await lookButton(page, "375", path.join(SHOT_DIR, "ge9-look-375.png")));
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
  await measureSpacing(page, "python 1024 sighting open", "python");
  // GE7: a marker the sighting card will cover once it opens; the camera keeps it in sight.
  await offsetClick(page, list, 0.4, "1024");
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
  const stack = await startStack({ name: "stage", apps: ["python", "carp", "lionfish"] });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  try {
    const list = await pythons(stack);
    log(`Axum: ${list.length} distinct python sightings in the window`);
    const lines = await desktop(browser, stack, list, errors);
    const mobileOk = await phone(browser, stack, errors);
    const tabletOk = await tablet(browser, stack, list, errors);
    lines.push(`RESPONSIVE mobile=${mobileOk ? "ok" : "no"} tablet=${tabletOk ? "ok" : "no"}`);
    // GE7: carp and lionfish at both sizes.
    const panels: Record<string, boolean> = { carp: true, lionfish: true };
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      for (const app of ["carp", "lionfish"] as const) {
        const r = await appChecks(browser, stack, app, viewport, errors);
        panels[app] &&= r.panel;
        if (r.layers) layersByApp[app] = r.layers;
      }
    }
    lines.push(`FRAMING inside=${framing.inside} outside=${framing.outside}`);
    lines.push(`PANELS carp=${panels.carp ? "ok" : "no"} lionfish=${panels.lionfish ? "ok" : "no"}`);
    const checks = Object.entries(layersByApp) as [AppId, LayersBarCheck][];
    const ships = checks.filter(([, c]) => c.ships).map(([a]) => a).sort();
    const water = checks.length === 3 && checks.every(([, c]) => c.water) ? "all" : checks.filter(([, c]) => c.water).map(([a]) => a).sort().join(",") || "none";
    const defaults = checks.length === 3 && checks.every(([, c]) => c.defaults && c.keyboard);
    lines.push(`LAYERSBAR items=${layersByApp.python?.items ?? 0} ships=${ships.join(",") || "none"} water=${water} defaults=${defaults ? "ok" : "no"}`);

    // GE9: the portrait tablet for every app, the phone docks of carp and lionfish, then the lines.
    for (const app of ["python", "carp", "lionfish"] as const) await spacingOnly(browser, stack, app, { width: 768, height: 1024 }, "apps", errors);
    for (const app of ["carp", "lionfish"] as const) await spacingOnly(browser, stack, app, { width: 375, height: 812 }, "mobile", errors);
    const pythonOff = offPairs(spacing.python);
    const appsOff = offPairs(spacing.apps);
    const mobileOff = offPairs(spacing.mobile);
    for (const p of [...pythonOff, ...appsOff, ...mobileOff]) log(`spacing OFF: ${p.name} = ${p.px} px`);
    lines.push(`SPACING pairs=${spacing.python.length} off=${pythonOff.length}`);
    const measured = ["python", "carp", "lionfish"].filter((a) => spacing.apps.some((p) => p.name.startsWith(`${a} `)) && spacing.mobile.some((p) => p.name.startsWith(`${a} `)));
    lines.push(`SPACING apps=${measured.join(",")} off=${appsOff.length} mobile_off=${mobileOff.length}`);
    const lb = ge9.look;
    lines.push(
      `LOOKBTN topright=${lb.length > 0 && lb.every((c) => c.topright) ? 1 : 0} aligned_right=${lb.length === 2 && lb.every((c) => c.aligned) ? 1 : 0} inside_viewport=${lb.length === 2 && lb.every((c) => c.inside) ? 1 : 0} bottombar_has_look=${lb.some((c) => c.bottomBarHasLook) ? 1 : 0}`,
    );
    const c = ge9.credit;
    if (c) {
      log(`credit: narrow card one row ${ge9.narrow}, phone dock visible ${ge9.dock}`);
      lines.push(
        `CREDIT inheader=${c.inheader && ge9.dock ? 1 : 0} sameRow=${c.sameRow ? 1 : 0} rightAligned=${c.rightAligned ? 1 : 0} wraps=${c.wraps || !ge9.narrow ? 1 : 0} lightbox=${c.lightbox ? "ok" : "no"} newtab=${c.newtab ? "ok" : "no"} route=${c.route}`,
      );
    }
    // Google 3D is billed per session: verified once, the result is kept for 12 h (E2E_GOOGLE3D_FRESH=1 re-verifies;
    // E2E_SKIP_GOOGLE3D=1 skips it while iterating).
    if (process.env.E2E_SKIP_GOOGLE3D !== "1") {
      const cached = readGoogle3d();
      if (cached && process.env.E2E_GOOGLE3D_FRESH !== "1") {
        log(`google 3d: reusing the verification of ${cached.at} (screenshot ${path.relative(REPO_DIR, cached.shot ?? "")}); E2E_GOOGLE3D_FRESH=1 re-verifies`);
        lines.push(`CREDIT-3D google_credit_visible=${cached.visible ? 1 : 0} state=${cached.state} verified=${cached.at}`);
      } else {
        const g3d = await creditsWithGoogle3d(browser, stack.origin, FIXTURE_CLOCK, errors);
        writeGoogle3d(g3d);
        lines.push(`CREDIT-3D google_credit_visible=${g3d.visible ? 1 : 0} state=${g3d.state}`);
      }
    }
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
