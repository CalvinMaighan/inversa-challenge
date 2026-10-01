/**
 * Data quality in the UI (gates/leaf-T27.md G3, PRD §7) on the real stack (e2e/stack.ts): Axum over the fixture
 * backfill, `next start`, the signal Worker and the front proxy. Each case is seeded through the real pipeline
 * (fixtures, or the signed hook), found through GraphQL, then opened in the ops page the way a user does: a feed
 * chip click or a share link with `e=<evidence id>`. Each screenshot is checked for the badge it must show.
 *
 *   bun run e2e:quality          build, run, write docs/evidence/quality/*.png, print QUALITY lines
 *   E2E_SKIP_BUILD=1 …           reuse the last e2e build
 *
 * Cases and what must be on screen:
 * - stale:     a pushed sighting observed 3 days ago makes the `web` feed (max latency 1 d) stale: its row in the
 *              About popover's data sources (T41) is `data-state=stale` with the note, and its name opens the fetch
 *              run, whose summary says "WEB data out of date".
 * - missing:   the fixture GOES scan's cloud and bad-DQF pixels are hatched on the LST layer (the layer's own
 *              gap count > 0); a cloud pixel's drawer says MISSING · CLOUD. A hook body that does not
 *              normalize is a failed fetch: its drawer says FETCH FAILED.
 * - duplicate: a GBIF record mirroring an iNaturalist one: DUPLICATE OF with the link to the iNat record.
 * - conflict:  the iNat ID flip (REVISION + CONFLICT, old → new taxon) and a satellite SST pixel 2 km from buoy
 *              41122 reading 2.4 °C warmer (CONFLICT, linked both ways).
 * - late:      the newest NAS record, stored months after it was observed: LATE badge and the ingest-lag line.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const OUT = path.join(REPO_DIR, "docs/evidence/quality");
const DAY = 86_400_000;
const LOAD_TIMEOUT_MS = 120_000;
const REGION = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 };

const log = (...a: unknown[]) => console.error("[e2e:quality]", ...a);
/** Screenshots written. */
let shots = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const around = (lat: number, lon: number, d = 0.01) => ({ west: lon - d, south: lat - d, east: lon + d, north: lat + d });

type Sighting = { id: string; source: string; canonicalId: string | null; conflict: boolean; observedAt: string; ingestedAt: string; lat: number; lon: number; taxon: { id: string } };
type Reading = { station: { id: string; name: string; source: string; lat: number; lon: number }; param: string; value: number | null; flag: string; observedAt: string; origin: string };
type Feed = { source: string; state: string; newestObservedAt: string | null; lastFetchRunId: string | null; note: string | null };

const SIGHTINGS = `query($b: BBox!, $f: Time!, $t: Time!) { sightings(bbox: $b, from: $f, to: $t) {
  id source canonicalId conflict observedAt ingestedAt lat lon taxon { id } } }`;
const READINGS = `query($b: BBox!, $f: Time!, $t: Time!, $p: [Param!]) { readings(bbox: $b, from: $f, to: $t, params: $p) {
  station { id name source lat lon } param value flag observedAt origin } }`;

/** Every sighting in the region over the last `days`, in 31-day GraphQL windows (the API's cap). */
async function allSightings(stack: Stack, days: number): Promise<Sighting[]> {
  const out: Sighting[] = [];
  const now = Date.now();
  for (let to = now; to > now - days * DAY; to -= 30 * DAY) {
    const data = await stack.graphql<{ sightings: Sighting[] }>(SIGHTINGS, { b: REGION, f: iso(to - 30 * DAY), t: iso(to) });
    out.push(...data.sightings);
  }
  return [...new Map(out.map((s) => [s.id, s])).values()];
}

const readingId = (r: Reading) => `reading:${r.station.id}:${r.param.toLowerCase()}:${Date.parse(r.observedAt)}:${r.origin.toLowerCase()}`;

