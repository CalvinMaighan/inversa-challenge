/**
 * T14/T40 e2e: the chat column against the real agent (GPT-6 Luna on OpenRouter).
 *
 *   bun run e2e:agent      (wraps `doppler run --project inversa --config dev`, which supplies OPENROUTER_API_KEY)
 *
 * Starts the eval's fixture GraphQL stub and `next dev` pointed at it, then in Chromium: the chat column is
 * visible at load (full height, left), ask, see the tool rows, click a citation and check SELECTION (evidence id
 * + drawerOpen), switch to Missions and back without losing the thread. Then at 375 px the column is a bottom
 * sheet; it opens to full height inside the viewport for G3 (docs/evidence/t14-card-375.png). Last line: FLOW-OK.
 * The answer's wording is the model's; the checks are on tools, citations and UI state, not on text.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { FIXTURE_NOW, startStub } from "../eval/stub-server";

const WEB = resolve(import.meta.dir, "..");
const SCREENSHOT = resolve(WEB, "../../docs/evidence/t14-card-375.png");
const QUESTION = "Show me recent tegu sightings around Homestead.";
/** Tools any correct answer to QUESTION needs (eval/golden.ts "tegu-sightings-homestead"); set_view is checked by the fly count. */
const EXPECTED_TOOLS = ["geocode", "sightings"];
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

async function flow(origin: string, browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${origin}/dev/agent?at=${encodeURIComponent(FIXTURE_NOW)}`, { waitUntil: "networkidle" });
  const column = page.locator("[data-chat-column]");
  await column.waitFor();
  // Hydrated once the dev probe reflects the ?at window.
  await page.waitForFunction(() => document.querySelector("[data-dev-probe]")?.getAttribute("data-time-at")?.startsWith("2026-01-15"));

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
  log(`tool rows: ${rows.join(", ")} (${workedFor})`);

  // The view event flew the globe and moved the timeline.
  assert(Number(await probe(page, "data-fly-count")) >= 1, "view event did not call getGlobe().flyTo");

  // 4. Citations: inline chips for verified ids only.
  const chips = answer.locator(".agent-cite");
  const chipIds = await chips.evaluateAll((els) => els.map((el) => el.getAttribute("data-evidence-id")));
  assert(chipIds.length >= 2, `expected at least 2 citation chips, got ${chipIds.length}`);
  assert(chipIds.some((id) => id?.startsWith("sighting:")), `no sighting citation among chips: ${chipIds.join(", ")}`);
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

async function main(): Promise<void> {
  assert(process.env.OPENROUTER_API_KEY?.trim(), "OPENROUTER_API_KEY not set: run `bun run e2e:agent`, which wraps doppler inversa/dev");
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
    log(`next dev on ${origin}, stub ${stub.origin}, agent openai/gpt-6-luna on OpenRouter`);
    browser = await launch();
    await flow(origin, browser);
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
  console.log("FLOW-OK");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`[e2e:agent] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
