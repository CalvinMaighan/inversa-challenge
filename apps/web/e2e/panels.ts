/**
 * T38 e2e: agent data panels and globe highlights, with the real LLM.
 *
 *   doppler run --project inversa --config dev -- bun run e2e:panels
 *   E2E_SKIP_BUILD=1 …   reuse the last build when it points at the same API port
 *
 * Builds `next build` (standalone) with /v1 rewritten to a local Axum, backfills Axum's fixtures into a temp
 * INVERSA_DATA_DIR (`backfill --fixtures --app python`), serves them with INVERSA_SOURCES=off, starts `next start`, and in
 * Chromium on the ops page (`/?app=python`, real globe and HUD) types a question to the agent. The browser clock sits just
 * after the fixtures were recorded, so the default 30-day TIME window holds them.
 *
 * Assertions are on what the answer shows, never on the model's wording: a table panel with rows, a series
 * panel with lines, one bracket per highlighted entity (capped at 50; station readings only when cited, T41), a
 * camera move, and a row click that opens the evidence drawer on the real Axum record. Last line:
 *
 *   PANELS table=<rows> series=<lines> brackets=<n> drawer=1
 *
 * and docs/evidence/agent-panels.png.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Page } from "playwright";

import type { AgentStreamEvent } from "../shared/agent/events";

const APP_DIR = path.resolve(import.meta.dir, "..");
const REPO_DIR = path.resolve(APP_DIR, "../..");
const SERVER = path.join(APP_DIR, ".next/standalone/apps/web/server.js");
const ROUTES = path.join(APP_DIR, ".next/standalone/apps/web/.next/routes-manifest.json");
const API_BIN = path.join(REPO_DIR, "api/target/release/inversa-api");
const SHOT = path.join(REPO_DIR, "docs/evidence/agent-panels.png");
/** The answer with its panels in the chat column, before Expand (T40 layout evidence). */
const LAYOUT_SHOT = path.join(REPO_DIR, "docs/evidence/layout-desktop.png");
const QUESTION = "Show recent iguana sightings near Homestead and the water levels";
/** The Axum fixtures were recorded 2026-09-30T20:40Z. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
/**
 * Axum's port is baked into the build's /v1 rewrite, so it stays fixed between runs (E2E_SKIP_BUILD reuses the
 * build). When another run (a parallel worktree) holds it, a free one is taken and the build redone.
 */
const API_PORT = process.env.E2E_API_PORT ? Number(process.env.E2E_API_PORT) : portIfFree(4151);
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/** The fixtures are South Florida data: the python app (PLAN.md C-A1). */
const APP = "python";
const ANSWER_TIMEOUT_MS = 240_000;
const MAX_BRACKETS = 50;
/** The HUD labels and brackets the newest this many citations (client/hud/overlay/targets MAX_CITATIONS). */
const MAX_CITATIONS = 8;

const log = (...args: unknown[]) => console.error("[e2e:panels]", ...args);

