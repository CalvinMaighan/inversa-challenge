/**
 * T44 e2e: every species is a first-class sighting, on the real stack with real data. Axum fills a temp data dir
 * with the fixtures plus a 7-day network backfill of iNaturalist (every introduced species in the region, and the
 * taxon enrichment from `/v1/taxa`), then `next start`, the signal Worker and the Caddy-like proxy run on free
 * ports (e2e/stack.ts). The browser keeps the real clock, at the live edge.
 *
 *   bun run e2e:speciescard          build, run, print the SPECIESCARD and SPECIESBAR lines
 *   E2E_SKIP_BUILD=1 …               reuse the last e2e build
 *
 * 1. Load; wait for the sightings layer, the TAXA store (every taxon on the frames named) and the species bar.
 * 2. The bar: the four focus chips first, then the most-seen animals, then Plants and Insects & others (off).
 *    Chip counts equal the globe's per-taxon breakdown, and the globe's drawn count equals Axum's
 *    `speciesCounts` for the animal groups over the same window of frames. Screenshot species-bar-7d.png.
 * 3. The top non-focus animal chip's species: one of its sightings (Axum, same window) is flown to, found with
 *    GlobeApi `project`, hit with the mouse, and the card reads its common name, Latin name, an About line and a
 *    photo, with no error. Screenshot species-card-other.png.
 * 4. The window selector: 2 days draws fewer sightings than 7 days; back to 7 days restores the count.
 *
 *   SPECIESCARD name=<common> sci=1 about=1 photo=1 error=0
 *   SPECIESBAR chips>=6 counts=ok window_7d>window_2d plants_default=off
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const SHOT_DIR = path.join(REPO_DIR, "docs/evidence");
const LOAD_TIMEOUT_MS = 180_000;
const REGION = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 };
const DEFAULT_HOURS = 168;
const SHORT_HOURS = 48;
const FOCUS_KEYS = ["python", "tegu", "iguana", "lionfish"] as const;
/** What draws by default: every introduced animal; plants and insects sit behind their own chips. */
const ANIMAL_GROUPS = ["Reptilia", "Amphibia", "Aves", "Mammalia", "Actinopterygii", "Mollusca"];

const log = (...a: unknown[]) => console.error("[e2e:speciescard]", ...a);

function fail(message: string): never {
  throw new Error(message);
}

type LayerStat = { id: string; enabled: boolean; count: number; frame: number; breakdown?: Record<string, number> };
type Meta = { frame0UnixMs: number; stepMinutes: number; frameCount: number };

const sightingsStat = (page: Page) => page.evaluate(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") as LayerStat | undefined) ?? null);

async function chipCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const chip of document.querySelectorAll<HTMLElement>("[data-species-chip]")) {
      out[chip.dataset.speciesChip!] = Number((chip.querySelector("[data-species-count]")?.textContent ?? "NaN").replace(/,/g, ""));
    }
    return out;
  });
}

function expectedCount(key: string, breakdown: Record<string, number>): number | null {
  const focus = FOCUS_KEYS.indexOf(key as (typeof FOCUS_KEYS)[number]);
  if (focus >= 0) return breakdown[String(focus + 1)] ?? 0;
  const m = /^t(\d+)$/.exec(key);
  return m ? (breakdown[m[1]!] ?? 0) : null;
}

/** The API's window for the frames the layer draws at `frame` with `hours` of trail (same arithmetic as the layer). */
function apiWindow(meta: Meta, frame: number, hours: number): { from: string; to: string } {
  const step = meta.stepMinutes * 60_000;
  const frames = Math.max(1, Math.ceil((hours * 3_600_000) / step));
  const first = Math.max(0, frame - frames + 1);
  return { from: new Date(meta.frame0UnixMs + first * step).toISOString(), to: new Date(meta.frame0UnixMs + (frame + 1) * step - 1).toISOString() };
}

async function apiAnimalCount(stack: Stack, window: { from: string; to: string }): Promise<number> {
  const { speciesCounts } = await stack.graphql<{ speciesCounts: { count: number }[] }>(
    "query($bbox: BBox!, $from: Time!, $to: Time!, $groups: [String!]) { speciesCounts(bbox: $bbox, from: $from, to: $to, groups: $groups, top: 500) { count } }",
    { bbox: REGION, ...window, groups: ANIMAL_GROUPS },
  );
  return speciesCounts.reduce((n, r) => n + r.count, 0);
}

