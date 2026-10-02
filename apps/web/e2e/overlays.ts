/**
 * Water and weather overlays against the real upstreams through the running proxy (gates/leaf-GE5.md G2, G3, G7).
 *
 *   bun run e2e:overlays          build api + web, start the real stack (e2e/stack.ts), probe, play, screenshot
 *   E2E_SKIP_BUILD=1 …            reuse the last e2e build
 *
 * 1. One tile per raster layer and the cyclone document, fetched from the page origin (`/v1/<app>/overlay/...`,
 *    the front proxy to Axum, which fetches NASA GIBS, NOAA nowCOAST and NHC): the body is sniffed (PNG magic,
 *    JSON shape), never just the status. Line: `OVERLAYS sst=<status> radar=<status> clouds=<status>
 *    lightning=<status> cyclones=<status>`, where a 200 whose body is not an image or a storm document is reported
 *    as `200-badbody`.
 * 2. In the browser (lionfish, radar on through the share link, cursor 45 minutes before the live edge), play the
 *    timeline at 1 frame per second across 30 minutes and count the distinct radar times requested and the changes
 *    of the instant the layer reports. Line: `OVERLAY-TIME radar_steps=<n> shown_changes=<n>`.
 * 3. Screenshots to docs/evidence/: SST over the Florida Keys (lionfish), radar and lightning over Louisiana
 *    (carp; `RADAR-ECHO louisiana_tile_pixels=<n>` says whether anything was raining in the probed tile), clouds,
 *    and the storms layer. Each with the Layers popover open on the "Water and weather" group.
 * Exit 0 only when every layer answered 200 with a good body and shown_changes > 1.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

import type { AppId } from "../shared/apps";
import { CLOUDS, CYCLONES, cyclonesUrl, LIGHTNING, overlaySpec, overlayTileUrl, RADAR, snapOverlayTime, SST_MAP, type OverlayId } from "../shared/overlays";
import { compactIso } from "../client/hud/share-link";
import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const EVIDENCE = path.join(REPO_DIR, "docs/evidence");
const LOAD_TIMEOUT_MS = 120_000;
const MIN = 60_000;

const log = (...a: unknown[]) => console.error("[e2e:overlays]", ...a);

/** Web Mercator tile of a point at zoom `z`. */
function tileAt(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

const KEYS = { lon: -81.0, lat: 24.7 };
const LOUISIANA = { lon: -91.5, lat: 30.5 };

type Probe = { id: OverlayId; app: AppId; status: string; bytes: number; cache: string; url: string };

/** One tile (or the storm document) per layer through the proxy, body sniffed. */
async function probe(stack: Stack): Promise<Probe[]> {
  const now = Date.now();
  const out: Probe[] = [];
  const rasters: { id: OverlayId; app: AppId; at: { lon: number; lat: number } }[] = [
    { id: SST_MAP, app: "lionfish", at: KEYS },
    { id: RADAR, app: "carp", at: LOUISIANA },
    { id: CLOUDS, app: "carp", at: LOUISIANA },
    { id: LIGHTNING, app: "carp", at: LOUISIANA },
  ];
  for (const r of rasters) {
    const spec = overlaySpec(r.id);
    const z = Math.min(6, spec.maxZoom ?? 6);
    const { x, y } = tileAt(r.at.lon, r.at.lat, z);
    const shown = snapOverlayTime(spec, now, now).shownMs;
    const url = `${stack.origin}${overlayTileUrl(r.app, r.id, z, x, y, shown)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const body = new Uint8Array(await res.arrayBuffer());
    const png = body.length > 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47;
    const status = res.status === 200 && !png ? "200-badbody" : String(res.status);
    out.push({ id: r.id, app: r.app, status, bytes: body.length, cache: res.headers.get("x-overlay-cache") ?? "", url });
    log(`${r.id}: ${res.status} ${res.headers.get("content-type")} ${body.length} bytes png=${png} corp=${res.headers.get("cross-origin-resource-policy")} ${url}`);
    if (!png) log(`  body: ${new TextDecoder().decode(body.slice(0, 200))}`);
  }
  const url = `${stack.origin}${cyclonesUrl("carp")}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let good = false;
  let storms = -1;
  try {
    const doc = JSON.parse(text) as { current?: { activeStorms?: unknown[] }; features?: { type?: string; features?: unknown[] } };
    good = Array.isArray(doc.current?.activeStorms) && doc.features?.type === "FeatureCollection" && Array.isArray(doc.features.features);
    storms = doc.current?.activeStorms?.length ?? -1;
    log(`cyclones: ${res.status} ${text.length} bytes, ${storms} active storms, ${doc.features?.features?.length ?? 0} geometry features`);
  } catch {
    log(`cyclones: ${res.status} not JSON: ${text.slice(0, 200)}`);
  }
  out.push({ id: CYCLONES, app: "carp", status: res.status === 200 && !good ? "200-badbody" : String(res.status), bytes: text.length, cache: res.headers.get("x-overlay-cache") ?? "", url });
  return out;
}

type GlobeDiag = { layers: { id: string; enabled: boolean; count: number; error: string | null; overlay?: { shownMs: number; clamped: string | null } }[] } | null;

/** Open the app on a share link, wait for the globe and the named overlay to report, dismiss banners. */
async function openWith(page: Page, origin: string, app: AppId, link: Record<string, string>, layer: OverlayId): Promise<void> {
  const hash = new URLSearchParams({ v: "2", app, ...link }).toString().replace(/%2C/g, ",").replace(/%3A/g, ":");
  // A hash-only change would not reload the page (and would keep the last popover open): leave the app first.
  await page.goto("about:blank");
  await page.goto(`${origin}/?app=${app}#${hash}`, { waitUntil: "load" });
  await page.waitForFunction(
    (id) => {
      const g = (window.__inversa?.globe() ?? null) as GlobeDiag;
      const l = g?.layers.find((x) => x.id === id);
      return Boolean(l?.enabled && (l.overlay || l.error || (l.count ?? 0) > 0 || id === "cyclones"));
    },
    layer,
    { timeout: LOAD_TIMEOUT_MS },
  );
  if (await page.locator('[data-testid="lionfish-banner-dismiss"]').count()) await page.click('[data-testid="lionfish-banner-dismiss"]');
}

/** Open the bottom bar's Layers popover (GE7) so the Water and weather group is on screen; close app panels so the globe shows. */
async function openLayers(page: Page): Promise<void> {
  for (const close of await page.locator('button[aria-label="Close panel"]').all()) if (await close.isVisible()) await close.click();
  await page.waitForTimeout(400);
  if ((await page.locator("[data-testid=layers-popover]").count()) === 0) await page.click("[data-testid=layers-bar-button]");
  await page.locator("[data-testid=water-weather]").waitFor({ timeout: 10_000 });
  await page.locator("[data-testid=water-weather]").scrollIntoViewIfNeeded();
}

/** Non-transparent pixels of a tile fetched in the page (same origin), decoded by the browser. */
async function echoPixels(page: Page, tileUrl: string): Promise<number> {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n += 1;
    return n;
  }, tileUrl);
}

