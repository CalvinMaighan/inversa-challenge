/**
 * Data quality in the UI (gates/leaf-T27.md G3, PRD §7, rubric `data-quality/quality-ui`), per app, on the real
 * stack (e2e/stack.ts): Axum over the app's fixture backfill, `next start`, the signal Worker and the front proxy.
 * Each case is seeded through the real pipeline (fixtures, or a raw provider payload delivered through the signed
 * hook to the adapter that reads it) and opened in the app's UI the way a user does. Each screenshot is checked
 * for what it must show: the text that explains the case, and (carp, lionfish) the explaining element on screen.
 *
 *   bun run e2e:quality -- --app <id>    build, run, write docs/evidence/quality/*.png, print the QUALITY line
 *   E2E_SKIP_BUILD=1 …                    reuse the last e2e build
 *
 * Line: `QUALITY app=<id> cases=<passed> stale=ok missing=ok conflict=ok … shots=<verified screenshots>`; exit 0
 * only when every case passed.
 *
 * Python (default; the stack runs its pollers offline, `offlinePollers`: every request goes to a dead proxy and
 * fails, because with `INVERSA_SOURCES=off` every hook-able feed is `down` (disabled), which outranks `stale`; feed
 * health then follows the stored rows). Screenshots: docs/evidence/quality/{stale,missing,duplicate,conflict,late}-*.png
 * - stale:     an iNaturalist observations page delivered to the `inat` hook holds a python sighting observed 3 days
 *              ago, which becomes the `inat` feed's newest observation (the fixture ones are older): past its 6 h
 *              max latency, the feed is stale. An old row cannot make a fresher feed stale (freshness is the newest
 *              row), so what this proves is that the pushed row is what the feed is judged on: the note says
 *              "newest observation is 3d old". Its row in the About popover's data sources (T41) is
 *              `data-state=stale` with the note, and its name opens the latest fetch run, whose summary says
 *              "iNat data out of date".
 * - missing:   the fixture GOES scan's cloud and bad-DQF pixels are hatched on the LST layer (the layer's own
 *              gap count > 0); a cloud pixel's drawer says MISSING · CLOUD. An `inat` hook body that does not
 *              normalize (an observation whose id is not a number) is a 422 and a failed fetch: its drawer says
 *              Data check failed and names `normalize`.
 * - duplicate: a GBIF record mirroring an iNaturalist one: DUPLICATE OF with the link to the iNat record.
 * - conflict:  the iNat ID flip (REVISION + CONFLICT, old → new taxon) and an air temperature at NDBC station GBIF1
 *              (Gunboat Island) 6 °C above the GOES land-surface temperature of its own cell at the fixture scan
 *              (an NDBC realtime2 file delivered to the `ndbc` hook): skin more than 5 °C below air is outside the
 *              plausible band, so both readings are CONFLICT, linked both ways.
 * - late:      the newest NAS record, stored months after it was observed: LATE badge and the ingest-lag line.
 *
 * Carp (fixtures recorded 2026-10-01T07:01Z, pollers off; as e2e/carp.ts G2/G4). Screenshots: carp-*.png
 * - stale:     the page clock 12 h past the wall clock: every board row carries the `stale_observation` rule
 *              ("stale after 6 h"), every marker ring is `data-freshness=stale`, the drawer's "What is missing"
 *              says so.
 * - missing:   Krotz Springs has no discharge: the drawer's Flow reads "Not measured at this gauge"; the stale
 *              board's `cannot_assess` rows say "Cannot assess" with their reasons (never a filled status).
 * - conflict:  Krotz Springs USGS and NWPS stage are on different datums (the stage chip explains it, NWPS stage
 *              only on the chart); Monroe's USGS discharge and NWS flow estimate disagree (the flow chip, both
 *              values with their source, "not blended").
 *
 * Lionfish (fixtures recorded 2026-10-01, CRW product day 2026-09-29; page clock pinned as in e2e/lionfish.ts G3).
 * Screenshots: lionfish-*.png
 * - stale:     at 2026-10-03T06:00Z the CRW product is 90 h old: the heat layer is drawn hatched as stale (no cell
 *              drawn as current) and the area says "older than 72 h".
 * - missing:   five days back, before the first CRW product held, the heat layer is hatched missing with words ("no
 *              CRW product held"), never zero; a Mexican Caribbean place's card reads "unknown, not zero" and its
 *              heat component is `unknown`.
 * - conflict:  the Florida buoy (NDBC) against the satellite (CRW) sea surface temperature: the chip names both and
 *              says "not blended".
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { AppId } from "../shared/apps";
import { appArg } from "./args";
import { buildApi, buildWeb, inatPage, REPO_DIR, startStack, type Stack } from "./stack";

const APP: AppId = appArg();
const OUT = path.join(REPO_DIR, "docs/evidence/quality");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const LOAD_TIMEOUT_MS = 120_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const log = (...a: unknown[]) => console.error(`[e2e:quality ${APP}]`, ...a);
/** Screenshots written and verified. */
let shots = 0;
/** Case name → outcome, in print order. */
const cases = new Map<string, "ok" | "fail">();