async function ready(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && (window.__inversa?.globe()?.layers.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => ((window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") as LayerStat | undefined)?.count ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  // Every taxon on the frames is in the TAXA store, so the group filter and the chip names have settled.
  await page.waitForFunction(
    () => {
      const b = (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") as LayerStat | undefined)?.breakdown ?? {};
      const taxa = (window.__inversa?.state("TAXA") as { byId: Record<string, unknown> } | undefined)?.byId ?? {};
      const ids = Object.keys(b);
      return ids.length > 0 && ids.every((id) => id in taxa);
    },
    undefined,
    { timeout: LOAD_TIMEOUT_MS },
  );
  await page.waitForTimeout(3_000);
}

/** Fly the camera through the share link (no time: the page stays live) and wait for VIEW to settle there. */
async function flyTo(page: Page, lat: number, lon: number, altitudeM: number): Promise<void> {
  await page.evaluate(([la, lo, alt]) => {
    location.hash = `#v=1&c=${la.toFixed(5)},${lo.toFixed(5)},${alt},0,-90`;
  }, [lat, lon, altitudeM] as const);
  await page.waitForFunction(
    ([la, lo]) => {
      const v = window.__inversa?.state("VIEW") as { lat: number; lon: number } | undefined;
      return !!v && Math.abs(v.lat - la) < 0.01 && Math.abs(v.lon - lo) < 0.01 && !!window.__inversa?.project(lo, la);
    },
    [lat, lon] as const,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1_200);
}

async function speciesCard(browser: Browser, stack: Stack): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, stack.origin);

  // ---- the bar ------------------------------------------------------------------------------------------
  const keys = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-species-chip]")].map((c) => c.dataset.speciesChip!));
  log(`chips: ${keys.join(", ")}`);
  if (keys.slice(0, 4).join(",") !== FOCUS_KEYS.join(",")) fail(`the focus chips are not pinned first: ${keys.join(",")}`);
  const taxonChips = keys.filter((k) => /^t\d+$/.test(k));
  if (taxonChips.length < 2) fail(`only ${taxonChips.length} animal chips beyond the focus four`);
  if (!keys.includes("plants") || !keys.includes("others")) fail("no Plants or Insects & others chip");
  const plantsPressed = await page.getAttribute('[data-species-chip="plants"]', "aria-pressed");
  const othersPressed = await page.getAttribute('[data-species-chip="others"]', "aria-pressed");
  if (plantsPressed !== "false" || othersPressed !== "false") fail(`plants=${plantsPressed} others=${othersPressed}: the groups must start off`);
  const hours = await page.evaluate(() => (window.__inversa!.state("LAYERS") as { sightingHours?: number }).sightingHours);
  if (hours !== DEFAULT_HOURS) fail(`default window is ${hours} h, want ${DEFAULT_HOURS}`);

  // Chip counts against the globe's per-taxon breakdown, and the globe against Axum over the same frames.
  const check = async () => {
    const stat = (await sightingsStat(page)) ?? fail("no sightings stats");
    const chips = await chipCounts(page);
    const checked = Object.entries(chips).filter(([k]) => expectedCount(k, stat.breakdown ?? {}) !== null);
    return { ok: checked.length >= 6 && checked.every(([k, n]) => n === expectedCount(k, stat.breakdown ?? {})), chips, stat };
  };
  let bar = await check();
  for (let i = 0; i < 40 && !bar.ok; i++) {
    await page.waitForTimeout(250);
    bar = await check();
  }
  if (!bar.ok) fail(`chip counts ${JSON.stringify(bar.chips)} vs globe ${JSON.stringify(bar.stat.breakdown)}`);
  const meta = ((await page.evaluate(() => window.__inversa!.snapshot().meta)) as Meta | null) ?? fail("no frame meta");
  const window7 = apiWindow(meta, bar.stat.frame, DEFAULT_HOURS);
  const api7 = await apiAnimalCount(stack, window7);
  log(`7 days: globe draws ${bar.stat.count}, Axum has ${api7} distinct animal sightings in ${window7.from}..${window7.to}; chips ${JSON.stringify(bar.chips)}`);
  if (bar.stat.count !== api7) fail(`globe draws ${bar.stat.count} sightings, Axum has ${api7} distinct animal sightings in the same window`);
  const chipsCount = keys.length;
  await page.mouse.move(900, 500);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT_DIR, "species-bar-7d.png") });
  log("screenshot species-bar-7d.png");

  // ---- a non-focus animal's card -------------------------------------------------------------------------
  const topChip = taxonChips.map((k) => [k, bar.chips[k] ?? 0] as const).sort((a, b) => b[1] - a[1])[0]!;
  const taxonId = topChip[0].slice(1);
  const chipName = (await page.textContent(`[data-species-chip="${topChip[0]}"] .name`))?.trim() ?? fail("chip has no name");
  const chipTip = (await page.textContent(`[data-species-chip="${topChip[0]}"] + [role="tooltip"]`))?.trim() ?? "";
  log(`top animal chip: ${chipName} (taxon ${taxonId}, ${topChip[1]} in the window); tooltip "${chipTip.slice(0, 120)}"`);
  if (chipTip.length < 20 || !chipTip.includes("seen in the last 7 days")) fail(`chip tooltip too thin: "${chipTip}"`);
  const { sightings } = await stack.graphql<{ sightings: { id: string; lat: number; lon: number; canonicalId: string | null; taxon: { commonName: string; scientificName: string } }[] }>(
    "query($bbox: BBox!, $from: Time!, $to: Time!, $taxa: [ID!]) { sightings(bbox: $bbox, from: $from, to: $to, taxa: $taxa) { id lat lon canonicalId taxon { commonName scientificName } } }",
    { bbox: REGION, ...window7, taxa: [taxonId] },
  );
  const candidates = sightings.filter((s) => s.canonicalId === null);
  log(`Axum: ${candidates.length} distinct ${chipName} sightings in the window`);
  const canvas = (await page.locator("[data-globe] canvas").first().boundingBox()) ?? fail("no globe canvas");
  let hit: { id: string; x: number; y: number } | null = null;
  for (const s of candidates.slice(0, 12)) {
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
  if (!hit) fail(`no ${chipName} dot could be hit (${candidates.length} in the window)`);
  await page.mouse.move(canvas.x + hit.x + 6, canvas.y + hit.y + 6);
  await page.mouse.move(canvas.x + hit.x, canvas.y + hit.y, { steps: 3 });
  const tip = page.locator('[data-testid="globe-tooltip"]');
  await tip.waitFor({ timeout: 5_000 });
  const tipText = ((await tip.textContent()) ?? "").trim();
  log(`tooltip "${tipText}"`);
  if (!tipText.startsWith(chipName)) fail(`tooltip does not lead with the species name "${chipName}": "${tipText}"`);
  await page.mouse.click(canvas.x + hit.x, canvas.y + hit.y);
  const want = `sighting:${hit.id}`;
  await page.waitForFunction((id) => document.querySelector('[data-testid="hud-drawer-id"]')?.textContent?.trim() === id, want, { timeout: 15_000 });
  await page.locator('[data-testid="evidence-summary"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  const card = await page.evaluate(() => {
    const drawer = document.querySelector('[data-testid="hud-drawer"]')!;
    const lead = drawer.querySelector('[data-testid="evidence-summary"]');
    const img = lead?.querySelector<HTMLImageElement>('img[data-testid="evidence-photo"]');
    return {
      title: lead?.querySelector("h3")?.textContent?.trim() ?? "",
      sci: lead?.querySelector('i[lang="la"]')?.textContent?.trim() ?? "",
      status: lead?.querySelector('[data-testid="species-status"]')?.textContent?.trim() ?? "",
      about: lead?.querySelector('[data-testid="species-about"]')?.textContent?.trim() ?? "",
      photo: img ? { src: img.getAttribute("src") ?? "", loaded: img.complete && img.naturalWidth > 0 } : null,
      moreHref: lead?.querySelector<HTMLAnchorElement>('a[data-testid="species-more"]')?.getAttribute("href") ?? "",
      moreTarget: lead?.querySelector<HTMLAnchorElement>('a[data-testid="species-more"]')?.getAttribute("target") ?? "",
      moreText: lead?.querySelector('a[data-testid="species-more"]')?.textContent?.trim() ?? "",
      alerts: [...drawer.querySelectorAll('[role="alert"]')].map((n) => n.textContent?.trim() ?? ""),
      text: drawer.textContent ?? "",
    };
  });
  if (card.photo && !card.photo.loaded) {
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="evidence-summary"] img');
      return !!img && img.complete && img.naturalWidth > 0;
    }, undefined, { timeout: 20_000 }).catch(() => log("photo did not finish loading in 20 s"));
    card.photo.loaded = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="evidence-summary"] img');
      return !!img && img.complete && img.naturalWidth > 0;
    });
  }
  log(`card: "${card.title}" · ${card.sci} · ${card.status} · about "${card.about.slice(0, 80)}" · photo ${card.photo?.src} loaded=${card.photo?.loaded} · ${card.moreText} → ${card.moreHref} (${card.moreTarget})`);
  if (!card.title.startsWith(`${chipName} spotted`)) fail(`card title "${card.title}" does not lead with the species "${chipName}"`);
  if (card.text.includes("Other introduced species")) fail('the card still says "Other introduced species"');
  const sci = card.sci.length > 3 ? 1 : 0;
  const about = card.about.length > 20 ? 1 : 0;
  const photo = card.photo && card.photo.loaded ? 1 : 0;
  const error = card.alerts.length > 0 || /Could not load/.test(card.text) ? 1 : 0;
  if (!/^https:\/\/www\.inaturalist\.org\/taxa\/\d+$/.test(card.moreHref) || card.moreTarget !== "_blank") fail(`"More about" link: ${card.moreHref} target=${card.moreTarget}`);
  await page.mouse.move(canvas.x + 40, canvas.y + 300);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOT_DIR, "species-card-other.png") });
  log("screenshot species-card-other.png");
  const cardLine = `SPECIESCARD name=${chipName.replace(/\s+/g, "_")} sci=${sci} about=${about} photo=${photo} error=${error}`;
  if (card.alerts.length) log(`alerts: ${card.alerts.join(" | ")}`);

  // ---- the window ---------------------------------------------------------------------------------------
  const count7 = bar.stat.count;
  await page.selectOption('[data-testid="sighting-window"]', String(SHORT_HOURS));
  await page.waitForFunction((h) => (window.__inversa!.state("LAYERS") as { sightingHours?: number }).sightingHours === h, SHORT_HOURS);
  await page.waitForFunction((before) => ((window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") as LayerStat | undefined)?.count ?? before) < before, count7, { timeout: 15_000 });
  const stat2 = (await sightingsStat(page)) ?? fail("no sightings stats after the window change");
  const api2 = await apiAnimalCount(stack, apiWindow(meta, stat2.frame, SHORT_HOURS));
  log(`2 days: globe draws ${stat2.count}, Axum ${api2}`);
  if (stat2.count !== api2) fail(`2-day window: globe ${stat2.count}, Axum ${api2}`);
  const chips2 = await chipCounts(page);
  const tipAfter = (await page.textContent(`[data-species-chip="${topChip[0]}"] + [role="tooltip"]`))?.trim() ?? "";
  if (!tipAfter.includes("last 2 days")) fail(`chip tooltip did not follow the window: "${tipAfter}"`);
  log(`chips at 2 days ${JSON.stringify(chips2)}`);
  await page.selectOption('[data-testid="sighting-window"]', String(DEFAULT_HOURS));
  await page.waitForFunction((n) => ((window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") as LayerStat | undefined)?.count ?? -1) === n, count7, { timeout: 15_000 });
  const windowOk = count7 > stat2.count;
  if (!windowOk) fail(`7 days ${count7} is not more than 2 days ${stat2.count}`);

  // The window travels in the share link.
  await page.selectOption('[data-testid="sighting-window"]', "720");
  await page.waitForFunction(() => location.hash.includes("w=720"), undefined, { timeout: 10_000 });
  await page.selectOption('[data-testid="sighting-window"]', String(DEFAULT_HOURS));
  await page.waitForFunction(() => !location.hash.includes("w="), undefined, { timeout: 10_000 });

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  await context.close();
  return [cardLine, `SPECIESBAR chips>=6 counts=ok window_7d>window_2d plants_default=off (chips=${chipsCount} 7d=${count7} 2d=${stat2.count} api7d=${api7})`];
}

async function main() {
  buildApi(log);
  buildWeb(log);
  mkdirSync(SHOT_DIR, { recursive: true });
  const stack = await startStack({ name: "speciescard", backfillDays: 7 });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    for (const line of await speciesCard(browser, stack)) console.log(line);
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