async function openPage(browser: Awaited<ReturnType<typeof chromium.launch>>, origin: string, hash: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
  await page.goto(`${origin}/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  return page;
}

/**
 * Open an evidence id in the drawer through the share link, wait for it to load, screenshot it, and check its text.
 * The plain summary and its quality flags are on top; `expert` also unfolds "Details for experts" for the shot.
 */
async function drawer(page: Page, id: string, file: string, expect: RegExp[], expert = false): Promise<string> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#e=${encodeURIComponent(id)}`);
  const el = page.locator("[data-testid=hud-drawer]");
  await page.waitForFunction((want) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent === want, id, { timeout: 30_000 });
  await page.waitForFunction(() => !/Loading evidence/.test(document.querySelector("[data-testid=hud-drawer]")?.textContent ?? ""), undefined, { timeout: 30_000 });
  if (expert) await page.evaluate(() => document.querySelector<HTMLDetailsElement>("[data-testid=drawer-expert]")?.setAttribute("open", ""));
  await page.waitForTimeout(400);
  await el.screenshot({ path: path.join(OUT, file) });
  shots += 1;
  const text = (await el.textContent()) ?? "";
  const missing = expect.filter((re) => !re.test(text));
  if (missing.length) throw new Error(`${file}: drawer for ${id} lacks ${missing.join(", ")}:\n${text.slice(0, 1500)}`);
  log(`${file}: ${id}`);
  return text;
}