/** Count a screenshot once the file on disk is a non-trivial PNG. */
function wrote(file: string): void {
  const p = path.join(OUT, file);
  const size = existsSync(p) ? statSync(p).size : 0;
  if (size < 2_000 || !readFileSync(p).subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${file}: not a written PNG (${size} bytes)`);
  shots += 1;
  log(`screenshot docs/evidence/quality/${file} (${size} bytes)`);
}

/** Run one case: ok when `fn` returns, fail (logged) when it throws. */
async function runCase(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    cases.set(name, "ok");
    log(`${name}: ok (${detail})`);
  } catch (err) {
    cases.set(name, "fail");
    log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function expect(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

/**
 * Screenshot the page after checking each `show` selector is visible and inside the viewport (scrolled into view
 * first), so the file shows what explains the case.
 */
async function shotShowing(page: Page, file: string, show: string[]): Promise<void> {
  for (const sel of show) await page.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const vp = page.viewportSize()!;
  for (const sel of show) {
    const el = page.locator(sel).first();
    const box = (await el.isVisible()) ? await el.boundingBox() : null;
    const inside = !!box && box.width > 0 && box.height > 0 && box.x < vp.width && box.x + box.width > 0 && box.y < vp.height && box.y + box.height > 0;
    expect(inside, `${file}: ${sel} not on screen (box ${JSON.stringify(box)})`);
  }
  await page.screenshot({ path: path.join(OUT, file) });
  wrote(file);
}

async function newPage(browser: Browser, clockMs?: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  if (clockMs !== undefined) await page.clock.setFixedTime(clockMs);
  page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
  return { context, page };
}

// ---------------------------------------------------------------------------------------------------- python

const REGION = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 };
/** NDBC GBIF1, Gunboat Island (api/src/ingest/poll/ndbc.rs STATIONS): its 0.01° cell holds a clear LST pixel of the fixture scan. */
const GBIF1 = { id: "GBIF1", lat: 25.378, lon: -81.029 };
/** The python app's scoring cell (0.01°, from the region's south-west corner) of a point. */
const cellOf = (lat: number, lon: number) => `${Math.floor((lon - REGION.west) / 0.01 + 1e-9)}:${Math.floor((lat - REGION.south) / 0.01 + 1e-9)}`;
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

async function openGlobe(browser: Browser, origin: string, hash: string): Promise<Page> {
  const { page } = await newPage(browser);
  await page.goto(`${origin}/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  return page;
}

/**
 * Open an evidence id in the drawer through the share link, wait for it to load, screenshot it, and check its text.
 * The plain summary and its quality flags are on top; `expert` also unfolds "Details for experts" for the shot.
 */
async function drawer(page: Page, id: string, file: string, want: RegExp[], expert = false): Promise<string> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#e=${encodeURIComponent(id)}`);
  const el = page.locator("[data-testid=hud-drawer]");
  await page.waitForFunction((w) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent === w, id, { timeout: 30_000 });
  await page.waitForFunction(() => !/Loading evidence/.test(document.querySelector("[data-testid=hud-drawer]")?.textContent ?? ""), undefined, { timeout: 30_000 });
  if (expert) await page.evaluate(() => document.querySelector<HTMLDetailsElement>("[data-testid=drawer-expert]")?.setAttribute("open", ""));
  await page.waitForTimeout(400);
  const text = (await el.textContent()) ?? "";
  const lacking = want.filter((re) => !re.test(text));
  if (lacking.length) throw new Error(`${file}: drawer for ${id} lacks ${lacking.join(", ")}:\n${text.slice(0, 1500)}`);
  await el.screenshot({ path: path.join(OUT, file) });
  wrote(file);
  return text;
}

