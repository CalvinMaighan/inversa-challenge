/**
 * Leaf GE4 e2e: ships on the carp app, end to end, with no network. A local mock AISStream websocket (Bun.serve)
 * checks the subscription Axum sends (key, the carp box latitude first, message types) and answers with frames
 * built from the recorded fixtures in api/tests/fixtures/ais/ (the real FEDERAL OSHIMA PositionReport and the
 * ShipStaticData template): six ships sailing east off the Louisiana coast, one fix every 10 minutes for the
 * last 26 hours, plus their static data. Axum runs the carp pollers offline (dead proxy) with
 * `AISSTREAM_URL=ws://127.0.0.1:<mock>` and a mock key, so the AIS source ingests through the real pipeline.
 *
 * The page opens on the carp app, turns Ships on in the bottom bar's Layers popover (under the "Ships" heading), then presses
 * the carp timeline's play button (replay from 48 h ago to now) and samples the vessels layer's drawn positions
 * (`window.__inversa.globe()` layer stats, read only). A ship "moved" when its position differs between two
 * samples at different timeline times. Finally a click on a ship opens its evidence card with an "Open at
 * VesselFinder" link in a new tab.
 *
 *   bun run e2e:vessels           build, run, print the VESSELS line
 *   E2E_SKIP_BUILD=1 …            reuse the last e2e web build
 *
 * Line: VESSELS shown=<n> moved=<n> window_h=<h> trails=<n> (plus VESSELS-CHECKS with the other checks)
 */
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { buildFrames, CARP_BOX, HOURS, MOCK_KEY, NAMES, SHIPS, startMock, waitForTracks } from "./ais-mock";
import { buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const log = (...a: unknown[]) => console.error("[e2e:vessels]", ...a);
const LOAD_TIMEOUT_MS = 120_000;

function fail(message: string): never {
  throw new Error(message);
}

type VesselStats = { count: number; enabled: boolean; error: string | null; vessels?: { atMs: number; trails: number; positions: Record<string, [number, number]> } };

const vesselStats = (page: Page) =>
  page.evaluate(() => {
    const g = window.__inversa?.globe();
    return (g?.layers.find((l) => l.id === "vessels") ?? null) as unknown as VesselStats | null;
  });

async function main(): Promise<void> {
  const nowMs = Date.now();
  const { frames, fromMs, toMs } = await buildFrames(nowMs);
  const mock = startMock(frames);
  log(`mock AISStream ${mock.url}: ${frames.length} frames (${SHIPS} ships, ${HOURS} h)`);
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "vessels", app: "carp", apps: ["carp"], offlinePollers: true, axumEnv: { AISSTREAM_URL: mock.url, AISSTREAM_API_KEY: MOCK_KEY } });
  let browser: Browser | null = null;
  try {
    const tracks = await waitForTracks(stack, fromMs, toMs);
    const times = tracks.flatMap((t) => t.points.map((p) => Date.parse(p.at)));
    const windowH = Math.round((Math.max(...times) - Math.min(...times)) / 3_600_000);
    // Carp and lionfish both list the feed: each app opens its own connection with its own boxes.
    const sub = mock.state.subscriptions.find((s) => JSON.stringify(s.BoundingBoxes) === JSON.stringify([CARP_BOX])) ?? fail(`no carp subscription: ${JSON.stringify(mock.state.subscriptions.map((s) => s.BoundingBoxes))}`);
    const subOk = sub.APIKey === "<mock key>" && JSON.stringify(sub.BoundingBoxes) === JSON.stringify([CARP_BOX]) && Array.isArray(sub.FilterMessageTypes) && sub.FilterMessageTypes.includes("PositionReport");
    if (!subOk) fail(`subscription ${JSON.stringify(sub)}`);
    const feeds = await stack.graphql<{ feeds: { source: string; state: string; note: string | null }[] }>("{ feeds { source state note } }");
    const feed = feeds.feeds.find((f) => f.source === "aisstream") ?? fail("no aisstream feed");
    log(`feed aisstream: ${feed.state} ${feed.note ?? ""}; ${tracks.length} tracks over ${windowH} h`);

    browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The camera over the ships' lane (share link `c`: lat, lon, altitude m, heading, pitch).
    await page.goto(`${stack.origin}/?app=carp#v=2&app=carp&c=29.2,-91.6,900000,0,-90`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="app-select-button"][data-app="carp"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction(() => !!window.__inversa?.globe(), undefined, { timeout: LOAD_TIMEOUT_MS });

    // Default off.
    const before = await vesselStats(page);
    const defaultOff = before !== null && before.enabled === false;
    // The Layers popover in the bottom bar (GE7); Ships has its own heading.
    await page.click('[data-testid="layers-bar-button"]');
    await page.locator('[data-testid="legend-group-ships"]').waitFor({ timeout: 20_000 });
    const groupOk = (await page.locator('[data-testid="legend-group-ships"]').innerText()).toLowerCase() === "ships";
    await page.click('[data-testid="legend-toggle-vessels"]');
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const s = window.__inversa?.globe()?.layers.find((l) => l.id === "vessels") as unknown as VesselStats | undefined;
      return !!s && s.enabled && s.count > 0;
    }, undefined, { timeout: 60_000 });
    const credit = await page.evaluate(() => document.body.innerText.includes("Vessel positions: AISStream.io"));

    // Play the carp timeline (replay from 48 h ago to now) and sample the drawn ships.
    await page.click('[data-testid="carp-play"]');
    const samples: { atMs: number; count: number; trails: number; positions: Record<string, [number, number]> }[] = [];
    const sampleUntil = Date.now() + 30_000;
    while (Date.now() < sampleUntil) {
      const s = await vesselStats(page);
      if (s?.vessels) samples.push({ atMs: s.vessels.atMs, count: s.count, trails: s.vessels.trails, positions: s.vessels.positions });
      const replaying = await page.evaluate(() => document.querySelector('[data-testid="carp-play"]')?.getAttribute("aria-pressed") === "true");
      if (!replaying && samples.length > 10) break;
      await Bun.sleep(100);
    }
    const shown = Math.max(0, ...samples.map((s) => s.count));
    const trails = Math.max(0, ...samples.map((s) => s.trails));
    const moved = new Set<string>();
    const distinctTimes = new Set(samples.map((s) => s.atMs)).size;
    for (let i = 1; i < samples.length; i += 1) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      if (a.atMs === b.atMs) continue;
      for (const [mmsi, p] of Object.entries(b.positions)) {
        const q = a.positions[mmsi];
        if (q && (Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6)) moved.add(mmsi);
      }
    }

    // Back at live: click a ship, the card opens with its VesselFinder link in a new tab.
    await page.waitForFunction(() => document.querySelector('[data-testid="carp-play"]')?.getAttribute("aria-pressed") !== "true", undefined, { timeout: 60_000 });
    await Bun.sleep(1500);
    const live = (await vesselStats(page)) ?? fail("no vessel stats after replay");
    await page.screenshot({ path: path.join(REPO_DIR, "docs/evidence/vessels-carp.png") });
    log("screenshot docs/evidence/vessels-carp.png");
    let card = "fail";
    for (const [mmsi, [lon, lat]] of Object.entries(live.vessels?.positions ?? {})) {
      // project/pick work in globe-canvas pixels; the page click needs the canvas offset (the chat column is left of it).
      const pt = await page.evaluate(([lon, lat]) => {
        const at = window.__inversa?.project(lon!, lat!);
        const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
        if (!at || !canvas) return null;
        const r = canvas.getBoundingClientRect();
        return { x: r.left + at.x, y: r.top + at.y, cx: at.x, cy: at.y };
      }, [lon, lat]);
      if (!pt) continue;
      const picked = await page.evaluate(([x, y]) => window.__inversa?.pick(x!, y!) ?? null, [pt.cx, pt.cy]);
      // Only a ship that is picked there and not under a HUD panel can be clicked.
      const under = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x!, y!);
        return el ? `${el.tagName}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}` : "none";
      }, [pt.x, pt.y]);
      if (picked !== `vessel:${mmsi}` || under !== "CANVAS") {
        log(`ship ${mmsi} at ${Math.round(pt.x)},${Math.round(pt.y)}: picked=${picked} under=${under}`);
        continue;
      }
      await page.mouse.click(pt.x, pt.y);
      const link = page.locator('[data-testid="source-page-link"]');
      const shown = await link.waitFor({ timeout: 20_000 }).then(
        () => true,
        async () => {
          const selection = await page.evaluate(() => window.__inversa?.state("SELECTION"));
          const drawer = await page.evaluate(() => document.querySelector('[data-testid="evidence-summary"]')?.closest("section, aside, div")?.textContent?.slice(0, 400) ?? null);
          log(`no source link after clicking vessel:${mmsi}: selection=${JSON.stringify(selection)} drawer=${drawer}`);
          return false;
        },
      );
      if (!shown) break;
      await page.screenshot({ path: path.join(REPO_DIR, "docs/evidence/vessels-card.png") });
      log("screenshot docs/evidence/vessels-card.png");
      const [text, href, target, rel, summary] = await Promise.all([link.innerText(), link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel"), page.locator('[data-testid="evidence-summary"]').innerText()]);
      const nameOk = NAMES.some((n) => summary.includes(n)) && /kn/.test(summary) && /course/.test(summary) && /last heard .*ago/.test(summary);
      card = text.includes("VesselFinder") && href === `https://www.vesselfinder.com/vessels/details/${mmsi}` && target === "_blank" && rel === "noopener noreferrer" && nameOk ? "ok" : (log(`card text=${text} href=${href} target=${target} rel=${rel} summary=${summary}`), "fail");
      break;
    }
    if (card === "fail") log("no ship could be clicked (none projected and picked)");

    console.log(`VESSELS shown=${shown} moved=${moved.size} window_h=${windowH} trails=${trails}`);
    console.log(
      `VESSELS-CHECKS default_off=${defaultOff ? "ok" : "fail"} ships_group=${groupOk ? "ok" : "fail"} credit=${credit ? "ok" : "fail"} card=${card} subscription=ok frames_sent=${mock.state.sent} samples=${samples.length} timeline_times=${distinctTimes} feed=${feed.state} page_errors=${errors.length}`,
    );
    if (errors.length) log(`page errors: ${errors.slice(0, 5).join(" | ")}`);
  } catch (err) {
    console.error(stack.logs());
    throw err;
  } finally {
    await browser?.close();
    await stack.stop();
    mock.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
