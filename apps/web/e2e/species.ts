/**
 * T41 e2e: the species chip and clickable sightings, on the real stack (e2e/stack.ts: Axum with the fixture
 * backfill, `next start`, the signal Worker and a Caddy-like proxy, all on free ports). Everglades Ops tracks one
 * species, the Burmese python.
 *
 *   bun run e2e:species             build, run, print the SPECIES line
 *   E2E_SKIP_BUILD=1 …              reuse the last e2e build
 *
 * 1. A share link to 2026-09-09T20:00Z with no layer list, so the defaults apply (sightings first). The 7-day
 *    window before it holds the fixtures' Burmese pythons.
 * 2. The python chip's count equals the globe's own sightings stats (GlobeApi stats breakdown, taxon 1).
 * 3. A python sighting from Axum (same window), flown to through the share link, found with GlobeApi `project`
 *    and hit with the mouse: the hover tooltip leads with the species and its quality grade, and a click opens
 *    the evidence card on that sighting with its plain summary and species card (Latin name, About line, the
 *    iNaturalist page in a new tab). Screenshot docs/evidence/simplify-python.png.
 * 4. Clicking the chip hides the pythons: LAYERS has python off, the globe draws none, the chip reads unpressed
 *    and its count stays. Clicking it again brings them back. Last line:
 *
 *   SPECIES off=0 on=<m> counts=ok drawer=1
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
/** The Axum fixtures were recorded 2026-09-30T20:40Z; the browser clock sits just after them. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
/** In the fixtures' 30-day window, with pythons reported in the 7 days before it. */
const AT = "2026-09-09T20:00:00.000Z";
const LINK = "#v=1&c=25.70000,-80.40000,160000,0,-90&t=2026-09-09T20:00Z";
/** The default sightings window (7 days). */
const WINDOW_MS = 168 * 3_600_000;
const REGION = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 };
const LOAD_TIMEOUT_MS = 120_000;
const PYTHON = "python";
/** `taxa.id` of the Burmese python, the app's one taxon (PLAN.md C4). */
const PYTHON_TAXON = "1";

