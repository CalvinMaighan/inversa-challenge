/**
 * Timeline replay per app (rubric `timeline-replay/replay`) on the real stack (e2e/stack.ts: Axum over the app's
 * fixture backfill, the production e2e build, the signal Worker and the Caddy-like proxy). Driven through the UI
 * and the URL; `window.__inversa` and data attributes are only read.
 *
 *   bun run e2e:replay -- --app <id>    build, run, print the REPLAY line
 *   E2E_SKIP_BUILD=1 …                   reuse the last e2e build
 *
 * play   the play button replays forward: the time cursor advances while what the app draws follows it (every
 *        animation frame is sampled), and a second press pauses (the cursor holds for 600 ms);
 * step   one ArrowLeft on the focused scrubber moves the cursor back one step into the past (replay/as-of mode);
 * asof   a past time shows the data known then, not now:
 *          python    the sightings layer at a past cursor draws exactly the distinct sightings Axum holds for that
 *                    window (`speciesCounts`), and that differs from what it draws at the live edge;
 *          carp      "what we knew": a past as-of by link swaps the forecast to the issuance in force then (the IEM
 *                    archive copy, issued before the as-of) and the review board recomputes its statuses as of then;
 *          lionfish  known-at priority: the "Known at" label, a priority snapshot from the same day or before, and
 *                    the report count and ranked places as submitted by then (they differ from live);
 * frames distinct frames drawn during play (python: the globe's sightings-layer frame; lionfish: the overlay's
 *        as-of; carp: the stage chart's cursor);
 * errors page errors and console errors over the whole run.
 *
 * Line: `REPLAY app=<id> play=ok step=ok asof=ok frames=<n> errors=<n>`. Exit 0 only when all three are ok, frames
 * >= 24 and errors = 0.
 */
import { chromium, type Browser, type Page } from "playwright";

import { appBBox, getApp, type AppId } from "../shared/apps";
import { appArg } from "./args";
import { buildApi, buildWeb, startStack, type Stack } from "./stack";

const APP: AppId = appArg();
const CONFIG = getApp(APP);
const LOAD_TIMEOUT_MS = 120_000;
const DAY = 86_400_000;
/** python: the newest Burmese python in the fixtures is 2026-09-14, so its 7-day window has data the day after. */
const PYTHON_CLOCK = Date.parse("2026-09-15T21:00:00Z");
/** lionfish: the fixtures' live view (e2e/lionfish.ts). */
const LIONFISH_CLOCK = Date.parse("2026-10-01T09:00:00Z");
/** carp: a past as-of inside the fixtures' forecast archive (e2e/carp.ts). */
const CARP_PAST_ASOF = "2026-09-28T18:00Z";
const PLAY_MS = 5_000;

const log = (...a: unknown[]) => console.error(`[e2e:replay ${APP}]`, ...a);
const check = (ok: boolean, what: string) => (ok ? "ok" : (log(`FAIL ${what}`), "fail"));

type Result = { play: string; step: string; asof: string; frames: number };

type Probe = "python" | "lionfish" | "carp";

/**
 * Sample what the app draws every animation frame for `ms`; returns the values seen, in order. python:
 * `<TIME.at ms>:<globe sightings frame>:<cursor frame>`; lionfish: the overlay's as-of; carp: the chart's cursor.
 */
