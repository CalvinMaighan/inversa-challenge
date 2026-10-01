/**
 * T41 e2e: the species filter bar and clickable sightings, on the real stack (e2e/stack.ts: Axum with the
 * fixture backfill, `next start`, the signal Worker and a Caddy-like proxy, all on free ports).
 *
 *   bun run e2e:species             build, run, print the SPECIES line
 *   E2E_SKIP_BUILD=1 …              reuse the last e2e build
 *
 * 1. A share link to 2026-09-09T20:00Z with no layer list, so the defaults apply (sightings first). The 7-day
 *    window before it holds the fixtures' iNaturalist green iguanas and Burmese pythons around Miami.
 * 2. The species bar's chip counts equal the globe's own sightings stats (GlobeApi stats breakdown), chip by chip.
 * 3. Alt-click on the iguana chip shows only iguana: LAYERS keeps iguana alone, the globe draws iguana sightings
 *    only (n), fewer than with every species on (m), the chip reads pressed and the "All" reset appears.
 * 4. An iguana sighting from Axum (same window), flown to through the share link, found with GlobeApi `project`
 *    and hit with the mouse: the hover tooltip leads with the species and its quality grade, and a click opens
 *    the evidence card on that sighting with its plain summary. Screenshot docs/evidence/simplify-iguana.png.
 * 5. "All" brings every species back. Last line:
 *
 *   SPECIES iguana_only=<n> all=<m> counts=ok drawer=1
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { ANIMAL_CATEGORIES, CATEGORY_IDS } from "../shared/species-categories";
import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
/** The Axum fixtures were recorded 2026-09-30T20:40Z; the browser clock sits just after them. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
/** In the fixtures' 30-day window, with iguanas and pythons reported in the 7 days before it. */
const AT = "2026-09-09T20:00:00.000Z";
const LINK = "#v=1&c=25.70000,-80.40000,160000,0,-90&t=2026-09-09T20:00Z";
/** The default sightings window (T44: 7 days). */
const WINDOW_MS = 168 * 3_600_000;
const REGION = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 };
const LOAD_TIMEOUT_MS = 120_000;
const IGUANA = "iguana";
/** `taxa.id` of green iguana (1-based in SPECIES_IDS order, PLAN.md C4). */
const IGUANA_TAXON = "3";
/** The focus chips and their `taxa.id`s; the breakdown is keyed by taxon id (T44). */
const FOCUS_KEYS = ["python", "tegu", "iguana", "lionfish"] as const;
/** Every species filter key: the focus four and the categories (T44). */
const FILTER_KEYS = [...FOCUS_KEYS, ...CATEGORY_IDS] as const;

const log = (...a: unknown[]) => console.error("[e2e:species]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type LayerStat = { id: string; enabled: boolean; count: number; frame: number; breakdown?: Record<string, number> };

const sightingsStat = (page: Page) =>
  page.evaluate(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") as LayerStat | undefined) ?? null);

const speciesFilter = (page: Page) => page.evaluate(() => (window.__inversa!.state("LAYERS") as { species: Record<string, unknown> }).species);

/** Chip counts as the species bar shows them, by chip key (`python`, `t116461`, `plants`, …). */
async function chipCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const chip of document.querySelectorAll<HTMLElement>("[data-species-chip]")) {
      out[chip.dataset.speciesChip!] = Number((chip.querySelector("[data-species-count]")?.textContent ?? "NaN").replace(/,/g, ""));
    }
    return out;
  });
}

/** What a chip's count must equal in the globe's per-taxon breakdown: a focus key maps to its taxon id, `t<id>` to that id. */
function expectedCount(key: string, breakdown: Record<string, number>): number | null {
  const focus = FOCUS_KEYS.indexOf(key as (typeof FOCUS_KEYS)[number]);
  if (focus >= 0) return breakdown[String(focus + 1)] ?? 0;
  const m = /^t(\d+)$/.exec(key);
  return m ? (breakdown[m[1]!] ?? 0) : null;
}

/** Fly the camera through the share link and wait for VIEW to settle there. */
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

