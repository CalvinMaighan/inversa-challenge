/**
 * Live mode end to end (PLAN.md C18, gates/leaf-T37.md) on the real stack (e2e/stack.ts).
 *
 *   bun run e2e:live            build, run, print the LIVE line
 *   bun run e2e:live --shot     also save docs/evidence/live.png
 *   E2E_SKIP_BUILD=1 …          reuse the last e2e build
 *
 * The page opens on the live edge over Homestead. A signed hook payload (C10) then brings a python sighting
 * observed a minute ago and a Freeze Warning polygon around it. Without a reload, within 15 s:
 * - the globe draws the sighting: `pick` at its projected screen point returns its `sighting:<id>`;
 * - the globe draws the alert: `pick` inside the polygon, away from the dot, returns its `alert:<id>`;
 * - the HUD sparkline redraws with one more sighting in the live frame (canvas pixels change);
 * - the `web` feed row (About → Data sources since T41) reports the fetch (FEEDS state from the `feeds`
 *   subscription, and the row text).
 * The chain under test: Axum write -> 5 s frame debounce -> `framesUpdated` -> gql worker -> db worker refetches
 * the changed hours and expires its query cache -> grid bump -> globe layers and HUD redraw.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const SHOT = path.join(REPO_DIR, "docs/evidence/live.png");
const DEADLINE_MS = 15_000;
/** Near Homestead, inland (not under the fixture alerts). */
const DOT = { lat: 25.4725, lon: -80.5325 };
/** A point inside the alert polygon, clear of the dot. */
const IN_ALERT = { lat: 25.54, lon: -80.44 };
const POLYGON = [[[-80.62, 25.4], [-80.38, 25.4], [-80.38, 25.6], [-80.62, 25.6], [-80.62, 25.4]]];
const LINK = `#v=1&c=${DOT.lat},${DOT.lon},30000,0,-90&l=sightings,hotspots,alerts`;

const log = (...a: unknown[]) => console.error("[e2e:live]", ...a);

/** Evidence id under the screen point of a place, or null. */
function pickAt(page: Page, at: { lat: number; lon: number }): Promise<string | null> {
  return page.evaluate(({ lat, lon }) => {
    const d = window.__inversa!;
    const p = d.project(lon, lat);
    return p ? d.pick(p.x, p.y) : null;
  }, at);
}

const sparkline = (page: Page) => page.locator("[data-testid=hud-timeline-canvas]").evaluate((c: HTMLCanvasElement) => c.toDataURL());

type Feed = { source: string; lastFetchAt: string | null; newestObservedAt: string | null; state: string };
const webFeed = (page: Page) => page.evaluate(() => ((window.__inversa!.state("FEEDS") as Feed[] | undefined) ?? []).find((f) => f.source === "web") ?? null);
/** The `web` chip as drawn: state, text and tooltip. */
const webChip = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-feed=web]");
    return el ? `${el.dataset.state} "${el.textContent?.trim()}" (${el.title})` : null;
  });

