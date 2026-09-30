/**
 * Client integration (gates/node-client.md N3, gates/leaf-T23.md G2) on the real stack: Axum with the fixture
 * backfill and the cold-snap scene, `next start`, and a Caddy-like front proxy (e2e/stack.ts).
 *
 *   bun run e2e:client            build, run, print the CLIENT and COLDSNAP lines
 *   bun run e2e:client --shot     also save docs/evidence/cold-snap.png
 *   E2E_SKIP_BUILD=1 …            reuse the last e2e build
 *
 * 1. The ops page `/`: the page must be cross-origin isolated, and the db worker must publish a SAB frame grid
 *    (frames > 0) fetched from Axum, read through `window.__inversa`. Console errors and page errors are
 *    counted; none are expected.
 * 2. A share link to 2026-02-01T17:00Z, months before the live 30-day window, opened in a fresh browser
 *    context: TIME must recentre the window on it, the db worker must fetch that window's frames, and the
 *    iguana hotspot at cell 292:142 (Coral Gables, docs/demo-script.md) must be hot, with sightings in the
 *    frame and on the globe.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const SHOT = path.join(REPO_DIR, "docs/evidence/cold-snap.png");
const COLD_AT = "2026-02-01T17:00:00.000Z";
/** Cell 292:142 on the 0.01° grid: its centre (PLAN.md C14). */
const CELL = { lon: -83.2 + 292.5 * 0.01, lat: 24.3 + 142.5 * 0.01 };
const LINK = `#v=1&c=25.70000,-80.30000,45000,0,-90&t=2026-02-01T17:00Z&l=sightings,hotspots,stations,alerts`;
const LOAD_TIMEOUT_MS = 120_000;

const log = (...a: unknown[]) => console.error("[e2e:client]", ...a);

type Errors = string[];

function watchErrors(page: Page, errors: Errors): void {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
}

async function opsPage(browser: Browser, origin: string, errors: Errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  watchErrors(page, errors);
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && (window.__inversa?.snapshot().sightings ?? 0) > 0, undefined, {
    timeout: LOAD_TIMEOUT_MS,
  });
  // The globe is up and its grid layer has drawn a frame of the published grid. (At the live edge the fixture
  // sightings, days old, are not in the current frame, so the point count may be 0 there.) Then let any late
  // request settle before the error count.
  await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "hotspots")?.frame ?? -1) >= 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(3_000);
  const snap = await page.evaluate(() => ({ ...window.__inversa!.snapshot(), layers: window.__inversa!.globe()?.layers }));
  await context.close();
  return snap;
}

async function coldSnap(browser: Browser, origin: string, errors: Errors, shot: boolean) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  watchErrors(page, errors);
  await page.goto(`${origin}/${LINK}`, { waitUntil: "load" });
  // The window moves first, then the worker fetches it: wait for a grid whose axis holds the scene hour and
  // whose frame there is filled.
  await page.waitForFunction(
    ([at, lon, lat]) => {
      const d = window.__inversa;
      const meta = d?.snapshot().meta;
      if (!d || !meta) return false;
      const t = Date.parse(at as string);
      if (t < meta.frame0UnixMs || t >= meta.frame0UnixMs + meta.frameCount * meta.stepMinutes * 60_000) return false;
      return (d.hotspotAt(at as string, "iguana", lon as number, lat as number) ?? 0) > 0;
    },
    [COLD_AT, CELL.lon, CELL.lat] as const,
    { timeout: LOAD_TIMEOUT_MS },
  );
  await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "hotspots")?.count ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(4_000); // imagery and the fly-in
  const result = await page.evaluate(
    ([at, lon, lat]) => {
      const d = window.__inversa!;
      const time = d.state("TIME") as { at: string; from: string; to: string };
      return {
        time,
        iguana: d.hotspotAt(at, "iguana", lon, lat),
        max: d.maxHotspot(at, "iguana"),
        sightings: d.sightingIds(at).length,
        layers: d.globe()?.layers ?? [],
        live: document.querySelector("[data-testid=hud-live]")?.textContent ?? "",
        dateJump: document.querySelector<HTMLInputElement>("[data-hud-date-jump]")?.value ?? "",
      };
    },
    [COLD_AT, CELL.lon, CELL.lat] as [string, number, number],
  );
  if (shot) {
    mkdirSync(path.dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
    log(`screenshot → ${path.relative(REPO_DIR, SHOT)}`);
  }
  await context.close();
  return result;
}

async function main() {
  const shot = process.argv.includes("--shot");
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "client", scene: true });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let failed = false;
  try {
    const errors: Errors = [];
    const snap = await opsPage(browser, stack.origin, errors);
    const frames = snap.grid?.frameCount ?? 0;
    const workers = snap.transport === "sab" && snap.leader === "leader" && snap.grid?.shared === true;
    log(`grid ${frames} frames (v${snap.grid?.version}), ${snap.sightings} sightings, transport ${snap.transport}, leader ${snap.leader}, shared ${snap.grid?.shared}`);
    log(`layers: ${(snap.layers ?? []).map((l) => `${l.id}=${l.count}${l.error ? `(!${l.error})` : ""}`).join(" ")}`);
    const opsErrors = errors.splice(0);
    console.log(`CLIENT isolated=${snap.isolated} ${frames > 0 && workers ? "frames>0" : `frames=${frames} workers=${workers}`} errors=${opsErrors.length}`);
    if (opsErrors.length) log("errors:", opsErrors);
    if (!snap.isolated || frames === 0 || !workers || opsErrors.length > 0) failed = true;

    const cold = await coldSnap(browser, stack.origin, errors, shot);
    const inWindow = Date.parse(cold.time.from) <= Date.parse(COLD_AT) && Date.parse(COLD_AT) <= Date.parse(cold.time.to);
    const layerCount = (id: string) => cold.layers.find((l) => l.id === id)?.count ?? 0;
    console.log(
      `COLDSNAP at=${cold.time.at} window=${cold.time.from}..${cold.time.to} iguana=${cold.iguana?.toFixed(2)} max=${cold.max?.toFixed(2)} sightings=${cold.sightings} globe_sightings=${layerCount("sightings")} globe_hotspots=${layerCount("hotspots")} badge=${cold.live.trim()} date=${cold.dateJump} errors=${errors.length}`,
    );
    if (errors.length) log("errors:", errors);
    if (cold.time.at !== COLD_AT || !inWindow || !((cold.iguana ?? 0) >= 1) || cold.sightings === 0 || layerCount("sightings") === 0 || layerCount("hotspots") === 0) failed = true;
    if (!/REPLAY/.test(cold.live) || cold.dateJump !== "2026-02-01" || errors.length > 0) failed = true;
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