async function sample(page: Page, probe: Probe, ms: number): Promise<string[]> {
  return page.evaluate(
    ({ probe, ms }) =>
      new Promise<string[]>((resolve) => {
        const read = (): string => {
          if (probe === "python") {
            const d = window.__inversa!;
            const t = d.state("TIME") as { at?: string; to: string };
            const layer = d.globe()?.layers.find((l) => l.id === "sightings");
            return `${Date.parse(t.at ?? t.to)}:${layer?.frame ?? -1}:${d.snapshot().frame ?? -1}`;
          }
          if (probe === "lionfish") return document.querySelector('[data-testid="lionfish-overlay"]')?.getAttribute("data-asof") ?? "";
          return document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')?.dataset.cursor ?? "";
        };
        const out: string[] = [];
        const t0 = performance.now();
        const tick = () => {
          out.push(String(read()));
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    { probe, ms },
  );
}

const distinct = (xs: string[]) => new Set(xs).size;
const nondecreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

async function setSpeed(page: Page, speed: number): Promise<void> {
  await page.selectOption('select[aria-label^="Playback speed"]', String(speed));
}

// ---- python: the shared timeline over the EVF frame grid ------------------------------------------------

const timeAt = (page: Page) =>
  page.evaluate(() => {
    const t = window.__inversa!.state("TIME") as { at?: string; to: string };
    return Date.parse(t.at ?? t.to);
  });

async function pythonReady(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/?app=python`, { waitUntil: "load" });
  await page.locator("[data-chat-column]").waitFor({ timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && (window.__inversa?.globe()?.layers.length ?? 0) > 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.frame ?? -1) >= 0, undefined, { timeout: LOAD_TIMEOUT_MS });
  await page.waitForTimeout(3_000);
}

type Layer = { id: string; enabled: boolean; count: number; frame: number };
const sightingsLayer = (page: Page) => page.evaluate(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings") ?? null) as Layer | null);

/** Distinct sightings of the app's species Axum holds for the trailing window of frames ending at `frame`. */
async function apiWindowCount(page: Page, stack: Stack, frame: number): Promise<number> {
  const meta = await page.evaluate(() => window.__inversa!.snapshot().meta);
  if (!meta) throw new Error("no frame meta");
  const step = meta.stepMinutes * 60_000;
  const frames = Math.ceil((CONFIG.windows.defaultHours * 3_600_000) / step);
  const first = Math.max(0, frame - frames + 1);
  const { speciesCounts } = await stack.graphql<{ speciesCounts: { count: number }[] }>(
    "query($bbox: BBox!, $from: Time!, $to: Time!) { speciesCounts(bbox: $bbox, from: $from, to: $to) { count } }",
    { bbox: appBBox(CONFIG), from: new Date(meta.frame0UnixMs + first * step).toISOString(), to: new Date(meta.frame0UnixMs + (frame + 1) * step - 1).toISOString() },
  );
  return speciesCounts.reduce((n, r) => n + r.count, 0);
}

async function scrubTo(page: Page, step: number): Promise<void> {
  await page.evaluate((s) => {
    const r = document.querySelector<HTMLInputElement>("[data-hud-scrubber]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(s));
    r.dispatchEvent(new Event("input", { bubbles: true }));
  }, step);
}

async function python(page: Page, stack: Stack): Promise<Result> {
  await pythonReady(page, stack.origin);
  const live = (await sightingsLayer(page)) ?? { id: "", enabled: false, count: -1, frame: -1 };
  log(`live: sightings layer frame ${live.frame}, ${live.count} drawn`);

  // Play: TIME advances and the globe's sightings frame follows; pause holds. 32 steps/s is 8 one-hour frames a
  // second (TIME steps 15 min), each still on screen for several display frames.
  await setSpeed(page, 32);
  await page.click('[data-testid="hud-play"]');
  // The cursor, the frame the globe drew and the cursor's frame, sampled together every animation frame.
  const samples = (await sample(page, "python", PLAY_MS)).map((s) => s.split(":").map(Number) as [number, number, number]);
  await page.click('[data-testid="hud-play"]');
  await page.waitForTimeout(300);
  const held0 = await timeAt(page);
  await page.waitForTimeout(600);
  const held1 = await timeAt(page);
  const atSamples = samples.map((s) => s[0]);
  const drawn = samples.map((s) => s[1]).filter((f) => f >= 0);
  // A drawn frame is never ahead of the cursor, and at most one frame behind it (the next render catches up).
  const lagging = samples.filter(([, d, t]) => d > t || t - d > 1).length;
  const frames = distinct(drawn.map(String));
  const advanced = (atSamples.at(-1)! - atSamples[0]!) / 60_000;
  log(`play: cursor +${advanced} min over ${samples.length} samples, globe drew ${frames} distinct frames, ${lagging}/${samples.length} samples off the cursor's frame; paused ${held0} ${held1}`);
  const play = check(atSamples.at(-1)! > atSamples[0]! && nondecreasing(atSamples) && frames >= 2 && lagging <= samples.length / 10 && held0 === held1, "python play");

  // Step: the scrubber's ArrowLeft goes one step back.
  await page.click('[data-testid="hud-live"]');
  await page.waitForTimeout(500);
  const before = await timeAt(page);
  await page.focus("[data-hud-scrubber]");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  const after = await timeAt(page);
  const liveLabel = (await page.locator('[data-testid="hud-live"]').textContent())?.trim() ?? "";
  log(`step: ${new Date(before).toISOString()} -> ${new Date(after).toISOString()} ("${liveLabel}")`);
  const step = check(after < before && before - after <= 3_600_000 && /REPLAY/.test(liveLabel), "python step");

  // As of: a past cursor draws Axum's window for that time, which differs from the live edge's.
  const max = Number(await page.getAttribute("[data-hud-scrubber]", "max"));
  let asofOk = false;
  for (const daysBack of [3, 2, 5, 1]) {
    await scrubTo(page, max - daysBack * 96);
    await page.waitForTimeout(1_200);
    const want = await page.evaluate(() => window.__inversa!.snapshot().frame);
    const layer = await sightingsLayer(page);
    if (!layer || want === null || layer.frame !== want) {
      log(`as of ${daysBack} d back: globe frame ${layer?.frame}, cursor frame ${want}`);
      continue;
    }
    const api = await apiWindowCount(page, stack, layer.frame);
    log(`as of ${daysBack} d back: frame ${layer.frame}, drawn ${layer.count}, Axum ${api}, live ${live.count}`);
    if (layer.count === api && layer.count !== live.count) {
      asofOk = true;
      break;
    }
  }
  const liveApi = live.frame >= 0 ? await apiWindowCount(page, stack, live.frame) : -2;
  const asof = check(asofOk && liveApi === live.count, `python asof (live drawn ${live.count}, Axum ${liveApi})`);
  return { play, step, asof, frames };
}

// ---- lionfish: the shared timeline driving the survey overlay ------------------------------------------

async function lionfish(page: Page, stack: Stack): Promise<Result> {
  await page.goto(`${stack.origin}/?app=lionfish`);
  await page.locator('[data-testid="lionfish-hud"][data-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
  await page.locator('[data-testid="lionfish-hud"][data-replay-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
  if (await page.locator('[data-testid="lionfish-banner-dismiss"]').count()) await page.click('[data-testid="lionfish-banner-dismiss"]');
  const asOf = () => page.getAttribute('[data-testid="lionfish-overlay"]', "data-asof").then(Number);
  const count = () => page.getAttribute('[data-testid="lionfish-count"]', "data-count").then(Number);
  const ranked = () => page.$$eval("[data-cell-row]", (els) => els.map((e) => e.getAttribute("data-cell-row")).join(","));
  const liveAt = await asOf();
  const liveCount = await count();
  const liveRanked = await ranked();

  // Play from two days back: the overlay's as-of follows the cursor; pause holds.
  const max = Number(await page.getAttribute("[data-hud-scrubber]", "max"));
  await scrubTo(page, max - 2 * 96);
  await page.waitForTimeout(300);
  await setSpeed(page, 16);
  await page.click('[data-testid="hud-play"]');
  const seen = (await sample(page, "lionfish", PLAY_MS)).map(Number);
  await page.click('[data-testid="hud-play"]');
  await page.waitForTimeout(300);
  const p2 = await asOf();
  await page.waitForTimeout(600);
  const p3 = await asOf();
  const frames = distinct(seen.map(String));
  log(`play: overlay as-of ${new Date(seen[0]!).toISOString()} -> ${new Date(seen.at(-1)!).toISOString()}, ${frames} distinct; paused ${p2} ${p3}`);
  const play = check(seen.at(-1)! > seen[0]! && nondecreasing(seen) && p2 === p3, "lionfish play");

  // Step: back to live, then one ArrowLeft.
  await page.click('[data-testid="hud-live"]');
  await page.waitForTimeout(400);
  const at0 = await asOf();
  await page.focus("[data-hud-scrubber]");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  const at1 = await asOf();
  const stepLabel = await page.locator('[data-testid="lionfish-asof"]').innerText().catch(() => "");
  log(`step: ${at0} (live ${liveAt}) -> ${at1} "${stepLabel.split("\n")[0]}"`);
  const step = check(at1 < at0 && /Known at/.test(stepLabel), "lionfish step");

  // As of 20 days back: known-at label, that day's priority snapshot, and the reports and ranking known then.
  await scrubTo(page, max - 20 * 96);
  await page.waitForTimeout(800);
  const pastAt = await asOf();
  const label = await page.locator('[data-testid="lionfish-asof"]').innerText();
  const snapAt = Date.parse((/Priority snapshot (\d{4}-\d\d-\d\d \d\d:\d\d)Z/.exec(label)?.[1] ?? "").replace(" ", "T") + ":00Z");
  const pastCount = await count();
  const pastRanked = await ranked();
  log(`as of ${new Date(pastAt).toISOString()}: snapshot ${Number.isFinite(snapAt) ? new Date(snapAt).toISOString() : "none"}, reports ${pastCount} (live ${liveCount}), ranked ${pastRanked} (live ${liveRanked})`);
  const asof = check(
    /Known at/.test(label) && label.includes(CONFIG.copy.replayNote!) && snapAt <= pastAt && pastAt - snapAt <= DAY && (pastCount !== liveCount || pastRanked !== liveRanked),
    "lionfish asof",
  );
  return { play, step, asof, frames };
}

// ---- carp: the stage chart's "what we knew" timeline --------------------------------------------------

async function carp(page: Page, stack: Stack): Promise<Result> {
  const chart = () => page.evaluate(() => ({ ...document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')!.dataset }));
  const ready = async () => {
    await page.locator('[data-testid="app-select-button"][data-app="carp"]').waitFor({ timeout: LOAD_TIMEOUT_MS });
    await page.waitForFunction(() => document.querySelectorAll("[data-carp-row]").length > 0 && [...document.querySelectorAll("[data-carp-site]")].every((m) => m.getAttribute("data-status") !== "loading"), undefined, { timeout: LOAD_TIMEOUT_MS });
  };
  const siteLoaded = async (lid: string) => {
    await page.locator(`[data-testid="carp-drawer"][data-site="${lid}"] [data-testid="carp-changed"]`).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => /forecast:[1-9]/.test(document.querySelector<HTMLCanvasElement>('[data-testid="carp-chart"]')?.dataset.series ?? ""), undefined, { timeout: 30_000 });
  };
  const mode = () => page.getAttribute('[data-testid="carp-timeline"]', "data-mode");
  await page.goto(`${stack.origin}/?app=carp`);
  await ready();
  await page.click('[data-carp-row="KRZL1"]');
  await siteLoaded("KRZL1");
  const liveIssued = await page.locator('[data-testid="carp-issued"]').innerText();
  const liveRows = await page.$$eval("[data-carp-row]", (els) => els.map((el) => `${el.getAttribute("data-carp-row")}:${el.getAttribute("data-status")}:${(el as HTMLElement).innerText}`).join("|"));
  const liveCursor = Number((await chart()).cursor);

  // Play replays forward from 48 h back, an hour per tick; pause holds.
  await page.click('[data-testid="carp-play"]');
  const cursors = (await sample(page, "carp", 4_000)).map(Number);
  await page.click('[data-testid="carp-play"]');
  await page.waitForTimeout(400);
  const c2 = Number((await chart()).cursor);
  await page.waitForTimeout(600);
  const c3 = Number((await chart()).cursor);
  const frames = distinct(cursors.map(String));
  log(`play: cursor ${new Date(cursors[0]!).toISOString()} -> ${new Date(cursors.at(-1)!).toISOString()} (${(cursors.at(-1)! - cursors[0]!) / 3_600_000} h), ${frames} distinct; paused ${c2} ${c3}`);
  const play = check(cursors.at(-1)! - cursors[0]! >= 12 * 3_600_000 && nondecreasing(cursors) && c2 === c3 && c2 < liveCursor, "carp play");

  // Step: live, then ArrowLeft on the scrubber.
  await page.click('[data-testid="carp-live"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="carp-timeline"]')?.getAttribute("data-mode") === "live");
  const s0 = Number((await chart()).cursor);
  await page.focus("[data-carp-scrubber]");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  const s1 = Number((await chart()).cursor);
  const stepMode = await mode();
  log(`step: ${new Date(s0).toISOString()} -> ${new Date(s1).toISOString()} mode=${stepMode}`);
  const step = check(s1 < s0 && stepMode === "asof", "carp step");
  await page.click('[data-testid="carp-live"]');

  // What we knew: a past as-of by link swaps the forecast to the archived issuance in force then; the board follows.
  await page.goto(`${stack.origin}/?app=carp#v=2&app=carp&site=KRZL1&asof=${CARP_PAST_ASOF}`);
  await ready();
  await siteLoaded("KRZL1");
  const asofMs = Date.parse(CARP_PAST_ASOF.replace("Z", ":00Z"));
  await page.waitForFunction((t) => document.querySelector('[data-testid="carp-board"]')?.getAttribute("data-reviewed-at") === String(t), asofMs, { timeout: 30_000 });
  const pastIssued = await page.locator('[data-testid="carp-issued"]').innerText();
  const pastSource = await page.getAttribute('[data-testid="carp-forecast-source"]', "data-source");
  const issuedText = await page.evaluate(() => document.querySelector('[data-testid="carp-forecast-issued"]')?.textContent ?? "");
  const issuedUtc = /\((\d{4}-\d\d-\d\d \d\d:\d\d)Z\)/.exec(issuedText)?.[1];
  const issuedBefore = issuedUtc ? Date.parse(`${issuedUtc.replace(" ", "T")}:00Z`) <= asofMs : false;
  const pastRows = await page.$$eval("[data-carp-row]", (els) => els.map((el) => `${el.getAttribute("data-carp-row")}:${el.getAttribute("data-status")}:${(el as HTMLElement).innerText}`).join("|"));
  const pastCursor = Number((await chart()).cursor);
  log(`as of ${CARP_PAST_ASOF}: forecast ${pastIssued} (${pastSource}, issued ${issuedUtc}Z) vs live ${liveIssued}; board ${pastRows === liveRows ? "same as" : "differs from"} live; cursor ${pastCursor}`);
  const asof = check(pastIssued !== liveIssued && pastSource === "IEM_ARCHIVE" && issuedBefore && pastRows !== liveRows && pastCursor === asofMs && (await mode()) === "asof", "carp asof");
  return { play, step, asof, frames };
}

async function main(): Promise<void> {
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: `replay-${APP}`, app: APP, apps: [APP] });
  const browser: Browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    if (APP === "python") await context.clock.install({ time: PYTHON_CLOCK });
    const page = await context.newPage();
    if (APP === "lionfish") await page.clock.setFixedTime(LIONFISH_CLOCK);
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    const r = APP === "python" ? await python(page, stack) : APP === "lionfish" ? await lionfish(page, stack) : await carp(page, stack);
    await context.close();
    if (errors.length) log(`errors:\n  ${errors.slice(0, 10).join("\n  ")}`);
    console.log(`REPLAY app=${APP} play=${r.play} step=${r.step} asof=${r.asof} frames=${r.frames} errors=${errors.length}`);
    if (r.play !== "ok" || r.step !== "ok" || r.asof !== "ok" || r.frames < 24 || errors.length) process.exitCode = 1;
  } catch (err) {
    log(`failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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