async function python(stack: Stack, browser: Browser): Promise<void> {
  for (const name of ["stale", "missing", "conflict", "duplicate", "late"]) cases.set(name, "fail");
  const now = Date.now();

  // ---- seed the stale observation: an iNat observations page with a python seen 3 days ago, through the hook.
  const staleRun = await stack.hook("inat", await inatPage({ id: 900_000_000 + (now % 99_999_999), lat: 25.7602, lon: -80.7715, observedAt: now - 3 * DAY }));
  log(`seeded: stale sighting (run ${String(staleRun.fetchRunId)})`);

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

  // Two years back: the K1 ID-flip fixture (inat/idflip-p1.json) was observed on 2025-01-22.
  const sightings = await allSightings(stack, 730);
  const byId = new Map(sightings.map((s) => [s.id, s]));
  const dup = sightings.find((s) => s.source === "gbif" && s.canonicalId && byId.get(s.canonicalId)?.source === "inat");
  const flip = sightings.find((s) => s.source === "inat" && s.conflict && Number(s.taxon.id) <= 4);
  const lag = (s: Sighting) => Date.parse(s.ingestedAt) - Date.parse(s.observedAt);
  const late = sightings.filter((s) => s.source === "nas" && lag(s) > DAY).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];

  // ---- stale: the inat feed's row in the About popover (T41), then its fetch run in the drawer
  await runCase("stale", async () => {
    const page = await openGlobe(browser, stack.origin, `#v=1&c=25.70000,-80.60000,160000,0,-90&l=sightings,hotspots`);
    // FEEDS comes over the `feeds` subscription, published every 15 s; the note names the pushed row's age.
    await page.waitForFunction(
      () =>
        ((window.__inversa!.state("FEEDS") as { source: string; state: string; note: string | null }[] | undefined) ?? []).some(
          (f) => f.source === "inat" && f.state === "stale" && /newest observation is 3d old/.test(f.note ?? ""),
        ),
      undefined,
      { timeout: 60_000 },
    );
    await page.click("[data-testid=status-button]");
    await page.click("[data-testid=data-sources] > summary");
    const row = page.locator("[data-testid=status-popover] [data-feed=inat][data-state=stale]");
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const rowText = `${(await row.getAttribute("title")) ?? ""} ${(await row.textContent()) ?? ""}`;
    expect(/stale/.test(rowText) && /newest observation is 3d old; max latency is 6h/.test(rowText), `inat feed row: ${rowText}`);
    await page.locator("[data-testid=status-popover]").screenshot({ path: path.join(OUT, "stale-feed-row.png") });
    wrote("stale-feed-row.png");
    await row.locator("button").click();
    await page.waitForFunction(() => /^fetch:/.test(document.querySelector("[data-testid=hud-drawer-id]")?.textContent ?? ""), undefined, { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(document.querySelector("[data-testid=hud-drawer-quality]")), undefined, { timeout: 30_000 });
    await page.click("[data-testid=status-button]"); // close the popover so the drawer is in the clear
    await page.evaluate(() => document.querySelector<HTMLDetailsElement>("[data-testid=drawer-expert]")?.setAttribute("open", ""));
    await page.waitForTimeout(300);
    const staleText = (await page.locator("[data-testid=hud-drawer]").textContent()) ?? "";
    expect(/iNat data out of date/.test(staleText) && /max latency is 6h/.test(staleText), `stale drawer: ${staleText.slice(0, 800)}`);
    await page.locator("[data-testid=hud-drawer]").screenshot({ path: path.join(OUT, "stale-drawer.png") });
    wrote("stale-drawer.png");
    await page.context().close();
    return "inat feed row + fetch drawer";
  });

  const frameAt = Math.floor(scanAt / HOUR) * HOUR + HOUR;
  const tMin = iso(frameAt).slice(0, 16) + "Z";
  const globePage = await openGlobe(browser, stack.origin, `#v=1&c=${centre.lat.toFixed(5)},${centre.lon.toFixed(5)},420000,0,-90&t=${tMin}&l=lst`);

  // ---- missing: cloud hatching on the LST layer at the frame after the scan, a cloud and a bad-DQF pixel, and a
  //      delivery that does not normalize (an iNat page whose observation id is not a number) as a failed fetch
  await runCase("missing", async () => {
    await globePage.waitForFunction(() => (window.__inversa?.globe()?.layers.find((x) => x.id === "lst")?.count ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
    await globePage.waitForTimeout(5_000); // imagery tiles
    const layer = await globePage.evaluate(() => {
      const l = window.__inversa!.globe()?.layers.find((x) => x.id === "lst");
      return { frame: l?.frame ?? -1, valid: l?.count ?? 0, time: (window.__inversa!.state("TIME") as { at: string }).at };
    });
    log(`globe: LST frame ${layer.frame} (TIME ${layer.time}), ${layer.valid} valid cells`);
    await globePage.screenshot({ path: path.join(OUT, "missing-cloud-globe.png") });
    wrote("missing-cloud-globe.png");
    await drawer(globePage, readingId(cloud), "missing-cloud-drawer.png", [/Cloud cover — no reading/, /GOES/]);
    await drawer(globePage, readingId(bad[0]!), "missing-bad-dqf-drawer.png", [/Bad satellite data — no reading/]);
    const failed = await stack.hookRaw("inat", { total_results: 1, page: 1, per_page: 200, results: [{ id: "broken" }] });
    expect(failed.status === 422, `broken hook body answered ${failed.status}: ${failed.text}`);
    const failedRun = (JSON.parse(failed.text) as { fetchRunId: number }).fetchRunId;
    await drawer(globePage, `fetch:${failedRun}`, "missing-fetch-failed-drawer.png", [/Data check failed/, /normalize/], true);
    return `cloud ${cloudy.length} bad_dqf ${bad.length} failed_fetch fetch:${failedRun}`;
  });

  // ---- conflict: the iNat ID flip, and an NDBC air temperature 6 °C above the clear LST pixel of its own cell
  await runCase("conflict", async () => {
    expect(!!flip, "no iNat ID-flip conflict in the fixtures");
    await drawer(globePage, `sighting:${flip!.id}`, "conflict-idflip-drawer.png", [/Sources disagree/, /REVISION/, /taxon:/], true);
    // At the top of the scan's hour: an NDBC realtime2 file for the `ndbc` adapter (the URL names the station; the
    // fetch time keeps the row inside the adapter's 4-day window).
    const pixel = lst.find((r) => r.flag === "OK" && r.value !== null && cellOf(r.station.lat, r.station.lon) === cellOf(GBIF1.lat, GBIF1.lon));
    expect(!!pixel, `no clear LST pixel in GBIF1's cell ${cellOf(GBIF1.lat, GBIF1.lon)} at ${iso(scanAt)}`);
    const airAt = Math.floor(scanAt / HOUR) * HOUR;
    const air = (pixel!.value! + 6).toFixed(1);
    const d = new Date(airAt);
    const stamp = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()].map((n) => String(n).padStart(2, "0")).join(" ");
    const realtime2 = [
      "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE",
      "#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft",
      `${stamp}  MM   MM   MM    MM    MM    MM  MM     MM  ${air.padStart(4)}    MM    MM   MM   MM    MM`,
      "",
    ].join("\n");
    await stack.hook("ndbc", realtime2, { sourceUrl: `https://www.ndbc.noaa.gov/data/realtime2/${GBIF1.id}.txt`, fetchedAt: airAt + 50 * 60_000, contentType: "text/plain" });
    log(`seeded: ${GBIF1.id} air ${air} °C at ${iso(airAt)}; LST ${pixel!.value} °C at ${pixel!.station.name}`);
    const airReading = (await stack.graphql<{ readings: Reading[] }>(READINGS, { b: around(GBIF1.lat, GBIF1.lon), f: iso(airAt), t: iso(airAt), p: ["AIR_C"] })).readings.find(
      (r) => r.station.source === "ndbc" && r.origin === "MEASURED",
    );
    expect(!!airReading, `the ${GBIF1.id} air reading did not land`);
    const airId = readingId(airReading!);
    await drawer(globePage, airId, "conflict-lst-air-drawer.png", [/Sources disagree/, /1 CONFLICT/, /:lst_c:/], true);
    await drawer(globePage, readingId(pixel!), "conflict-lst-pixel-drawer.png", [/Sources disagree/, /:air_c:/], true);
    return `sighting:${flip!.id} ${airId}`;
  });

  await runCase("duplicate", async () => {
    expect(!!dup, "no GBIF copy of an iNat record in the fixtures");
    await drawer(globePage, `sighting:${dup!.id}`, "duplicate-drawer.png", [/Same animal as an earlier report/, /DUPLICATE OF/, new RegExp(`sighting:${dup!.canonicalId}`)]);
    await drawer(globePage, `sighting:${dup!.canonicalId}`, "duplicate-canonical-drawer.png", [/Also reported once more elsewhere/, new RegExp(`sighting:${dup!.id}`)]);
    return `sighting:${dup!.id}->sighting:${dup!.canonicalId}`;
  });

  await runCase("late", async () => {
    expect(!!late, "no late NAS record in the fixtures");
    const lateDays = Math.floor(lag(late!) / DAY);
    await drawer(globePage, `sighting:${late!.id}`, "late-drawer.png", [new RegExp(`Late report — reached us ${lateDays}d`), new RegExp(`Ingest lag${lateDays}d`)]);
    return `sighting:${late!.id} ${lateDays}d`;
  });
}

// ---------------------------------------------------------------------------------------------------- carp

const CARP_SITES = 8;

async function carpReady(page: Page): Promise<void> {
  await page.locator('[data-testid="app-select-button"][data-app="carp"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-carp-row]").length === n && [...document.querySelectorAll("[data-carp-site]")].every((m) => m.getAttribute("data-status") !== "loading"),
    CARP_SITES,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

/** The drawer shows `lid` with its briefing loaded and the chart drawn from loaded data. */
async function carpSite(page: Page, lid: string): Promise<void> {
  await page.locator(`[data-testid="carp-drawer"][data-site="${lid}"] [data-testid="carp-changed"]`).waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]');
      return !!c && c.dataset.message === "" && /forecast:[1-9]/.test(c.dataset.series ?? "");
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function carp(stack: Stack, browser: Browser): Promise<void> {
  for (const name of ["stale", "missing", "conflict"]) cases.set(name, "fail");
  // Stale: the page clock 12 h past the wall clock, so every observation (fixtures, pollers off) is older than 6 h.
  const stale = await newPage(browser, Date.now() + 12 * HOUR);
  await stale.page.goto(`${stack.origin}/?app=carp#v=2&app=carp&site=SMML1`);
  await carpReady(stale.page);
  await carpSite(stale.page, "SMML1");
  const rows = await stale.page.$$eval("[data-carp-row]", (els) =>
    els.map((el) => ({ lid: el.getAttribute("data-carp-row"), status: el.getAttribute("data-status"), rules: [...el.querySelectorAll("li[data-rule]")].map((li) => li.getAttribute("data-rule")), text: (el as HTMLElement).innerText })),
  );

  await runCase("stale", async () => {
    const rings = await stale.page.$$eval("[data-carp-site]", (els) => els.map((el) => el.getAttribute("data-freshness")));
    const missingText = await stale.page.locator('[data-testid="carp-missing"]').innerText();
    expect(rows.length === CARP_SITES && rows.every((r) => r.rules.includes("stale_observation") && /stale after 6 h/.test(r.text)), `rows ${JSON.stringify(rows.map((r) => [r.lid, r.rules]))}`);
    expect(rings.length === CARP_SITES && rings.every((f) => f === "stale"), `rings ${rings.join(",")}`);
    expect(/stale after 6 h/.test(missingText), `SMML1 "What is missing": ${missingText}`);
    await shotShowing(stale.page, "carp-stale.png", ['[data-carp-row] li[data-rule="stale_observation"]', '[data-carp-site][data-freshness="stale"]', '[data-testid="carp-missing"]']);
    return `${rows.length} rows stale_observation, ${rings.length} rings stale`;
  });

  const { page } = await newPage(browser);
  await page.goto(`${stack.origin}/?app=carp#v=2&app=carp&site=KRZL1`);
  await carpReady(page);
  await carpSite(page, "KRZL1");

  await runCase("missing", async () => {
    const flow = await page.locator('[data-testid="carp-flow"]').innerText();
    const missingText = await page.locator('[data-testid="carp-missing"]').innerText();
    expect(/Not measured at this gauge/.test(flow), `KRZL1 flow "${flow}"`);
    expect(missingText.trim().length > 0, "KRZL1 has no What is missing list");
    const cannot = rows.filter((r) => r.status === "cannot_assess");
    expect(cannot.length >= 1 && cannot.every((r) => /Cannot assess/i.test(r.text) && r.rules.length > 0), `cannot_assess rows ${JSON.stringify(cannot.map((r) => [r.lid, r.rules]))}`);
    await shotShowing(page, "carp-missing-flow.png", ['[data-testid="carp-flow"]']);
    await shotShowing(stale.page, "carp-missing-cannot-assess.png", ['[data-carp-row][data-status="cannot_assess"]']);
    return `flow "${flow.trim()}", ${cannot.length} cannot_assess rows (${cannot.map((r) => r.lid).join(",")})`;
  });
  await stale.context.close();

  await runCase("conflict", async () => {
    // Krotz Springs: USGS and NWPS stage on different datums.
    const stageChip = page.locator('[data-testid="carp-conflict-chip"][data-kind="stage"]');
    await stageChip.locator("summary").click();
    const stageText = await stageChip.locator("p").innerText();
    expect(/datum/.test(stageText) && /NWPS stage only/.test(stageText), `stage chip "${stageText}"`);
    await shotShowing(page, "carp-conflict-stage.png", ['[data-testid="carp-conflict-chip"][data-kind="stage"] p']);
    // Monroe: two flows that disagree, each with its source, not blended.
    await page.click('[data-carp-row="MLUL1"]');
    await carpSite(page, "MLUL1");
    const flow = await page.locator('[data-testid="carp-flow"]').innerText();
    const flowChip = page.locator('[data-testid="carp-conflict-chip"][data-kind="flow"]');
    expect((await flowChip.count()) === 1, `MLUL1 flow chips: ${await flowChip.count()}`);
    await flowChip.locator("summary").click();
    const flowText = await flowChip.locator("p").innerText();
    expect(/cfs/.test(flow) && /USGS discharge/.test(flow) && /NWS estimate/.test(flow) && /not blended/.test(flow), `MLUL1 flow "${flow}"`);
    expect(flowText.trim().length > 20, `MLUL1 flow chip "${flowText}"`);
    await shotShowing(page, "carp-conflict-flow.png", ['[data-testid="carp-flow"]', '[data-testid="carp-conflict-chip"][data-kind="flow"] p']);
    return `stage "${stageText.slice(0, 80)}"; flow "${flowText.slice(0, 80)}"`;
  });
}

// ---------------------------------------------------------------------------------------------------- lionfish

const LIVE_MS = Date.parse("2026-10-01T09:00:00Z");
const STALE_MS = Date.parse("2026-10-03T06:00:00Z");
/** 15-minute steps (TIME_STEP_MINUTES). */
const STEPS_PER_DAY = 96;

async function lionfishReady(page: Page): Promise<void> {
  await page.locator('[data-testid="app-select-button"][data-app="lionfish"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.locator('[data-testid="lionfish-hud"][data-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
  await page.click('[data-testid="lionfish-banner-dismiss"]');
}

const heatCanvas = (page: Page) => page.evaluate(() => ({ ...document.querySelector<HTMLCanvasElement>('[data-testid="lionfish-canvas"]')!.dataset }));
const heatWords = (page: Page) => page.$$eval("[data-heat-area]", (els) => els.map((e) => `${e.getAttribute("data-state")}:${(e as HTMLElement).innerText}`));

async function lionfish(stack: Stack, browser: Browser): Promise<void> {
  for (const name of ["stale", "missing", "conflict"]) cases.set(name, "fail");
  const live = await newPage(browser, LIVE_MS);
  const page = live.page;
  await page.goto(`${stack.origin}/?app=lionfish`);
  await lionfishReady(page);

  await runCase("conflict", async () => {
    const sst = page.locator('[data-testid="lionfish-sst-conflict"]').first();
    await sst.waitFor({ timeout: 30_000 });
    const text = await sst.innerText();
    const disagree = await sst.getAttribute("data-disagree");
    expect(disagree !== null && disagree !== "none" && /NDBC/.test(text) && /CRW/.test(text) && /not blended/.test(text), `sst disagree=${disagree} "${text}"`);
    await shotShowing(page, "lionfish-conflict.png", ['[data-testid="lionfish-sst-conflict"]']);
    return `disagree=${disagree} "${text.replace(/\s+/g, " ").slice(0, 120)}"`;
  });

  await runCase("missing", async () => {
    // Five days back, before the first CRW product held: hatched with words, no heat cell drawn.
    await page.locator('[data-testid="lionfish-hud"][data-replay-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
    const max = Number(await page.getAttribute("[data-hud-scrubber]", "max"));
    await page.evaluate((s) => {
      const r = document.querySelector<HTMLInputElement>("[data-hud-scrubber]")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(s));
      r.dispatchEvent(new Event("input", { bubbles: true }));
    }, max - 5 * STEPS_PER_DAY);
    await page.waitForTimeout(500);
    const past = await heatCanvas(page);
    const words = await heatWords(page);
    expect(Number(past.heatMissing) > 0 && Number(past.heatOk) === 0, `heat canvas ${JSON.stringify(past)}`);
    expect(
      words.some((w) => /^missing:[\s\S]*no CRW product held/.test(w)),
      `heat words ${JSON.stringify(words)}`,
    );
    await shotShowing(page, "lionfish-missing-heat.png", ['[data-heat-area][data-state="missing"]']);
    // Live again: a Mexican Caribbean place (no CRW within reach) reads "unknown, not zero".
    await page.click('[data-testid="hud-live"]');
    await page.waitForTimeout(400);
    await page.click('[data-area="mx-caribbean"]');
    const cell = (await page.getAttribute("[data-cell-row]", "data-cell-row"))!;
    await page.click(`[data-cell-row="${cell}"]`);
    await page.locator(`[data-testid="lionfish-card"][data-cell="${cell}"] [data-testid="lionfish-components"]`).waitFor({ timeout: 30_000 });
    const heat = await page.locator('[data-testid="lionfish-card-heat"]').innerText();
    const comp = await page.getAttribute('[data-component="heatStress"]', "data-state");
    expect(/unknown, not zero/i.test(heat) && comp === "unknown", `card ${cell} heat "${heat.slice(0, 120)}" component=${comp}`);
    await shotShowing(page, "lionfish-missing-card.png", ['[data-testid="lionfish-card-heat"]', '[data-component="heatStress"]']);
    return `heat missing=${past.heatMissing} ok=${past.heatOk}; ${cell} "${heat.replace(/\s+/g, " ").slice(0, 80)}"`;
  });
  await live.context.close();

  await runCase("stale", async () => {
    // The same CRW product 90 h later.
    const s = await newPage(browser, STALE_MS);
    await s.page.goto(`${stack.origin}/?app=lionfish`);
    await lionfishReady(s.page);
    await s.page.click('[data-area="fl-keys"]');
    await s.page.waitForTimeout(2500);
    const c = await heatCanvas(s.page);
    const words = await heatWords(s.page);
    expect(Number(c.heatStale) > 0 && Number(c.heatOk) === 0, `heat canvas ${JSON.stringify(c)}`);
    expect(
      words.some((w) => /^stale:[\s\S]*older than 72 h/.test(w)),
      `heat words ${JSON.stringify(words)}`,
    );
    await shotShowing(s.page, "lionfish-stale.png", ['[data-heat-area][data-state="stale"]']);
    await s.context.close();
    return `heat stale=${c.heatStale} ok=${c.heatOk}`;
  });
}

// ---------------------------------------------------------------------------------------------------- main

const RUNS: Record<AppId, (stack: Stack, browser: Browser) => Promise<void>> = { python, carp, lionfish };

async function main(): Promise<void> {
  buildApi(log);
  buildWeb(log);
  mkdirSync(OUT, { recursive: true });
  const stack = await startStack(APP === "python" ? { name: "quality", offlinePollers: true } : { name: `quality-${APP}`, app: APP, apps: [APP] });
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    await RUNS[APP](stack, browser);
  } catch (err) {
    log(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    log(stack.logs());
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await stack.stop();
  }
  const outcomes = [...cases];
  const passed = outcomes.filter(([, v]) => v === "ok").length;
  // stale, missing and conflict first (the rubric reads them in that order), then the app's other cases.
  const order = ["stale", "missing", "conflict"];
  const sorted = [...order.map((k) => [k, cases.get(k) ?? "fail"] as const), ...outcomes.filter(([k]) => !order.includes(k))];
  console.log(`QUALITY app=${APP} cases=${passed} ${sorted.map(([k, v]) => `${k}=${v}`).join(" ")} shots=${shots}`);
  if (passed !== outcomes.length || outcomes.length < 3) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