/** `port` when nothing listens on it, else a free one. */
function portIfFree(port: number): number {
  try {
    Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
    return port;
  } catch {
    return freePort();
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function build(): void {
  const baked = existsSync(ROUTES) && readFileSync(ROUTES, "utf8").includes(API_ORIGIN);
  if (process.env.E2E_SKIP_BUILD === "1" && existsSync(SERVER) && baked) return;
  log(`next build (/v1 → ${API_ORIGIN}) …`);
  const res = spawnSync("bun", ["run", "build"], { cwd: APP_DIR, env: { ...process.env, INVERSA_API_ORIGIN: API_ORIGIN }, encoding: "utf8" });
  if (res.status !== 0) fail(`build failed (${res.status}):\n${(res.stdout + res.stderr).slice(-3000)}`);
  if (!readFileSync(ROUTES, "utf8").includes(API_ORIGIN)) fail(`the build did not bake the /v1 rewrite to ${API_ORIGIN}`);
}

function backfill(dataDir: string): void {
  log(`backfill --fixtures --app ${APP} …`);
  const res = spawnSync("cargo", ["run", "-q", "--release", "--manifest-path", path.join(REPO_DIR, "api/Cargo.toml"), "--", "backfill", "--fixtures", "--app", APP], {
    cwd: REPO_DIR,
    env: { ...process.env, INVERSA_DATA_DIR: dataDir, RUST_LOG: "warn" },
    encoding: "utf8",
  });
  const out = `${res.stdout}${res.stderr}`;
  if (res.status !== 0 || !out.includes("BACKFILL-OK")) fail(`backfill failed (${res.status}):\n${out.slice(-3000)}`);
  const sightings = /inat: .*sightings=(\d+)/.exec(out)?.[1];
  log(`backfill ok (inat sightings=${sightings ?? "?"})`);
}

async function waitFor(what: string, ms: number, probe: () => Promise<boolean>, child?: ChildProcess, output?: () => string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) fail(`${what}: process exited (${child.exitCode})\n${output?.().slice(-2000) ?? ""}`);
    try {
      if (await probe()) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(300);
  }
  fail(`${what}: not ready after ${ms} ms\n${output?.().slice(-2000) ?? ""}`);
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API_ORIGIN}/v1/${APP}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!body.data) fail(`graphql: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
  return body.data;
}

function startApi(dataDir: string): { proc: ChildProcess; output: () => string } {
  let out = "";
  const proc = spawn(API_BIN, [], {
    cwd: REPO_DIR,
    env: { ...process.env, INVERSA_DATA_DIR: dataDir, INVERSA_SOURCES: "off", INVERSA_BIND: `127.0.0.1:${API_PORT}`, RUST_LOG: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (c) => (out += String(c)));
  proc.stderr?.on("data", (c) => (out += String(c)));
  return { proc, output: () => out };
}

function startNext(port: number, agentDir: string): { proc: ChildProcess; output: () => string } {
  let out = "";
  const proc = spawn("bun", [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      INVERSA_API_ORIGIN: API_ORIGIN,
      INVERSA_DATA_DIR: agentDir,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (c) => (out += String(c)));
  proc.stderr?.on("data", (c) => (out += String(c)));
  return { proc, output: () => out };
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const cameraOf = (url: string) => new URL(url).hash.match(/[#&]c=([^&]+)/)?.[1] ?? null;

/**
 * Distinct highlight ids the answer's data tools returned that the HUD brackets, capped like the HUD: ones that
 * can sit on the globe, and (T41) station readings only when the answer cites them among its newest 8 citations.
 */
function highlightOf(events: AgentStreamEvent[]): string[] {
  const cited = new Set<string>();
  const citations = events.flatMap((e) => (e.type === "citation" ? [e.id] : []));
  for (let i = citations.length - 1; i >= 0 && cited.size < MAX_CITATIONS; i--) cited.add(citations[i]!);
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== "tool_end" || !e.ok) continue;
    const hl = (e.data as { highlight?: unknown } | undefined)?.highlight;
    if (Array.isArray(hl)) for (const id of hl) if (typeof id === "string" && !/^(fetch|backtest):/.test(id)) ids.add(id);
  }
  return [...ids].slice(0, MAX_BRACKETS).filter((id) => !id.startsWith("reading:") || cited.has(id));
}

async function overlay(page: Page): Promise<{ drawn: number; highlight: number; targets: number }> {
  return page.locator('[data-testid="hud-overlay"]').evaluate((el) => ({
    drawn: Number((el as HTMLElement).dataset.brackets ?? 0),
    highlight: Number((el as HTMLElement).dataset.highlightBrackets ?? 0),
    targets: Number((el as HTMLElement).dataset.highlightTargets ?? 0),
  }));
}

async function flow(origin: string): Promise<string> {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install({ time: new Date(FIXTURE_CLOCK) });

    // Tee the agent's NDJSON stream inside the page (the UI still reads it as it streams), so the test can check
    // the server's tool_end highlight against the brackets. CDP cannot hand back a streamed body reliably.
    await page.addInitScript(() => {
      const w = window as unknown as { __agentStreams?: { text: string; done: boolean }[] };
      const original = window.fetch.bind(window);
      const teed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const res = await original(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("/api/agent/stream") || !res.body) return res;
        const [ui, copy] = res.body.tee();
        const slot = { text: "", done: false };
        (w.__agentStreams ??= []).push(slot);
        void (async () => {
          const reader = copy.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            slot.text += decoder.decode(value, { stream: true });
          }
          slot.done = true;
        })();
        return new Response(ui, { status: res.status, statusText: res.statusText, headers: res.headers });
      };
      window.fetch = Object.assign(teed, { preconnect: window.fetch.preconnect });
    });

    await page.goto(`${origin}/?app=${APP}`, { waitUntil: "load" });
    // The chat column is open from the start (T40).
    const column = page.locator("[data-chat-column]");
    await column.waitFor({ timeout: 60_000 });
    await page.locator('[data-testid="hud-overlay"]').waitFor({ state: "attached", timeout: 60_000 });
    // Let the globe settle and write its camera into the share-link hash.
    await page.waitForTimeout(4_000);
    const cameraBefore = cameraOf(page.url());
    log(`page up; camera ${cameraBefore ?? "(default)"}`);

    const input = column.getByRole("textbox", { name: "Question" });
    await input.fill(QUESTION);
    await input.press("Enter");
    log(`asked: ${QUESTION}`);

    const turn = column.locator('[data-source="text"][data-status="done"], [data-source="text"][data-status="error"]').last();
    await turn.waitFor({ timeout: ANSWER_TIMEOUT_MS });
    if ((await turn.getAttribute("data-status")) === "error") fail(`the answer failed: ${(await turn.textContent())?.slice(0, 400)}`);
    const streamed = await page
      .waitForFunction(() => {
        const slot = (window as unknown as { __agentStreams?: { text: string; done: boolean }[] }).__agentStreams?.at(-1);
        return slot?.done ? slot.text : null;
      }, undefined, { timeout: 15_000 })
      .then((handle) => handle.jsonValue() as Promise<string>)
      .catch(() => fail("no /api/agent/stream body was captured"));
    const events = streamed
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AgentStreamEvent);
    const tools = events.flatMap((e) => (e.type === "tool_start" ? [e.capabilityName] : []));
    const expected = highlightOf(events);
    log(`answer done; tools: ${tools.join(", ")}; highlight ${expected.length}`);
    for (const e of events) if (e.type === "tool_start") log(`  ${e.capabilityName} ${JSON.stringify(e.args).slice(0, 240)}`);
    if (expected.length === 0) fail("the answer's tools returned nothing to highlight");

    // The column shows the turn's panels under the answer.
    await turn.locator("[data-panels]").waitFor({ timeout: 10_000 });

    // Globe: the camera framed the answer, and every highlighted entity is bracketed.
    await page.waitForFunction((before) => {
      const c = location.hash.match(/[#&]c=([^&]+)/)?.[1] ?? null;
      return c !== null && c !== before;
    }, cameraBefore, { timeout: 30_000 });
    const cameraAfter = cameraOf(page.url());
    log(`camera ${cameraBefore ?? "(default)"} → ${cameraAfter}`);
    await page
      .waitForFunction(
        (want) => Number((document.querySelector('[data-testid="hud-overlay"]') as HTMLElement | null)?.dataset.highlightBrackets ?? -1) === want,
        expected.length,
        { timeout: 45_000 },
      )
      .catch(async () => fail(`brackets ${JSON.stringify(await overlay(page))}, want ${expected.length} highlight brackets`));
    const brackets = await overlay(page);
    log(`brackets drawn=${brackets.drawn} highlight=${brackets.highlight} targets=${brackets.targets}`);

    // The answer and its panels in the column, the globe framed and bracketed beside it (T40 layout evidence).
    await page.waitForTimeout(1_500);
    mkdirSync(path.dirname(LAYOUT_SHOT), { recursive: true });
    await page.screenshot({ path: LAYOUT_SHOT });
    log(`screenshot ${path.relative(REPO_DIR, LAYOUT_SHOT)}`);

    // Expand: every panel of the answer, over the globe pane next to the column.
    await turn.locator("[data-expand-panels]").click();
    const expanded = page.locator("[data-expanded-panels]");
    await expanded.waitFor();
    // Let the pop-out finish its entrance and the globe finish drawing before measuring and the screenshot.
    await page.waitForTimeout(800);
    const box = (await expanded.boundingBox())!;
    const columnBox = (await column.boundingBox())!;
    const globeBox = (await page.locator("[data-globe]").boundingBox())!;
    if (box.x < columnBox.x + columnBox.width) fail(`expanded panel ${JSON.stringify(box)} overlaps the chat column ${JSON.stringify(columnBox)}`);
    if (box.x > globeBox.x + globeBox.width / 2) fail(`expanded panel ${JSON.stringify(box)} is not over the left part of the globe pane ${JSON.stringify(globeBox)}`);
    const cx = globeBox.x + globeBox.width / 2;
    const cy = globeBox.y + globeBox.height / 2;
    if (box.x <= cx && box.x + box.width >= cx && box.y <= cy && box.y + box.height >= cy) fail("expanded panel covers the globe centre");

    const tables = await expanded.locator("[data-panel='table']").evaluateAll((els) =>
      els.map((el) => ({ tool: el.getAttribute("data-panel-tool"), rows: Number(el.querySelector("table")?.getAttribute("data-table-rows") ?? 0) })),
    );
    const sightingsTable = tables.find((t) => t.tool === "sightings" && t.rows > 0);
    const table = sightingsTable ?? tables.sort((a, b) => b.rows - a.rows)[0];
    if (!table || table.rows < 1) fail(`no table panel with rows (${JSON.stringify(tables)})`);
    const series = Math.max(0, ...(await expanded.locator("svg[data-series-lines]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-series-lines"))))));
    if (series < 1) fail("no series panel with a line");
    log(`tables ${JSON.stringify(tables)}; series lines ${series}`);

    mkdirSync(path.dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
    log(`screenshot ${path.relative(REPO_DIR, SHOT)}`);

    // A row click opens the evidence drawer on the real record.
    const row = expanded.locator(`[data-panel-tool='${table.tool}'] tbody tr`).first();
    const id = (await row.getAttribute("data-evidence-id")) ?? fail("row without an evidence id");
    await row.click();
    await page.waitForFunction((want) => document.querySelector('[data-testid="hud-drawer-id"]')?.textContent?.trim() === want, id, { timeout: 15_000 });
    const record = (await gql<{ evidence: { record: { observedAt?: string } } }>("query($id: ID!) { evidence(id: $id) { record } }", { id })).evidence.record;
    const observedAt = record.observedAt ?? fail(`${id} has no observedAt in Axum`);
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="hud-drawer"]')?.textContent?.includes(want) ?? false,
      observedAt,
      { timeout: 15_000 },
    ).catch(() => fail(`drawer for ${id} never showed the record's observedAt ${observedAt}`));
    if (await page.locator('[data-testid="hud-drawer"] [role="alert"]').count()) fail("the drawer shows a load error");
    if (!(await column.isVisible())) fail("the chat column hid when the row was clicked");
    log(`row ${id} → drawer with the Axum record (observedAt ${observedAt})`);

    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    return `PANELS table=${table.rows} series=${series} brackets=${brackets.highlight} drawer=1`;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) fail("OPENROUTER_API_KEY is not set: run under `doppler run --project inversa --config dev --`");
  build();
  const dataDir = mkdtempSync(path.join(tmpdir(), "inversa-e2e-panels-api-"));
  const agentDir = mkdtempSync(path.join(tmpdir(), "inversa-e2e-panels-agent-"));
  let api: ReturnType<typeof startApi> | null = null;
  let next: ReturnType<typeof startNext> | null = null;
  try {
    backfill(dataDir);
    api = startApi(dataDir);
    await waitFor("axum", 30_000, async () => (await gql<{ feeds: unknown[] }>("{ feeds { source } }")).feeds.length > 0, api.proc, api.output);
    const port = freePort();
    next = startNext(port, agentDir);
    const origin = `http://127.0.0.1:${port}`;
    await waitFor("next start", 60_000, async () => (await fetch(origin)).ok, next.proc, next.output);
    log(`axum ${API_ORIGIN}, next ${origin}`);
    const line = await flow(origin);
    console.log(line);
  } finally {
    next?.proc.kill("SIGTERM");
    api?.proc.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`[e2e:panels] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
