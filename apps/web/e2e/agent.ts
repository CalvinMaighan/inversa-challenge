/**
 * T14/T40 e2e: the chat column against the real agent (GPT-6 Luna on OpenRouter).
 *
 *   bun run e2e:agent      (wraps `doppler run --project inversa --config dev`, which supplies OPENROUTER_API_KEY)
 *   bun run e2e:agent -- --app carp   the carp question, tools and citations, plus the as-of/replay view check
 *
 * Starts the eval's fixture GraphQL stub and `next dev` pointed at it, then in Chromium: the chat column is
 * visible at load (full height, left), ask, see the tool rows, click a citation and check SELECTION (evidence id
 * + drawerOpen), switch to Missions and back without losing the thread. Then at 375 px the column is a bottom
 * sheet; it opens to full height inside the viewport for G3 (docs/evidence/t14-card-375.png). Last line: FLOW-OK.
 * The answer's wording is the model's; the checks are on tools, citations and UI state, not on text.
 * Last lines: `AGENT app=<id> flow=ok tools=<n> citation=ok[ view=ok]` (the grader's line) and FLOW-OK.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { fixtureNow, startStub } from "../eval/stub-server";
import type { AgentStreamEvent } from "../shared/agent/events";
import { appBBox, getApp, isAppId, type AppId } from "../shared/apps";

const WEB = resolve(import.meta.dir, "..");
/** `--app <id>` or `--app=<id>`; python by default (the T14 flow). */
function appArg(argv: readonly string[]): AppId {
  const eq = argv.find((a) => a.startsWith("--app="))?.slice("--app=".length);
  const at = argv.indexOf("--app");
  const raw = eq ?? (at >= 0 ? argv[at + 1] : undefined) ?? "python";
  if (!isAppId(raw)) throw new Error(`unknown app ${raw}`);
  return raw;
}
const APP = appArg(process.argv.slice(2));
const FIXTURE_NOW = fixtureNow(APP);
const SCREENSHOT = resolve(WEB, `../../docs/evidence/${APP === "python" ? "t14-card-375" : `agent-${APP}-375`}.png`);
/** Per app: the question, the tools any correct answer needs (set_view is checked by the fly count), and the citation kinds a chip may carry. */
const FLOWS: Record<AppId, { question: string; tools: string[]; citationKinds: string[] }> = {
  // Python answers for Burmese python only (AG2): a lionfish question is refused by the scope guard, so the flow asks about pythons.
  python: { question: "Show me recent python sightings around Shark Valley.", tools: ["geocode", "sightings"], citationKinds: ["sighting"] },
  carp: { question: "Which locations need operational review today?", tools: ["site_status"], citationKinds: ["forecast", "reading", "alert", "fetch"] },
  lionfish: { question: "Show lionfish reports in the Mexican Caribbean from the last 30 days.", tools: ["geocode", "sightings"], citationKinds: ["sighting"] },
};
/** The lionfish view question (AG2 G7): the view event must frame an area, switch a layer on and carry a knowledge time. */
const LIONFISH_VIEW_QUESTION = "Show me Belize with the reef heat stress layer on, as it was on September 1.";
const QUESTION = FLOWS[APP].question;
const EXPECTED_TOOLS = FLOWS[APP].tools;
const CITATION_KINDS = FLOWS[APP].citationKinds;
/** The carp replay question (G7): the view event must carry a knowledge time and the replay flag. */
const REPLAY_QUESTION = "Show me what we knew yesterday afternoon.";
const BOOT_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 90_000;

/** Files `next dev` writes into the app dir; restored so a run leaves the tree as it found it. */
const DEV_SIDE_EFFECTS = ["next-env.d.ts", "AGENTS.md", "CLAUDE.md"].map((name) => join(WEB, name));

function log(line: string): void {
  console.log(`[e2e:agent] ${line}`);
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? ok(address.port) : fail(new Error("no port"))));
    });
  });
}

