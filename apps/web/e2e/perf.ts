/**
 * Performance pass (gates/leaf-T28.md, docs/perf.md) on the shared real stack (e2e/stack.ts): Axum over the
 * fixture backfill, `next start`, the signal Worker and the front proxy, on free ports.
 *
 *   bun run e2e:perf             build, run, print the PERF lines; the Next server alone gets the model key,
 *                                through `doppler run --project inversa --config dev`
 *   E2E_SKIP_BUILD=1 …           reuse the last e2e build
 *
 * 1. Cold page load, COLD_RUNS times, each in a fresh browser (empty HTTP cache, no OPFS, no service state):
 *    TTFB, DOMContentLoaded and load from Navigation Timing; then the app's own marks from `window.__inversa`
 *    (client/debug.ts): `hydrated` (React has mounted the shell and its effects run: the HUD takes input),
 *    `globeFirstFrame` (Cesium's first rendered frame), `gridReady` (the db worker published the 30-day frame
 *    grid), and `dataDrawn` (the sightings layer, on by default since T41, has drawn a frame of that grid). Medians are printed.
 * 2. First agent token, over AGENT_QUESTIONS live questions to the real agent (GPT-6 Luna on OpenRouter) through
 *    `POST /api/agent/stream` at the page origin, as the chat card sends them. Per question: the first NDJSON
 *    line (status), the first output the model streams (a reasoning or answer delta, or a tool call), and the
 *    first answer text (content_delta). p50 of each is printed.
 *
 * Lines: `PERF cold …` and `PERF agent …`.
 *
 * `--app <id>` (gates/leaf-AG1.md G6, rubric `query-speed`): the per-app agent pass only, with the answer cache
 * cold then warm, on `next dev` over the fixture GraphQL stub (no Axum or production build): that app's golden
 * questions through `POST /api/agent/stream`, first model output per question, then the first question again
 * served from the answer cache. Line: `PERF app=<id> first_token_p50_ms=<n> n=<n> cached_query_ms=<n>`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GOLDEN_SETS } from "../eval/golden";
import { fixtureNow, startStub } from "../eval/stub-server";
import { appBBox, getApp, isAppId, type AppId } from "../shared/apps";
import { chromium, type Browser } from "playwright";

import type { AgentStreamEvent } from "../shared/agent/events";
import { buildApi, buildWeb, startStack, type Stack } from "./stack";

const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];
const COLD_RUNS = Number(process.env.COLD_RUNS ?? 5);
const LOAD_TIMEOUT_MS = 120_000;
const AGENT_QUESTIONS = [
  "Which data feeds are stale or down right now?",
  "Show me recent iguana sightings near Homestead.",
  "What are water levels like at Shark River Slough?",
  "Any NWS alerts in effect for the Keys right now?",
  "Where should python crews go tonight?",
];
const HOMESTEAD = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };

const log = (...a: unknown[]) => console.error("[e2e:perf]", ...a);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const ms = (v: number) => Math.round(v);

type Cold = { ttfb: number; dcl: number; load: number; hydrated: number; cesiumFetched: number; globeFirstFrame: number; gridReady: number; dataDrawn: number };

/** A fresh context per run: its own empty HTTP cache, storage and OPFS, as a first visit has. */
async function coldLoad(stack: Stack, browser: Browser): Promise<Cold> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
    await page.goto(`${stack.origin}/`, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
    log("cold: page loaded, waiting for the first data frame");
    // Each resolves on the first animation frame at which its condition holds: the db worker's grid has frames,
    // and the sightings layer has drawn one of them.
    const at = (predicate: () => boolean | undefined) =>
      page
        .waitForFunction(`(${predicate.toString()})() ? performance.now() : false`, undefined, { timeout: LOAD_TIMEOUT_MS, polling: "raf" })
        .then(async (h) => (await h.jsonValue()) as number);
    // The grid and sightings marks are python's (the fixture app); other apps (PERF_APP) report page and globe marks only.
    const [gridReady, dataDrawn] =
      stack.app === "python"
        ? await Promise.all([
            at(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0),
            at(() => (window.__inversa?.globe()?.layers.find((l) => l.id === "sightings")?.frame ?? -1) >= 0),
          ])
        : [-1, -1];
    await page.waitForFunction(() => {
      const m = window.__inversa?.marks();
      return m && m.globeFirstFrame !== null && m.hydrated !== null;
    }, undefined, { timeout: LOAD_TIMEOUT_MS });
    const t = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const m = window.__inversa!.marks();
      const cesium = performance.getEntriesByType("resource").find((e) => e.name.endsWith("/cesium/index.js")) as PerformanceResourceTiming | undefined;
      return {
        ttfb: nav.responseStart,
        dcl: nav.domContentLoadedEventEnd,
        load: nav.loadEventEnd,
        hydrated: m.hydrated!,
        cesiumFetched: cesium?.responseEnd ?? -1,
        globeFirstFrame: m.globeFirstFrame!,
      };
    });
    return { ...t, gridReady, dataDrawn };
  } finally {
    await context.close();
  }
}