async function main() {
  const shot = process.argv.includes("--shot");
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "live" });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    let navigations = 0;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigations += 1;
    });

    await page.goto(`${stack.origin}/${LINK}`, { waitUntil: "load" });
    await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0, undefined, { timeout: 120_000 });
    await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "hotspots")?.frame ?? -1) >= 0, undefined, { timeout: 60_000 });
    await page.waitForTimeout(3_000); // camera settled, first alert fetch done
    // T41: the feed rows live in About → Data sources; keep it open while the hook's rows land.
    await page.click("[data-testid=status-button]");
    await page.click("[data-testid=data-sources] > summary");
    const before = {
      navigations,
      badge: (await page.locator("[data-testid=hud-live]").textContent())?.trim() ?? "",
      frame: (await page.evaluate(() => window.__inversa!.snapshot().frame))!,
      sightings: await page.evaluate(() => window.__inversa!.snapshot().sightings),
      dot: await pickAt(page, DOT),
      alert: await pickAt(page, IN_ALERT),
      spark: await sparkline(page),
      feed: await webFeed(page),
      chip: await webChip(page),
    };
    log(`before: badge=${before.badge} frame=${before.frame} sightings=${before.sightings} dot=${before.dot} alert=${before.alert} web=${JSON.stringify(before.feed)} chip=${before.chip}`);
    if (!/LIVE/.test(before.badge)) throw new Error(`page did not open on the live edge (badge "${before.badge}")`);

    const now = Date.now();
    const tag = `e2e-live-${now}`;
    const out = await stack.hook([
      {
        Sighting: {
          ext_id: tag,
          taxon: { scientific_name: "Python bivittatus", common_name: "Burmese python" },
          lat: DOT.lat,
          lon: DOT.lon,
          accuracy_m: 5,
          observed_at: now - 60_000,
          quality: "curated",
          photo_url: null,
        },
      },
      {
        Alert: {
          ext_id: `${tag}-alert`,
          event: "Freeze Warning",
          severity: "Severe",
          headline: `Freeze Warning (${tag})`,
          area_geojson: { type: "Polygon", coordinates: POLYGON },
          onset: now - 60_000,
          expires: now + 3 * 3_600_000,
        },
      },
    ]);
    const t0 = Date.now();
    log(`hook: ${JSON.stringify(out)}`);

    // The id Axum gave the alert, to recognise it on the globe.
    const found = await stack.graphql<{ alerts: { id: string; headline: string | null }[] }>(
      "query($bbox: BBox!, $at: Time!) { alerts(bbox: $bbox, at: $at) { id headline } }",
      { bbox: { west: -80.7, south: 25.3, east: -80.3, north: 25.7 }, at: new Date().toISOString() },
    );
    const alertId = found.alerts.find((a) => a.headline?.includes(tag))?.id;
    if (!alertId) throw new Error(`hook alert not found in Axum: ${JSON.stringify(found.alerts)}`);

    let sightingMs = -1;
    let alertMs = -1;
    let sparkMs = -1;
    let feedMs = -1;
    let dotId: string | null = null;
    while (Date.now() - t0 < DEADLINE_MS + 5_000 && (sightingMs < 0 || alertMs < 0 || sparkMs < 0 || feedMs < 0)) {
      await page.waitForTimeout(250);
      const elapsed = Date.now() - t0;
      if (sightingMs < 0) {
        const id = await pickAt(page, DOT);
        if (id && id.startsWith("sighting:") && id !== before.dot) {
          sightingMs = elapsed;
          dotId = id;
        }
      }
      if (alertMs < 0 && (await pickAt(page, IN_ALERT)) === `alert:${alertId}`) alertMs = elapsed;
      if (sparkMs < 0) {
        const count = await page.evaluate(() => window.__inversa!.snapshot().sightings);
        if (count > before.sightings && (await sparkline(page)) !== before.spark) sparkMs = elapsed;
      }
      if (feedMs < 0) {
        // The FEEDS entry moved (subscription) and the chip redrew from it.
        const feed = await webFeed(page);
        const chip = await webChip(page);
        if (feed?.lastFetchAt && feed.lastFetchAt !== before.feed?.lastFetchAt && chip && chip !== before.chip) feedMs = elapsed;
      }
    }
    const chips = await webChip(page);
    const reloads = navigations - before.navigations;
    log(`dot ${dotId} after ${sightingMs} ms; alert:${alertId} after ${alertMs} ms; sparkline after ${sparkMs} ms; web feed after ${feedMs} ms; chips: ${chips}`);
    console.log(`LIVE sighting_ms=${sightingMs} alert_ms=${alertMs} sparkline_ms=${sparkMs} feed_ms=${feedMs} reload=${reloads}`);
    const inTime = (ms: number) => ms >= 0 && ms <= DEADLINE_MS;
    if (![sightingMs, alertMs, sparkMs, feedMs].every(inTime) || reloads !== 0) failed = true;
    if (errors.length) {
      log("console errors:", errors);
      failed = true;
    }
    if (shot) {
      await page.waitForTimeout(1_000);
      mkdirSync(path.dirname(SHOT), { recursive: true });
      await page.screenshot({ path: SHOT });
      log(`screenshot → ${path.relative(REPO_DIR, SHOT)}`);
    }
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
    throw err;
  } finally {
    await browser.close();
    await stack.stop();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