async function species(browser: Browser, stack: Stack): Promise<string> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.clock.install({ time: new Date(FIXTURE_CLOCK) });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${stack.origin}/${LINK}`, { waitUntil: "load" });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  // The window holds the iguanas and pythons of 8–9 September once the layer has drawn that frame.
  await page.waitForFunction(
    () => {
      const s = window.__inversa?.globe()?.layers.find((l) => l.id === "sightings");
      return (s?.breakdown?.["3"] ?? 0) > 0 && (s?.breakdown?.["1"] ?? 0) > 0;
    },
    undefined,
    { timeout: LOAD_TIMEOUT_MS },
  );
  const layers = (await page.evaluate(() => window.__inversa!.state("LAYERS"))) as { visible: Record<string, boolean> };
  const on = Object.entries(layers.visible)
    .filter(([, v]) => v)
    .map(([k]) => k);
  log(`default layers on: ${on.join(", ")}`);
  if (["stations", "alerts", "hotspots", "lst", "sst"].some((id) => on.includes(id)) || !on.includes("sightings")) fail(`default layers are ${on.join(",")}, want sightings first`);

  // Chip counts against the globe's stats, chip by chip (both sample the same stats; give them a moment).
  const matches = async () => {
    const stat = (await sightingsStat(page)) ?? fail("no sightings stats");
    const chips = await chipCounts(page);
    const checked = Object.entries(chips).filter(([k]) => expectedCount(k, stat.breakdown ?? {}) !== null);
    return { ok: checked.length >= FOCUS_KEYS.length && checked.every(([k, n]) => n === expectedCount(k, stat.breakdown ?? {})), chips, stat };
  };
  let check = await matches();
  for (let i = 0; i < 20 && !check.ok; i++) {
    await page.waitForTimeout(250);
    check = await matches();
  }
  if (!check.ok) fail(`chip counts ${JSON.stringify(check.chips)} vs globe ${JSON.stringify(check.stat.breakdown)}`);
  const all = check.stat.count;
  log(`all species: globe ${all} drawn, chips ${JSON.stringify(check.chips)}`);
  if (await page.locator('[data-testid="species-all"]').count()) fail('"All" shows while nothing is filtered');

  // Alt-click: iguana only.
  await page.locator(`[data-species-chip="${IGUANA}"]`).click({ modifiers: ["Alt"] });
  await page.waitForFunction(
    ([keep, keys]) => {
      const sp = (window.__inversa?.state("LAYERS") as { species: Record<string, unknown> }).species;
      return keys.every((k) => (sp[k] !== false) === (k === keep));
    },
    [IGUANA, [...FILTER_KEYS]] as const,
  );
  await page.waitForFunction(() => {
    const s = window.__inversa?.globe()?.layers.find((l) => l.id === "sightings");
    return !!s && s.count > 0 && s.count === (s.breakdown?.["3"] ?? -1);
  });
  const n = (await sightingsStat(page))!.count;
  log(`iguana only: globe ${n} drawn; filter ${JSON.stringify(await speciesFilter(page))}`);
  if (!(n > 0 && n < all)) fail(`iguana only ${n}, all ${all}: want 0 < n < m`);
  await page.locator('[data-testid="species-all"]').waitFor({ timeout: 5_000 });
  const chipsOnly = await chipCounts(page);
  if (chipsOnly[IGUANA] !== n) fail(`iguana chip ${chipsOnly[IGUANA]} while the globe draws ${n}`);
  for (const k of Object.keys(chipsOnly)) {
    // The Other chip opens the categories instead of toggling: it reports `data-on` (any category on), not aria-pressed.
    const chip = page.locator(`[data-species-chip="${k}"]`);
    const on = k === "other" ? await chip.getAttribute("data-on") : await chip.getAttribute("aria-pressed");
    if (on !== String(k === IGUANA)) fail(`${k} chip on=${on}`);
  }

  // An iguana Axum holds for the same window: fly to it, hover it (tooltip), click it (evidence card).
  const atMs = Date.parse(AT);
  const { sightings } = await stack.graphql<{ sightings: { id: string; lat: number; lon: number; canonicalId: string | null }[] }>(
    "query($bbox: BBox!, $from: Time!, $to: Time!, $taxa: [ID!]) { sightings(bbox: $bbox, from: $from, to: $to, taxa: $taxa) { id lat lon canonicalId } }",
    { bbox: REGION, from: new Date(atMs - WINDOW_MS + 3_600_000).toISOString(), to: AT, taxa: [IGUANA_TAXON] },
  );
  const iguanas = sightings.filter((s) => s.canonicalId === null);
  log(`Axum: ${iguanas.length} distinct iguana sightings in the window`);
  const canvas = (await page.locator("[data-globe] canvas").first().boundingBox()) ?? fail("no globe canvas");
  let hit: { id: string; x: number; y: number } | null = null;
  for (const s of iguanas) {
    await flyTo(page, s.lat, s.lon, 4_000);
    const p = await page.evaluate(([lon, lat]) => window.__inversa!.project(lon, lat), [s.lon, s.lat] as const);
    if (!p) continue;
    const picked = await page.evaluate(([x, y]) => window.__inversa!.pick(x, y), [p.x, p.y] as const);
    log(`sighting:${s.id} at (${Math.round(p.x)}, ${Math.round(p.y)}) picks ${picked}`);
    if (picked === `sighting:${s.id}`) {
      hit = { id: s.id, x: p.x, y: p.y };
      break;
    }
  }
  if (!hit) fail(`no iguana sighting dot could be hit (${iguanas.length} in the window)`);
  await page.mouse.move(canvas.x + hit.x + 6, canvas.y + hit.y + 6);
  await page.mouse.move(canvas.x + hit.x, canvas.y + hit.y, { steps: 3 });
  const tip = page.locator('[data-testid="globe-tooltip"]');
  await tip.waitFor({ timeout: 5_000 });
  const tipText = ((await tip.textContent()) ?? "").trim();
  if (!/^Green iguana\s*·?\s*(research|needs ID|casual|curated)/.test(tipText)) fail(`tooltip does not lead with species and grade: "${tipText}"`);
  log(`tooltip "${tipText}"`);
  await page.mouse.click(canvas.x + hit.x, canvas.y + hit.y);
  const want = `sighting:${hit.id}`;
  await page.waitForFunction((id) => document.querySelector('[data-testid="hud-drawer-id"]')?.textContent?.trim() === id, want, { timeout: 15_000 });
  await page.locator('[data-testid="hud-drawer"] section[aria-label="Normalized record"]').waitFor({ state: "attached", timeout: 30_000 });
  const lead = ((await page.locator('[data-testid="evidence-summary"]').textContent({ timeout: 15_000 })) ?? "").trim();
  if (!lead.startsWith("Green iguana spotted")) fail(`evidence card lead: "${lead}"`);
  log(`click → drawer ${want}: "${lead}"`);
  await page.mouse.move(canvas.x + 40, canvas.y + 300);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: path.join(SHOT_DIR, "simplify-iguana.png") });
  log("screenshot simplify-iguana.png");

  // "All" brings every species back.
  await page.locator('[data-testid="species-all"]').click();
  await page.waitForFunction(() => {
    const sp = (window.__inversa?.state("LAYERS") as { species: Record<string, unknown> }).species;
    return ["python", "tegu", "iguana", "lionfish", "snakes", "lizards", "turtles", "crocodilians", "frogs", "birds", "mammals", "fish", "snails"].every((k) => sp[k] !== false);
  });
  const shownAfterAll = (await speciesFilter(page)) as Record<string, unknown>;
  if (!ANIMAL_CATEGORIES.every((id) => shownAfterAll[id] !== false)) fail(`All left a category off: ${JSON.stringify(shownAfterAll)}`);
  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  await context.close();
  return `SPECIES iguana_only=${n} all=${all} counts=ok drawer=1`;
}

async function main() {
  buildApi(log);
  buildWeb(log);
  mkdirSync(SHOT_DIR, { recursive: true });
  const stack = await startStack({ name: "species" });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    console.log(await species(browser, stack));
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