type AgentTiming = { status: number; firstModel: number; firstText: number | null; done: number; tools: number };

async function ask(stack: Stack, question: string, i: number, app: AppId = "python"): Promise<AgentTiming> {
  const started = performance.now();
  const view = app === "python" ? { bbox: HOMESTEAD, time: new Date().toISOString(), layers: ["sightings", "notes"], selection: null } : { bbox: appBBox(getApp(app)), time: fixtureNow(app), layers: [], selection: null };
  const res = await fetch(`${stack.origin}/api/agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app,
      sessionId: `perf-${Date.now()}-${i}`,
      question,
      view,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`agent stream answered ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let status: number | null = null;
  let firstModel: number | null = null;
  let firstText: number | null = null;
  let tools = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const now = performance.now() - started;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const event = JSON.parse(line) as AgentStreamEvent;
      status ??= now;
      if (event.type === "error") throw new Error(`agent error: ${event.message}`);
      if (event.type === "reasoning_delta" || event.type === "content_delta" || event.type === "tool_start") firstModel ??= now;
      if (event.type === "content_delta") firstText ??= now;
      if (event.type === "tool_start") tools += 1;
    }
  }
  const total = performance.now() - started;
  if (status === null || firstModel === null) throw new Error(`no model output for ${JSON.stringify(question)}`);
  return { status, firstModel, firstText, done: total, tools };
}

/** `--app <id>` or `--app=<id>`; absent means the full stack pass. */
function appArg(argv: readonly string[]): AppId | null {
  const eq = argv.find((a) => a.startsWith("--app="))?.slice("--app=".length);
  const at = argv.indexOf("--app");
  const raw = eq ?? (at >= 0 ? argv[at + 1] : undefined);
  if (raw === undefined) return null;
  if (!isAppId(raw)) throw new Error(`unknown app ${raw}`);
  return raw;
}

/** Files `next dev` writes into the app dir; restored so a run leaves the tree as it found it. */
const DEV_SIDE_EFFECTS = ["next-env.d.ts", "AGENTS.md", "CLAUDE.md"].map((name) => join(import.meta.dir, "..", name));