const log = (...a: unknown[]) => console.error("[e2e:species]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type LayerStat = { id: string; enabled: boolean; count: number; frame: number; breakdown?: Record<string, number> };

const sightingsStat = (page: Page) =>
  page.evaluate(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") as LayerStat | undefined) ?? null);

const chipCount = (page: Page) =>
  page.evaluate((key) => Number((document.querySelector(`[data-species-chip="${key}"] [data-species-count]`)?.textContent ?? "NaN").replace(/,/g, "")), PYTHON);

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
  // The window holds the pythons of early September once the layer has drawn that frame.
  await page.waitForFunction((id) => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.breakdown?.[id] ?? 0) > 0, PYTHON_TAXON, { timeout: LOAD_TIMEOUT_MS });
  const layers = (await page.evaluate(() => window.__inversa!.state("LAYERS"))) as { visible: Record<string, boolean> };
  const on = Object.entries(layers.visible)
    .filter(([, v]) => v)
    .map(([k]) => k);
  log(`default layers on: ${on.join(", ")}`);
  if (["stations", "alerts", "hotspots", "lst", "sst"].some((id) => on.includes(id)) || !on.includes("sightings")) fail(`default layers are ${on.join(",")}, want sightings first`);
  const chips = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-species-chip]")].map((c) => c.dataset.speciesChip));
  if (chips.length !== 1 || chips[0] !== PYTHON) fail(`species chips ${JSON.stringify(chips)}, want only ${PYTHON}`);

  // The chip's count against the globe's stats (both sample the same stats; give them a moment).
  const matches = async () => {
    const stat = (await sightingsStat(page)) ?? fail("no sightings stats");
    const chip = await chipCount(page);
    return { ok: chip === (stat.breakdown?.[PYTHON_TAXON] ?? -1) && chip === stat.count, chip, stat };
  };
  let check = await matches();
  for (let i = 0; i < 20 && !check.ok; i++) {
    await page.waitForTimeout(250);
    check = await matches();
  }
  if (!check.ok) fail(`chip count ${check.chip} vs globe ${check.stat.count} drawn, breakdown ${JSON.stringify(check.stat.breakdown)}`);
  const all = check.stat.count;
  log(`pythons: globe ${all} drawn, chip ${check.chip}`);

  // A python Axum holds for the same window: fly to it, hover it (tooltip), click it (evidence card).
  const atMs = Date.parse(AT);
  const { sightings } = await stack.graphql<{ sightings: { id: string; lat: number; lon: number; canonicalId: string | null }[] }>(
    "query($bbox: BBox!, $from: Time!, $to: Time!, $taxa: [ID!]) { sightings(bbox: $bbox, from: $from, to: $to, taxa: $taxa) { id lat lon canonicalId } }",
    { bbox: REGION, from: new Date(atMs - WINDOW_MS + 3_600_000).toISOString(), to: AT, taxa: [PYTHON_TAXON] },
  );
  const pythons = sightings.filter((s) => s.canonicalId === null);
  log(`Axum: ${pythons.length} distinct python sightings in the window`);
  const canvas = (await page.locator("[data-globe] canvas").first().boundingBox()) ?? fail("no globe canvas");
  let hit: { id: string; x: number; y: number } | null = null;
  for (const s of pythons.slice(0, 12)) {
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
  if (!hit) fail(`no python sighting marker could be hit (${pythons.length} in the window)`);
  await page.mouse.move(canvas.x + hit.x + 6, canvas.y + hit.y + 6);
  await page.mouse.move(canvas.x + hit.x, canvas.y + hit.y, { steps: 3 });
  const tip = page.locator('[data-testid="globe-tooltip"]');
  await tip.waitFor({ timeout: 5_000 });
  const tipText = ((await tip.textContent()) ?? "").trim();
  if (!/^Burmese python\s*·?\s*(research|needs ID|casual|curated)/.test(tipText)) fail(`tooltip does not lead with species and grade: "${tipText}"`);
  log(`tooltip "${tipText}"`);
  await page.mouse.click(canvas.x + hit.x, canvas.y + hit.y);
  const want = `sighting:${hit.id}`;
  await page.waitForFunction((id) => document.querySelector('[data-testid="hud-drawer-id"]')?.textContent?.trim() === id, want, { timeout: 15_000 });
  await page.locator('[data-testid="hud-drawer"] section[aria-label="Normalized record"]').waitFor({ state: "attached", timeout: 30_000 });
  const card = await page.evaluate(() => {
    const lead = document.querySelector('[data-testid="evidence-summary"]');
    const more = lead?.querySelector<HTMLAnchorElement>('a[data-testid="species-more"]');
    return {
      lead: lead?.textContent?.trim() ?? "",
      sci: lead?.querySelector('i[lang="la"]')?.textContent?.trim() ?? "",
      about: lead?.querySelector('[data-testid="species-about"]')?.textContent?.trim() ?? "",
      moreHref: more?.getAttribute("href") ?? "",
      moreTarget: more?.getAttribute("target") ?? "",
    };
  });
  if (!card.lead.startsWith("Burmese python spotted")) fail(`evidence card lead: "${card.lead}"`);
  if (card.sci !== "Python bivittatus") fail(`species card Latin name "${card.sci}"`);
  if (card.about.length < 10) fail(`species card About line "${card.about}"`);
  if (card.moreHref && (!/^https:\/\/www\.inaturalist\.org\/taxa\/\d+$/.test(card.moreHref) || card.moreTarget !== "_blank")) fail(`"More about" link: ${card.moreHref} target=${card.moreTarget}`);
  log(`click → drawer ${want}: "${card.lead.slice(0, 120)}"`);
  await page.mouse.move(canvas.x + 40, canvas.y + 300);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: path.join(SHOT_DIR, "simplify-python.png") });
  log("screenshot simplify-python.png");

  // The chip hides the pythons, and brings them back.
  const chip = page.locator(`[data-species-chip="${PYTHON}"]`);
  await chip.click();
  await page.waitForFunction((key) => (window.__inversa?.state("LAYERS") as { species: Record<string, unknown> }).species[key] === false, PYTHON);
  await page.waitForFunction(() => window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.count === 0);
  const off = (await sightingsStat(page))!.count;
  if ((await chip.getAttribute("aria-pressed")) !== "false") fail("the chip reads pressed while the pythons are hidden");
  log(`python off: globe ${off} drawn, chip ${await chipCount(page)}`);
  await chip.click();
  await page.waitForFunction((n) => window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.count === n, all, { timeout: 15_000 });
  if ((await chip.getAttribute("aria-pressed")) !== "true") fail("the chip reads unpressed after showing the pythons again");
  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  await context.close();
  return `SPECIES off=${off} on=${all} counts=ok drawer=1`;
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