async function playRadar(page: Page, origin: string): Promise<{ radarSteps: number; shownChanges: number; shown: number[] }> {
  const live = Math.floor(Date.now() / (15 * MIN)) * 15 * MIN;
  const start = live - 45 * MIN;
  const times = new Set<string>();
  page.on("request", (r) => {
    const m = /\/overlay\/radar\/\d+\/\d+\/\d+\?time=([^&]+)/.exec(r.url());
    if (m) times.add(decodeURIComponent(m[1]!));
  });
  // Lionfish: a species app with the HUD timeline (carp's timeline is its stage chart), radar on over the Keys.
  await openWith(page, origin, "lionfish", { t: compactIso(new Date(start).toISOString())!, l: RADAR, c: "25.5,-81.0,1200000,0,-90" }, RADAR);
  await page.selectOption('select[aria-label="Playback speed, frames per second"]', "1");
  const shown: number[] = [];
  const sample = async () => {
    const v = await page.evaluate(() => ((window.__inversa?.globe() ?? null) as GlobeDiag)?.layers.find((l) => l.id === "radar")?.overlay?.shownMs ?? null);
    if (v !== null && shown[shown.length - 1] !== v) shown.push(v);
  };
  await sample();
  await page.click("[data-testid=hud-play]");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sample();
    const t = (await page.evaluate(() => window.__inversa?.state("TIME"))) as { at: string; playing: boolean };
    if (!t.playing || Date.parse(t.at) >= start + 30 * MIN) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(500);
  await sample();
  log(`radar times requested: ${[...times].sort().join(" ")}`);
  log(`radar shown: ${shown.map((ms) => new Date(ms).toISOString().slice(11, 16)).join(" → ")}`);
  return { radarSteps: times.size, shownChanges: Math.max(0, shown.length - 1), shown };
}