async function waitForHttp(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next dev exited (${child.exitCode}):\n${output().slice(-2000)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status < 500) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(`next dev did not answer ${url} in ${BOOT_TIMEOUT_MS / 1000}s:\n${output().slice(-2000)}`);
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    // Bundled Chromium not downloaded for this Playwright version: use the installed Chrome.
    log(`bundled chromium unavailable (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); trying channel chrome`);
    return chromium.launch({ channel: "chrome" });
  }
}

async function probe(page: Page, attr: string): Promise<string | null> {
  return page.locator("[data-dev-probe]").getAttribute(attr);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Tool rows and citation chips of the flow, for the AGENT line. */
const found = { tools: 0, citation: false, view: false };

async function flow(origin: string, browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${origin}/dev/agent?app=${APP}&at=${encodeURIComponent(FIXTURE_NOW)}`, { waitUntil: "networkidle" });
  const column = page.locator("[data-chat-column]");
  await column.waitFor();
  // Hydrated once the dev probe reflects the ?at window.
  const day = FIXTURE_NOW.slice(0, 10);
  await page.waitForFunction((d) => document.querySelector("[data-dev-probe]")?.getAttribute("data-time-at")?.startsWith(d), day);

  // 1. The chat column is visible at load: left edge, full height, about 420 px, with the mic in the composer.
  const box = await column.boundingBox();
  assert(box && box.x === 0 && box.y === 0 && Math.abs(box.height - 800) <= 1 && box.width >= 360 && box.width <= 560, `column at ${JSON.stringify(box)}, want x=0 full height 360-560 wide`);
  assert(await column.getAttribute("data-layout") === "column", "column layout expected at 1280 px");
  await column.getByRole("button", { name: "Start voice" }).waitFor();
  log(`chat column at ${box.x},${box.y} ${box.width}x${box.height}`);

  // 2. Ask.
  const input = column.getByRole("textbox", { name: "Question" });
  await input.fill(QUESTION);
  await input.press("Enter");
  await column.getByText(QUESTION).waitFor();
  const answer = column.locator('[data-source="text"][data-status="done"]').last();
  await answer.waitFor({ timeout: STEP_TIMEOUT_MS });

  // 3. Tool rows: folded under "Worked for", expanded on click.
  const toggle = answer.locator("[data-timeline-toggle]");
  const workedFor = (await toggle.textContent()) ?? "";
  assert(/^Worked for \d+s$/.test(workedFor), `timeline label "${workedFor}"`);
  await toggle.click();
  const rows = await answer.locator("[data-tool-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-tool-row")));
  for (const tool of EXPECTED_TOOLS) assert(rows.includes(tool), `no ${tool} tool row (rows: ${rows.join(", ")})`);
  found.tools = rows.length;
  log(`tool rows: ${rows.join(", ")} (${workedFor})`);

  // The view event flew the globe and moved the timeline.
  assert(Number(await probe(page, "data-fly-count")) >= 1, "view event did not call getGlobe().flyTo");

  // 4. Citations: inline chips for verified ids only.
  const chips = answer.locator(".agent-cite");
  const chipIds = await chips.evaluateAll((els) => els.map((el) => el.getAttribute("data-evidence-id")));
  assert(chipIds.length >= 1, `expected at least 1 citation chip, got ${chipIds.length}`);
  assert(chipIds.some((id) => CITATION_KINDS.some((kind) => id?.startsWith(`${kind}:`))), `no ${CITATION_KINDS.join("/")} citation among chips: ${chipIds.join(", ")}`);
  found.citation = true;
  log(`citation chips: ${chipIds.join(", ")}`);
  const bodyText = (await answer.textContent()) ?? "";
  assert(!bodyText.includes("[e:"), "raw [e:…] marker leaked into the answer text");
  const firstId = chipIds[0]!;
  await chips.first().click();
  await page.waitForFunction((id) => document.querySelector("[data-dev-probe]")?.getAttribute("data-evidence-id") === id, firstId);
  assert((await probe(page, "data-drawer-open")) === "true", "citation click did not set SELECTION.drawerOpen");
  assert(await column.isVisible(), "the chat column hid when a citation was clicked");
  log(`citation ${firstId} selected, drawer open, column still open`);

  // 5. Tabs: Missions and back; the thread is still there, scrolled to the answer.
  await column.locator('[data-tab="board"]').click();
  await column.locator('[data-tabpanel="board"]').waitFor();
  assert(!(await column.locator('[data-tabpanel="agent"]').isVisible()), "Agent panel still visible on the Missions tab");
  await column.locator('[data-tab="agent"]').click();
  await answer.waitFor();
  assert(await answer.isVisible(), "the answer is gone after switching tabs");
  log("Missions tab and back; thread kept");

  // 6. G3: 375 px viewport, the column becomes a bottom sheet: collapsed to the composer, then full height.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-layout") === "sheet");
  const collapsed = await column.boundingBox();
  assert(collapsed && collapsed.y + collapsed.height <= 812 && collapsed.height < 120, `collapsed sheet ${JSON.stringify(collapsed)}`);
  await column.getByRole("textbox", { name: "Question" }).waitFor();
  const handle = column.locator("[data-sheet-handle]");
  await handle.click();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "half");
  await handle.click();
  await page.waitForFunction(() => document.querySelector("[data-chat-column]")?.getAttribute("data-sheet") === "full");
  await page.waitForTimeout(400);
  const sheet = await column.boundingBox();
  assert(sheet, "no sheet at 375 px");
  const inside = sheet.x >= 0 && sheet.y >= 0 && sheet.x + sheet.width <= 375 && sheet.y + sheet.height <= 812;
  assert(inside && sheet.width === 375, `sheet at 375 px leaves the viewport: ${JSON.stringify(sheet)}`);
  await column.locator("[data-timeline-toggle]").last().click();
  // The Next.js dev badge sits in the bottom-left corner over the composer; it is not part of the app.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  mkdirSync(dirname(SCREENSHOT), { recursive: true });
  await page.screenshot({ path: SCREENSHOT });
  log(`375 px sheet ${sheet.width}x${sheet.height} at ${sheet.x},${sheet.y}; screenshot ${SCREENSHOT}`);

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  await context.close();
}

/**
 * G7 (carp): "show me what we knew yesterday afternoon" drives the map and timeline: the stream carries a `view`
 * event with a knowledge time (`asOf`) in the fixture's past and the replay flag, from set_view.
 */
async function replayView(origin: string): Promise<void> {
  const app = getApp(APP);
  const res = await fetch(`${origin}/api/agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: APP, sessionId: `e2e-replay-${Date.now()}`, question: REPLAY_QUESTION, view: { bbox: appBBox(app), time: FIXTURE_NOW, layers: [], selection: null } }),
  });
  assert(res.ok, `agent stream answered ${res.status}`);
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AgentStreamEvent);
  const views = events.filter((e): e is Extract<AgentStreamEvent, { type: "view" }> => e.type === "view");
  const now = Date.parse(FIXTURE_NOW);
  const replay = views.find((v) => typeof v.asOf === "number" && v.asOf < now && v.asOf > now - 3 * 24 * 3_600_000 && v.replay === true);
  assert(replay, `no replay view event with a knowledge time in the last 3 days (views: ${JSON.stringify(views)})`);
  const tools = events.filter((e) => e.type === "tool_start").map((e) => (e as { capabilityName: string }).capabilityName);
  assert(tools.includes("set_view"), `set_view not called (tools: ${tools.join(", ")})`);
  const done = events.at(-1);
  assert(done?.type === "done" && done.content.length > 0, "no answer");
  found.view = true;
  log(`replay view: asOf=${new Date(replay.asOf!).toISOString()} replay=${replay.replay} site=${replay.site ?? "-"} tools=${tools.join(",")}`);
}