async function main() {
  buildApi(log);
  buildWeb(log);
  mkdirSync(OUT, { recursive: true });
  const stack = await startStack({ name: "quality" });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const results: string[] = [];
  try {
    const now = Date.now();

    // ---- seed the stale observation through the signed hook. It must be the `web` feed's newest row, so the SST
    //      pixel (observed hours ago, same feed) is pushed only after the stale case is on screen.
    const stale = await stack.hook([
      {
        Sighting: {
          ext_id: "t27-stale-1",
          taxon: { scientific_name: "Python bivittatus", common_name: "Burmese python" },
          lat: 25.7602,
          lon: -80.7715,
          accuracy_m: 10,
          observed_at: now - 3 * DAY,
          quality: "curated",
          photo_url: null,
        },
      },
    ]);
    const buoy = (await stack.graphql<{ readings: Reading[] }>(READINGS, { b: around(26.001, -80.096), f: iso(now - 30 * DAY), t: iso(now), p: ["SST_C"] })).readings
      .filter((r) => r.station.source === "ndbc" && r.origin === "MEASURED" && r.flag === "OK" && r.value !== null)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!buoy) throw new Error("no measured SST at buoy 41122 in the fixtures");
    log(`seeded: stale sighting (run ${String(stale.fetchRunId)})`);

    // ---- find the fixture cases through GraphQL
    const feeds = (await stack.graphql<{ feeds: Feed[] }>("{ feeds { source state newestObservedAt lastFetchRunId note } }")).feeds;
    const goes = feeds.find((f) => f.source === "goes19");
    if (!goes?.newestObservedAt) throw new Error("no GOES scan in the fixtures");
    const scanAt = Date.parse(goes.newestObservedAt);
    const lst = (await stack.graphql<{ readings: Reading[] }>(READINGS, { b: REGION, f: iso(scanAt), t: iso(scanAt), p: ["LST_C"] })).readings;
    const cloudy = lst.filter((r) => r.flag === "CLOUD");
    const bad = lst.filter((r) => r.flag === "BAD_DQF");
    if (cloudy.length === 0 || bad.length === 0) throw new Error(`GOES scan: ${cloudy.length} cloud, ${bad.length} bad DQF pixels`);
    // Frame the globe on the cloudiest part of the scan: the median cloud pixel.
    const mid = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const centre = { lat: mid(cloudy.map((r) => r.station.lat)), lon: mid(cloudy.map((r) => r.station.lon)) };
    const cloud = cloudy.sort((a, b) => Math.hypot(a.station.lat - centre.lat, a.station.lon - centre.lon) - Math.hypot(b.station.lat - centre.lat, b.station.lon - centre.lon))[0]!;

    const sightings = await allSightings(stack, 400);
    const byId = new Map(sightings.map((s) => [s.id, s]));
    const dup = sightings.find((s) => s.source === "gbif" && s.canonicalId && byId.get(s.canonicalId)?.source === "inat");
    const flip = sightings.find((s) => s.source === "inat" && s.conflict && Number(s.taxon.id) <= 4);
    const lag = (s: Sighting) => Date.parse(s.ingestedAt) - Date.parse(s.observedAt);
    const late = sightings.filter((s) => s.source === "nas" && lag(s) > DAY).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!dup || !flip || !late) throw new Error(`fixtures: duplicate ${dup?.id}, flip ${flip?.id}, late ${late?.id}`);

    // ---- stale: the web feed's row in the About popover (T41), then its fetch run in the drawer
    const page = await openPage(browser, stack.origin, `#v=1&c=25.70000,-80.60000,160000,0,-90&l=sightings,hotspots`);
    // FEEDS comes over the `feeds` subscription, published every 15 s.
    await page.waitForFunction(() => ((window.__inversa!.state("FEEDS") as { source: string; state: string }[] | undefined) ?? []).some((f) => f.source === "web" && f.state === "stale"), undefined, { timeout: 60_000 });
    await page.click("[data-testid=status-button]");
    await page.click("[data-testid=data-sources] > summary");
    const row = page.locator("[data-testid=status-popover] [data-feed=web][data-state=stale]");
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.locator("[data-testid=status-popover]").screenshot({ path: path.join(OUT, "stale-feed-row.png") });
    shots += 1;
    const rowText = `${(await row.getAttribute("title")) ?? ""} ${(await row.textContent()) ?? ""}`;
    if (!/stale/.test(rowText) || !/max latency is 1d/.test(rowText)) throw new Error(`web feed row: ${rowText}`);
    await row.locator("button").click();
    await page.waitForFunction(() => /^fetch:/.test(document.querySelector("[data-testid=hud-drawer-id]")?.textContent ?? ""), undefined, { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(document.querySelector("[data-testid=hud-drawer-quality]")), undefined, { timeout: 30_000 });
    await page.click("[data-testid=status-button]"); // close the popover so the drawer is in the clear
    await page.evaluate(() => document.querySelector<HTMLDetailsElement>("[data-testid=drawer-expert]")?.setAttribute("open", ""));
    await page.waitForTimeout(300);
    await page.locator("[data-testid=hud-drawer]").screenshot({ path: path.join(OUT, "stale-drawer.png") });
    shots += 1;
    const staleText = (await page.locator("[data-testid=hud-drawer]").textContent()) ?? "";
    if (!/WEB data out of date/.test(staleText) || !/max latency is 1d/.test(staleText)) throw new Error(`stale drawer: ${staleText.slice(0, 800)}`);
    results.push(`stale=web feed row+drawer`);

    // ---- missing (1): cloud hatching on the LST layer at the frame after the scan, then a cloud pixel
    const frameAt = Math.floor(scanAt / 3_600_000) * 3_600_000 + 3_600_000;
    const tMin = iso(frameAt).slice(0, 16) + "Z";
    const globePage = await openPage(browser, stack.origin, `#v=1&c=${centre.lat.toFixed(5)},${centre.lon.toFixed(5)},420000,0,-90&t=${tMin}&l=lst`);
    await globePage.waitForFunction(
      () => {
        const l = window.__inversa?.globe()?.layers.find((x) => x.id === "lst");
        return (l?.count ?? 0) > 0;
      },
      undefined,
      { timeout: LOAD_TIMEOUT_MS },
    );
    await globePage.waitForTimeout(5_000); // imagery tiles
    // The drawn frame's gap cells: flagged pixels in the grid the layer painted.
    const gaps = await globePage.evaluate((at) => {
      const d = window.__inversa!;
      const frame = d.snapshot().frame;
      const lstLayer = d.globe()?.layers.find((x) => x.id === "lst");
      return { frame, layerFrame: lstLayer?.frame ?? -1, valid: lstLayer?.count ?? 0, at, time: (d.state("TIME") as { at: string }).at };
    }, iso(frameAt));
    await globePage.screenshot({ path: path.join(OUT, "missing-cloud-globe.png") });
    shots += 1;
    log(`globe: LST frame ${gaps.layerFrame} (TIME ${gaps.time}), ${gaps.valid} valid cells`);
    await drawer(globePage, readingId(cloud), "missing-cloud-drawer.png", [/Cloud cover — no reading/, /GOES/]);
    await drawer(globePage, readingId(bad[0]!), "missing-bad-dqf-drawer.png", [/Bad satellite data — no reading/]);

    // ---- missing (2): a push that does not normalize is a failed fetch
    const failed = await stack.hookRaw(JSON.stringify([{ Reading: { station: { ext_id: "broken" } } }]));
    if (failed.status !== 422) throw new Error(`broken hook body answered ${failed.status}: ${failed.text}`);
    const failedRun = (JSON.parse(failed.text) as { fetchRunId: number }).fetchRunId;
    await drawer(globePage, `fetch:${failedRun}`, "missing-fetch-failed-drawer.png", [/Data check failed/, /normalize/], true);
    results.push(`missing=cloud ${cloudy.length} bad_dqf ${bad.length} failed_fetch fetch:${failedRun}`);

    // ---- duplicate, conflict, late
    await drawer(globePage, `sighting:${dup.id}`, "duplicate-drawer.png", [/Same animal as an earlier report/, /DUPLICATE OF/, new RegExp(`sighting:${dup.canonicalId}`)]);
    await drawer(globePage, `sighting:${dup.canonicalId}`, "duplicate-canonical-drawer.png", [/Also reported once more elsewhere/, new RegExp(`sighting:${dup.id}`)]);
    results.push(`duplicate=sighting:${dup.id}->sighting:${dup.canonicalId}`);
    await drawer(globePage, `sighting:${flip.id}`, "conflict-idflip-drawer.png", [/Sources disagree/, /REVISION/, /taxon:/], true);
    // The SST pixel next to buoy 41122, 2.4 °C warmer.
    const pixelAt = Date.parse(buoy.observedAt) + 10 * 60_000;
    await stack.hook([
      {
        Reading: {
          station: { ext_id: "t27-sst-pixel", name: "SST pixel 2 km north of 41122", lat: buoy.station.lat + 0.018, lon: buoy.station.lon, kind: "goes_cell" },
          param: "sst_c",
          value: buoy.value! + 2.4,
          flag: "ok",
          observed_at: pixelAt,
          origin: "satellite",
        },
      },
    ]);
    log(`seeded: SST pixel at ${iso(pixelAt)} next to ${buoy.station.name} ${buoy.value} °C`);
    const buoyId = readingId(buoy);
    await drawer(globePage, buoyId, "conflict-sst-drawer.png", [/Sources disagree/, /1 CONFLICT/, /:sst_c:/], true);
    results.push(`conflict=sighting:${flip.id} ${buoyId}`);
    const lateDays = Math.floor(lag(late) / DAY);
    await drawer(globePage, `sighting:${late.id}`, "late-drawer.png", [new RegExp(`Late report — reached us ${lateDays}d`), new RegExp(`Ingest lag${lateDays}d`)]);
    results.push(`late=sighting:${late.id} ${lateDays}d`);

    for (const line of results) console.log(`QUALITY ${line}`);
    console.log(`QUALITY cases=5 shots=${shots}`);
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
    throw err;
  } finally {
    await browser.close();
    await stack.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