async function shoot(page: Page, name: string): Promise<string> {
  mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, name);
  await page.screenshot({ path: file });
  log(`screenshot → ${path.relative(REPO_DIR, file)}`);
  return file;
}

async function main() {
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "overlays", app: "carp", apps: ["carp", "lionfish"] });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let probes: Probe[] = [];
  let play = { radarSteps: 0, shownChanges: 0, shown: [] as number[] };
  let failed = true;
  try {
    probes = await probe(stack);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(LOAD_TIMEOUT_MS);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    play = await playRadar(page, stack.origin);

    // Screenshots.
    await openWith(page, stack.origin, "lionfish", { l: SST_MAP, c: "24.7,-81.0,700000,0,-90" }, SST_MAP);
    await page.waitForResponse((r) => r.url().includes("/overlay/sst-map/"), { timeout: 60_000 }).catch(() => log("no sst tile response seen (cached?)"));
    await page.waitForTimeout(4_000);
    await openLayers(page);
    await shoot(page, "ge5-sst-keys.png");

    await openWith(page, stack.origin, "carp", { l: `${RADAR},${LIGHTNING}`, c: "30.5,-91.5,900000,0,-90" }, RADAR);
    await page.waitForTimeout(4_000);
    const z = 6;
    const { x, y } = tileAt(LOUISIANA.lon, LOUISIANA.lat, z);
    const radarShown = snapOverlayTime(overlaySpec(RADAR), Date.now(), Date.now()).shownMs;
    const pixels = await echoPixels(page, overlayTileUrl("carp", RADAR, z, x, y, radarShown));
    console.log(`RADAR-ECHO louisiana_tile_pixels=${pixels} ${pixels === 0 ? "(clear: nothing raining in the probed tile)" : "(rain in the probed tile)"}`);
    await openLayers(page);
    await shoot(page, "ge5-radar-louisiana.png");

    await openWith(page, stack.origin, "carp", { l: CLOUDS, c: "30.5,-91.5,2500000,0,-90" }, CLOUDS);
    await page.waitForTimeout(5_000);
    await openLayers(page);
    await shoot(page, "ge5-clouds.png");

    // The eastern Pacific and the Gulf: where the recorded storms (Rachel, Nineteen-E, Nolo) were on 2026-10-01.
    await openWith(page, stack.origin, "lionfish", { l: CYCLONES, c: "18,-104,6500000,0,-90" }, CYCLONES);
    await page.waitForFunction(() => {
      const l = ((window.__inversa?.globe() ?? null) as GlobeDiag)?.layers.find((x) => x.id === "cyclones") as { breakdown?: { loaded?: number }; error: string | null } | undefined;
      return Boolean(l?.breakdown?.loaded === 1 || l?.error);
    }, undefined, { timeout: 90_000 });
    await page.waitForTimeout(3_000);
    const storms = (await page.evaluate(() => ((window.__inversa?.globe() ?? null) as GlobeDiag)?.layers.find((l) => l.id === "cyclones"))) as { count: number; error: string | null } | undefined;
    log(`cyclones layer: ${storms?.count ?? "?"} storms drawn, error=${storms?.error ?? "none"}`);
    await openLayers(page);
    await shoot(page, "ge5-cyclones.png");

    if (errors.length) log(`page errors: ${errors.join(" | ")}`);
    failed = errors.length > 0;
    await context.close();
  } catch (err) {
    log(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    log(stack.logs());
  } finally {
    await browser.close();
    await stack.stop();
  }
  const status = (id: OverlayId) => probes.find((p) => p.id === id)?.status ?? "none";
  console.log(`OVERLAYS sst=${status(SST_MAP)} radar=${status(RADAR)} clouds=${status(CLOUDS)} lightning=${status(LIGHTNING)} cyclones=${status(CYCLONES)}`);
  console.log(`OVERLAY-TIME radar_steps=${play.radarSteps} shown_changes=${play.shownChanges}`);
  const allOk = probes.length === 5 && probes.every((p) => p.status === "200");
  process.exit(failed || !allOk || play.shownChanges <= 1 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[e2e:overlays] FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