/**
 * G7 (lionfish): "show me Belize with the heat layer as of September 1" drives the map: the stream carries a `view`
 * event with the area preset, the heat layer and a knowledge time, from the component set_view (shared/agent/events.ts
 * LionfishViewState: preset, region, area, layers, basis, asOf, replay).
 */
async function lionfishView(origin: string): Promise<void> {
  const app = getApp(APP);
  const res = await fetch(`${origin}/api/agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: APP, sessionId: `e2e-lionfish-view-${Date.now()}`, question: LIONFISH_VIEW_QUESTION, view: { bbox: appBBox(app), time: FIXTURE_NOW, layers: [], selection: null } }),
  });
  assert(res.ok, `agent stream answered ${res.status}`);
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AgentStreamEvent);
  const views = events.filter((e): e is Extract<AgentStreamEvent, { type: "view" }> => e.type === "view");
  const now = Date.parse(FIXTURE_NOW);
  const framed = views.find((v) => (v.preset === "belize" || v.region === "belize") && Array.isArray(v.layers) && v.layers.includes("heat") && typeof v.asOf === "number" && v.asOf < now);
  assert(framed, `no view event framing belize with the heat layer and a knowledge time (views: ${JSON.stringify(views)})`);
  const tools = events.filter((e) => e.type === "tool_start").map((e) => (e as { capabilityName: string }).capabilityName);
  assert(tools.includes("set_view"), `set_view not called (tools: ${tools.join(", ")})`);
  const done = events.at(-1);
  assert(done?.type === "done" && done.content.length > 0, "no answer");
  found.view = true;
  log(`lionfish view: preset=${framed.preset} region=${framed.region} layers=${framed.layers?.join(",")} asOf=${new Date(framed.asOf!).toISOString()} replay=${framed.replay} tools=${tools.join(",")}`);
}

const GE7_SHIPS_QUESTION = "Show me ships near Louisiana.";
const GE7_LOOK_QUESTION = "Switch the map to night vision.";
const GE7_SHOTS = resolve(WEB, "../../docs/evidence");

/**
 * GE7 G6 (`--ge7`): the agent knows the map's new layers and looks, on the real stack (Axum with carp's fixtures, the
 * production build, the proxy), with the local AISStream mock feeding six recorded-template ships through the real
 * ingest pipeline, and the real model (OpenRouter through Doppler; two short turns). "Show me ships near Louisiana"
 * must switch the Ships layer on (a `ui` toggle_layer event, LAYERS.vessels on, ships drawn) and cite ships as
 * `vessel:<mmsi>` chips; "Switch the map to night vision" must set the look (a `ui` set_look event, LOOK nvg).
 * Then, for gates/leaf-GE7.md G9, radar on through the Layers popover, the scope feather at 40, the Layers popover,
 * the Developer panel (no key value on screen) and the phone layout are saved to docs/evidence/ge7-*.png.
 * Line: `AGENT-LAYERS toggled=<layer> cited=<n> look=<set|missing>`.
 */
async function ge7(): Promise<void> {
  const { buildFrames, MOCK_KEY, startMock, waitForTracks } = await import("./ais-mock");
  const { tapAgentStreams, ask } = await import("./agent-ui");
  const { buildApi, buildWeb, startStack } = await import("./stack");
  const nowMs = Date.now();
  const { frames, fromMs, toMs } = await buildFrames(nowMs);
  const mock = startMock(frames);
  const say = (...a: unknown[]) => log(a.map(String).join(" "));
  buildApi(say);
  buildWeb(say);
  // Overlays reach their real upstreams (NO_PROXY); every other poller hits the dead proxy, so no feed data comes from the network.
  const stack = await startStack({
    name: "agent-ge7",
    app: "carp",
    apps: ["carp"],
    offlinePollers: true,
    axumEnv: { AISSTREAM_URL: mock.url, AISSTREAM_API_KEY: MOCK_KEY, NO_PROXY: "nowcoast.noaa.gov,gibs.earthdata.nasa.gov,www.nhc.noaa.gov,mapservices.weather.noaa.gov", no_proxy: "nowcoast.noaa.gov,gibs.earthdata.nasa.gov,www.nhc.noaa.gov,mapservices.weather.noaa.gov" },
  });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  let toggled = "none";
  let cited = 0;
  let look = false;
  try {
    const tracks = await waitForTracks(stack, fromMs, toMs);
    log(`mock AISStream: ${tracks.length} ships stored over ${Math.round((toMs - fromMs) / 3_600_000)} h`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await context.addInitScript(tapAgentStreams);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${stack.origin}/?app=carp#v=2&app=carp`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="app-select-button"][data-app="carp"]').waitFor({ timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => !!window.__inversa?.globe(), undefined, { timeout: BOOT_TIMEOUT_MS });
    await page.waitForTimeout(1_500);
    const streams = () => page.evaluate(() => (window as unknown as { __agentStreams: { events: { type: string; [k: string]: unknown }[] }[] }).__agentStreams);
    const visible = (id: string) => page.evaluate((l) => (window.__inversa?.state("LAYERS") as { visible: Record<string, boolean> }).visible[l] === true, id);

    // 1. Ships.
    if (await visible("vessels")) throw new Error("the Ships layer is on before the question (novice default broken)");
    await ask(page, GE7_SHIPS_QUESTION, STEP_TIMEOUT_MS * 2);
    const turn1 = (await streams()).at(-1)!.events;
    const tools1 = turn1.filter((e) => e.type === "tool_start").map((e) => String(e.capabilityName));
    const uis1 = turn1.filter((e) => e.type === "ui");
    const toggleEvent = uis1.find((e) => e.name === "toggle_layer" && (e.args as { layer?: string; visible?: boolean })?.layer === "vessels" && (e.args as { visible?: boolean }).visible === true);
    const answer = page.locator('[data-chat-column] [data-source="text"][data-status="done"]').last();
    const chips = await answer.locator(".agent-cite").evaluateAll((els) => els.map((el) => el.getAttribute("data-evidence-id") ?? ""));
    cited = chips.filter((id) => id.startsWith("vessel:")).length;
    if (toggleEvent && (await visible("vessels"))) toggled = "vessels";
    await page.waitForFunction(() => ((window.__inversa?.globe()?.layers.find((l) => l.id === "vessels")?.count ?? 0) > 0), undefined, { timeout: 60_000 }).catch(() => log("no ships drawn within 60 s"));
    const drawn = await page.evaluate(() => window.__inversa?.globe()?.layers.find((l) => l.id === "vessels")?.count ?? 0);
    log(`turn 1 "${GE7_SHIPS_QUESTION}": tools ${tools1.join(", ")}; ui ${JSON.stringify(uis1.map((e) => [e.name, e.args]))}; chips ${chips.join(", ")}; ships drawn ${drawn}`);

    // 2. Night vision.
    await ask(page, GE7_LOOK_QUESTION, STEP_TIMEOUT_MS * 2);
    const turn2 = (await streams()).at(-1)!.events;
    const lookEvent = turn2.find((e) => e.type === "ui" && e.name === "set_look");
    await page.waitForFunction(() => window.__inversa?.state("LOOK") === "nvg", undefined, { timeout: 10_000 }).catch(() => undefined);
    look = !!lookEvent && (await page.evaluate(() => window.__inversa?.state("LOOK"))) === "nvg";
    log(`turn 2 "${GE7_LOOK_QUESTION}": tools ${turn2.filter((e) => e.type === "tool_start").map((e) => String(e.capabilityName)).join(", ")}; ui ${JSON.stringify(lookEvent ?? null)}; LOOK ${await page.evaluate(() => String(window.__inversa?.state("LOOK")))}`);

    // 3. Evidence screenshots (G9). Radar on through the Layers popover; the look back to normal for the ships shot.
    mkdirSync(GE7_SHOTS, { recursive: true });
    await page.click('[data-testid="layers-bar-button"]');
    await page.locator('[data-testid="layers-popover"]').waitFor();
    await page.click('[data-testid="legend-toggle-radar"]');
    await page.screenshot({ path: join(GE7_SHOTS, "ge7-layers-popover-1440.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      location.hash = location.hash.replace(/(^#|&)c=[^&]*/, "") + "&c=29.6,-91.6,700000,0,-90";
    });
    await page.waitForResponse((r) => r.url().includes("/overlay/radar/"), { timeout: 60_000 }).catch(() => log("no radar tile response seen"));
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: join(GE7_SHOTS, "ge7-carp-ships-radar-nvg-1440.png") });
    await page.click('[data-testid="look-button"]');
    await page.locator('[data-testid="look-popover"]').waitFor();
    const slider = page.locator('[data-testid="scope-feather"]');
    await slider.focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__inversa?.state("SCOPE_FEATHER") === 40, undefined, { timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(GE7_SHOTS, "ge7-look-nvg-feather40-1440.png") });
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="look-popover"]').waitFor({ state: "detached" });
    await page.click('[data-testid="developer-button"]');
    await page.locator('[data-testid="developer-panel"]').waitFor();
    await page.waitForTimeout(800);
    const devText = await page.locator('[data-testid="developer-panel"]').innerText();
    const devInputs = await page.locator('[data-testid="developer-panel"] input').evaluateAll((els) => els.map((el) => ({ type: (el as HTMLInputElement).type, filled: (el as HTMLInputElement).value.length > 0 })));
    const keyShaped = /AIza[0-9A-Za-z_-]{20}|sk-[0-9A-Za-z-]{20}|eyJ[0-9A-Za-z_-]{20}/.test(devText);
    log(`developer panel: ${devInputs.length} inputs (types ${[...new Set(devInputs.map((i) => i.type))].join(",")}, filled ${devInputs.filter((i) => i.filled).length}); key-shaped text on screen: ${keyShaped}`);
    // Key fields are password fields and start empty; the one number field is the monthly Google cap.
    if (keyShaped || devInputs.some((i) => i.type !== "number" && i.filled) || devInputs.some((i) => i.type === "text")) throw new Error("the Developer panel shows a key value");
    await page.screenshot({ path: join(GE7_SHOTS, "ge7-developer-1440.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: join(GE7_SHOTS, "ge7-carp-375.png") });
    if (errors.length) log(`page errors: ${errors.join(" | ")}`);
    await context.close();
  } finally {
    await browser.close();
    await stack.stop();
    mock.stop();
  }
  console.log(`AGENT-LAYERS toggled=${toggled} cited=${cited} look=${look ? "set" : "missing"}`);
  if (toggled !== "vessels" || cited === 0 || !look) process.exitCode = 1;
}

async function main(): Promise<void> {
  assert(process.env.OPENROUTER_API_KEY?.trim(), "OPENROUTER_API_KEY not set: run `bun run e2e:agent`, which wraps doppler inversa/dev");
  if (process.argv.includes("--ge7")) {
    await ge7();
    return;
  }
  const saved = new Map(DEV_SIDE_EFFECTS.map((file) => [file, existsSync(file) ? readFileSync(file) : null]));
  const stub = startStub();
  const dataDir = mkdtempSync(join(tmpdir(), "inversa-e2e-agent-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const next = spawn(join(WEB, "node_modules/.bin/next"), ["dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: WEB,
    detached: true,
    env: { ...process.env, INVERSA_API_ORIGIN: stub.origin, INVERSA_DATA_DIR: dataDir, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout?.on("data", (chunk) => (output += String(chunk)));
  next.stderr?.on("data", (chunk) => (output += String(chunk)));
  let browser: Browser | null = null;
  try {
    await waitForHttp(`${origin}/dev/agent`, next, () => output);
    log(`next dev on ${origin}, stub ${stub.origin}, app ${APP}, agent openai/gpt-6-luna on OpenRouter`);
    browser = await launch();
    await flow(origin, browser);
    if (APP === "carp") await replayView(origin);
    if (APP === "lionfish") await lionfishView(origin);
  } finally {
    await browser?.close().catch(() => undefined);
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
  console.log(`AGENT app=${APP} flow=ok tools=${found.tools} citation=${found.citation ? "ok" : "missing"}${APP === "carp" || APP === "lionfish" ? ` view=${found.view ? "ok" : "missing"}` : ""}`);
  console.log("FLOW-OK");
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`[e2e:agent] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