/** First-token timing of one app's questions on `next dev` over the fixture stub, cache cold, then one cache hit. */
async function appPass(app: AppId): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY not set: run through doppler inversa/dev");
  const web = join(import.meta.dir, "..");
  const saved = new Map(DEV_SIDE_EFFECTS.map((file) => [file, existsSync(file) ? readFileSync(file) : null]));
  const stub = startStub();
  const dataDir = mkdtempSync(join(tmpdir(), "inversa-perf-"));
  const port = Number(process.env.PERF_PORT ?? 3000 + Math.floor(Math.random() * 2000));
  const origin = `http://127.0.0.1:${port}`;
  const next = spawn(join(web, "node_modules/.bin/next"), ["dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: web,
    detached: true,
    env: { ...process.env, INVERSA_API_ORIGIN: stub.origin, INVERSA_DATA_DIR: dataDir, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  next.stdout?.on("data", (chunk) => (output += String(chunk)));
  next.stderr?.on("data", (chunk) => (output += String(chunk)));
  const config = getApp(app);
  const now = fixtureNow(app);
  const view = { bbox: appBBox(config), time: now, layers: [], selection: null };
  const post = (question: string, sessionId: string) =>
    fetch(`${origin}/api/agent/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app, sessionId, question, view }) });
  const stack = { origin } as Stack;
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (next.exitCode !== null) throw new Error(`next dev exited (${next.exitCode}):\n${output.slice(-2000)}`);
      try {
        const res = await fetch(`${origin}/api/agent/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (res.status === 400) break;
      } catch {
        // Not up yet.
      }
      if (Date.now() > deadline) throw new Error(`next dev did not answer in 120 s:\n${output.slice(-2000)}`);
      await Bun.sleep(500);
    }
    // Warm the route (next dev compiles it on first use) and the harness boot with a turn the scope guard answers.
    await (await post(app === "python" ? "Where are common carp in Louisiana?" : "Where are Burmese pythons active in the Everglades?", `perf-warm-${Date.now()}`)).text();
    const golden = GOLDEN_SETS[config.eval.goldenSet] ?? [];
    const wanted = Number(process.env.PERF_QUESTIONS ?? 5);
    const questions = (golden.length ? golden.filter((g) => g.mode !== "refuse").map((g) => g.question) : AGENT_QUESTIONS).filter((q, i, all) => all.indexOf(q) === i).slice(0, wanted);
    if (questions.length < 5) throw new Error(`need at least 5 questions, have ${questions.length}`);
    const timings: AgentTiming[] = [];
    for (const [i, q] of questions.entries()) {
      const t = await ask(stack, q, i, app);
      timings.push(t);
      log(`agent ${i + 1} "${q}": status=${ms(t.status)} first_model=${ms(t.firstModel)} first_text=${t.firstText === null ? "-" : ms(t.firstText)} done=${ms(t.done)} tools=${t.tools}`);
    }
    // The same question again, from a new session: the answer cache serves it without the model.
    const started = performance.now();
    const repeat = await post(questions[0]!, `perf-cache-${Date.now()}`);
    const text = await repeat.text();
    const cachedMs = performance.now() - started;
    const hit = text.includes('"answer cache hit"');
    log(`cache repeat: ${ms(cachedMs)} ms hit=${hit}`);
    if (!hit) throw new Error("the repeated question was not served from the answer cache");
    console.log(`PERF app=${app} first_token_p50_ms=${ms(median(timings.map((t) => t.firstModel)))} n=${timings.length} cached_query_ms=${ms(cachedMs)} status_p50_ms=${ms(median(timings.map((t) => t.status)))} done_p50_ms=${ms(median(timings.map((t) => t.done)))}`);
  } finally {
    if (next.pid) {
      try {
        process.kill(-next.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    stub.stop();
    rmSync(dataDir, { recursive: true, force: true });
    for (const [file, content] of saved) {
      if (content === null) rmSync(file, { force: true });
      else writeFileSync(file, content);
    }
  }
}

async function main() {
  const app = appArg(process.argv.slice(2));
  if (app) {
    await appPass(app);
    return;
  }
  buildApi(log);
  buildWeb(log);
  // Only the Next server gets the model key, through Doppler; Axum and this script never see a secret.
  // PERF_APP=<id> runs the cold loads in that app (its fixtures, its page); default python.
  const coldApp = process.env.PERF_APP && isAppId(process.env.PERF_APP) ? process.env.PERF_APP : undefined;
  const stack = await startStack({ name: "perf", app: coldApp, nextPrefix: process.env.OPENROUTER_API_KEY ? [] : DOPPLER });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const cold: Cold[] = [];
    for (let i = 0; i < COLD_RUNS; i++) {
      const c = await Promise.race([
        coldLoad(stack, browser),
        Bun.sleep(3 * LOAD_TIMEOUT_MS).then(() => {
          throw new Error(`cold load ${i + 1} did not finish in ${(3 * LOAD_TIMEOUT_MS) / 1000}s`);
        }),
      ]);
      cold.push(c);
      log(`cold ${i + 1}: ${Object.entries(c).map(([k, v]) => `${k}=${ms(v)}`).join(" ")}`);
    }
    const med = (k: keyof Cold) => ms(median(cold.map((c) => c[k])));
    console.log(
      `PERF cold app=${stack.app} runs=${COLD_RUNS} ttfb=${med("ttfb")} dcl=${med("dcl")} load=${med("load")} hydrated=${med("hydrated")} cesium_fetched=${med("cesiumFetched")} globe_first_frame=${med("globeFirstFrame")} grid_ready=${med("gridReady")} data_drawn=${med("dataDrawn")}`,
    );
    await browser.close();
    if (process.env.PERF_ONLY === "cold") return;

    const timings: AgentTiming[] = [];
    for (const [i, q] of AGENT_QUESTIONS.entries()) {
      const t = await ask(stack, q, i);
      timings.push(t);
      log(`agent ${i + 1} "${q}": status=${ms(t.status)} first_model=${ms(t.firstModel)} first_text=${t.firstText === null ? "-" : ms(t.firstText)} done=${ms(t.done)} tools=${t.tools}`);
    }
    const texts = timings.map((t) => t.firstText).filter((v): v is number => v !== null);
    console.log(
      `PERF agent questions=${timings.length} status_p50=${ms(median(timings.map((t) => t.status)))} first_token_p50=${ms(median(timings.map((t) => t.firstModel)))} ` +
        `first_text_p50=${texts.length ? ms(median(texts)) : "-"} done_p50=${ms(median(timings.map((t) => t.done)))}`,
    );
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
    throw err;
  } finally {
    await stack.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
