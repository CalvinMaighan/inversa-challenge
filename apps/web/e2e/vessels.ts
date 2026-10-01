/**
 * Leaf GE4 e2e: ships on the carp app, end to end, with no network. A local mock AISStream websocket (Bun.serve)
 * checks the subscription Axum sends (key, the carp box latitude first, message types) and answers with frames
 * built from the recorded fixtures in api/tests/fixtures/ais/ (the real FEDERAL OSHIMA PositionReport and the
 * ShipStaticData template): six ships sailing east off the Louisiana coast, one fix every 10 minutes for the
 * last 26 hours, plus their static data. Axum runs the carp pollers offline (dead proxy) with
 * `AISSTREAM_URL=ws://127.0.0.1:<mock>` and a mock key, so the AIS source ingests through the real pipeline.
 *
 * The page opens on the carp app, turns Ships on in the Layers legend (under the "Ships" heading), then presses
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

import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const log = (...a: unknown[]) => console.error("[e2e:vessels]", ...a);
const FIXTURES = path.join(REPO_DIR, "api/tests/fixtures/ais");
const MOCK_KEY = "e2e-mock-aisstream-key";
const SHIPS = 6;
const HOURS = 26;
const STEP_MIN = 10;
const MIN = 60_000;
const LOAD_TIMEOUT_MS = 120_000;
const CARP_BOX = [[28.9, -94.0], [32.9, -88.8]];
const TYPES = [70, 80, 60, 30, 52, 37];
const NAMES = ["GULF TRADER", "DELTA STAR", "BAYOU QUEEN", "PELICAN", "MISS LOUISE", "REEL DEAL"];

/** An AISStream envelope (the recorded fixtures). */
type Envelope = { MessageType: string; MetaData: Record<string, unknown>; Message: Record<string, Record<string, unknown>> };
type Subscription = { APIKey?: unknown; BoundingBoxes?: unknown; FilterMessageTypes?: unknown };
type Track = { mmsi: string; name: string | null; type: string; points: { at: string }[] };

function fail(message: string): never {
  throw new Error(message);
}

/** AISStream's `MetaData.time_utc` format, e.g. `2024-12-09 02:27:43.237370229 +0000 UTC`. */
const aisTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, ".$1000000 +0000 UTC");

/** Frames for the mock: static data, then every ship's fixes in time order. Built from the recorded templates. */
async function buildFrames(nowMs: number): Promise<{ frames: string[]; fromMs: number; toMs: number }> {
  const position = (await Bun.file(path.join(FIXTURES, "position_report.json")).json()) as Envelope;
  const statics = (await Bun.file(path.join(FIXTURES, "ship_static_data.json")).json()) as Envelope;
  const frames: string[] = [];
  const toMs = Math.floor(nowMs / MIN) * MIN - 2 * MIN;
  const fromMs = toMs - HOURS * 3_600_000;
  for (let s = 0; s < SHIPS; s += 1) {
    const mmsi = 367_500_000 + s;
    const st = structuredClone(statics);
    st.MetaData = { ...st.MetaData, MMSI: mmsi, MMSI_String: mmsi, ShipName: NAMES[s], latitude: 29.0 + 0.08 * s, longitude: -93.8, time_utc: aisTime(fromMs) };
    st.Message.ShipStaticData = { ...st.Message.ShipStaticData, UserID: mmsi, Name: `${NAMES[s]}@@@@`, Type: TYPES[s], Destination: "NEW ORLEANS" };
    frames.push(JSON.stringify(st));
  }
  for (let t = fromMs; t <= toMs; t += STEP_MIN * MIN) {
    const hours = (t - fromMs) / 3_600_000;
    for (let s = 0; s < SHIPS; s += 1) {
      const mmsi = 367_500_000 + s;
      // 4 to 8 kn: 26 h east from 93.8 W stays inside the carp box (east edge 88.8 W).
      const knots = 4 + 0.8 * s;
      const lat = 29.0 + 0.08 * s;
      // East at `knots`: one knot is 1/60 degree of latitude per hour; longitude degrees shrink by cos(lat).
      const lon = -93.8 + (knots * hours) / 60 / Math.cos((lat * Math.PI) / 180);
      const p = structuredClone(position);
      p.MetaData = { ...p.MetaData, MMSI: mmsi, MMSI_String: mmsi, ShipName: NAMES[s], latitude: lat, longitude: lon, time_utc: aisTime(t) };
      p.Message.PositionReport = { ...p.Message.PositionReport, UserID: mmsi, Latitude: lat, Longitude: lon, Sog: knots, Cog: 90, TrueHeading: 90, NavigationalStatus: 0 };
      frames.push(JSON.stringify(p));
    }
  }
  return { frames, fromMs, toMs };
}

type MockState = { subscriptions: Subscription[]; sent: number; errors: string[] };

/** The mock AISStream: one subscription per connection, checked, then every frame as a binary message. */
function startMock(frames: string[]): { url: string; state: MockState; stop(): void } {
  const state: MockState = { subscriptions: [], sent: 0, errors: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/v0/stream" || !srv.upgrade(req)) return new Response("upgrade required", { status: 426 });
      return undefined;
    },
    websocket: {
      message(ws, message) {
        let sub: Subscription;
        try {
          sub = JSON.parse(String(message));
        } catch {
          state.errors.push("subscription is not JSON");
          ws.send(JSON.stringify({ error: "bad subscription" }));
          return;
        }
        state.subscriptions.push({ ...sub, APIKey: sub.APIKey === MOCK_KEY ? "<mock key>" : "<other>" });
        if (sub.APIKey !== MOCK_KEY) {
          ws.send(JSON.stringify({ error: "Api Key Is Not Valid" }));
          return;
        }
        for (const f of frames) {
          ws.send(new TextEncoder().encode(f));
          state.sent += 1;
        }
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/v0/stream`, state, stop: () => server.stop(true) };
}

type VesselStats = { count: number; enabled: boolean; error: string | null; vessels?: { atMs: number; trails: number; positions: Record<string, [number, number]> } };

const vesselStats = (page: Page) =>
  page.evaluate(() => {
    const g = window.__inversa?.globe();
    return (g?.layers.find((l) => l.id === "vessels") ?? null) as unknown as VesselStats | null;
  });

async function waitForTracks(stack: Stack, fromMs: number, toMs: number): Promise<Track[]> {
  const deadline = Date.now() + 120_000;
  const q = `query($bbox: BBox!, $from: Time!, $to: Time!) { vessels(bbox: $bbox, from: $from, to: $to) { mmsi name type points { at } } }`;
  for (;;) {
    const d = await stack.graphql<{ vessels: Track[] }>(q, { bbox: { west: -94, south: 28.9, east: -88.8, north: 32.9 }, from: new Date(fromMs - MIN).toISOString(), to: new Date(Math.min(toMs + MIN, fromMs + 7 * 24 * 3_600_000)).toISOString() });
    const complete = d.vessels.length === SHIPS && d.vessels.every((v) => v.points.length >= HOURS * (60 / STEP_MIN));
    if (complete) return d.vessels;
    if (Date.now() > deadline) fail(`vessels not ingested: ${d.vessels.length} tracks, points ${d.vessels.map((v) => v.points.length).join(",")}`);
    await Bun.sleep(1000);
  }
}

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
    // Layers legend: About, then "More data (for experts)"; Ships has its own heading.
    await page.click('[data-testid="status-button"]');
    await page.click('[data-testid="layers-button"]');
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
