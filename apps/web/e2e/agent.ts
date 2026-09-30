/**
 * T14 e2e: the agent orb and card against the mock harness.
 *
 *   bun run e2e:agent
 *
 * Starts the eval's fixture GraphQL stub and `next dev` with `AGENT_HARNESS=mock` (golden replay plans loaded
 * through /dev/agent/mock), then in Chromium: open the card, ask, see the tool rows, click a citation and
 * check SELECTION (evidence id + drawerOpen), collapse with Esc. Then a 375 px viewport screenshot of the
 * card for G3 (docs/evidence/t14-card-375.png). Last line: FLOW-OK.
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
/** Tools the golden plan for QUESTION runs (eval/golden.ts "tegu-sightings-homestead"). */
const EXPECTED_TOOLS = ["geocode", "sightings", "set_view"];
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
  const orb = page.getByRole("button", { name: /open agent chat/i });
  await orb.waitFor();
  // Hydrated once the dev probe reflects the ?at window.
  await page.waitForFunction(() => document.querySelector("[data-dev-probe]")?.getAttribute("data-time-at")?.startsWith("2026-01-15"));

  // 1. Open: the orb morphs into the card.
  await orb.click();
  const card = page.getByRole("dialog", { name: "Agent chat" });
  await card.waitFor();
  await page.waitForFunction(() => document.querySelector("[data-agent-card]")?.getAttribute("data-stage") === "open");
  const box = await card.boundingBox();
  assert(box && Math.abs(box.width - 360) <= 1 && Math.abs(box.height - 480) <= 1, `card is ${box?.width}x${box?.height}, want 360x480`);
  log(`card open at ${Math.round(box.x)},${Math.round(box.y)} ${box.width}x${box.height}`);

  // 2. Ask.
  const input = card.getByRole("textbox", { name: "Question" });
  assert(await input.evaluate((el) => el === document.activeElement), "composer is not focused after the card opened");
  await input.fill(QUESTION);
  await input.press("Enter");
  await card.getByText(QUESTION).waitFor();
  const answer = card.locator('[data-source="text"][data-status="done"]').last();
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
  assert(chipIds.length >= 3, `expected 3 citation chips, got ${chipIds.length}`);
  const bodyText = (await answer.textContent()) ?? "";
  assert(!bodyText.includes("[e:"), "raw [e:…] marker leaked into the answer text");
  const firstId = chipIds[0]!;
  await chips.first().click();
  await page.waitForFunction((id) => document.querySelector("[data-dev-probe]")?.getAttribute("data-evidence-id") === id, firstId);
  assert((await probe(page, "data-drawer-open")) === "true", "citation click did not set SELECTION.drawerOpen");
  log(`citation ${firstId} selected, drawer open`);

  // 5. Esc collapses the card back into the orb.
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-haspopup") === "dialog");
  log("Esc collapsed the card; focus back on the orb");

  // Click-away collapses too.
  await orb.click();
  await page.waitForFunction(() => document.querySelector("[data-agent-card]")?.getAttribute("data-stage") === "open");
  await page.mouse.click(200, 400);
  await card.waitFor({ state: "detached" });
  log("click-away collapsed the card");

  // 6. G3: 375 px viewport, card as a full-width sheet inside the viewport.
  await page.setViewportSize({ width: 375, height: 812 });
  await orb.click();
  await page.waitForFunction(() => document.querySelector("[data-agent-card]")?.getAttribute("data-stage") === "open");
  const sheet = await card.boundingBox();
  assert(sheet, "no card at 375 px");
  const inside = sheet.x >= 0 && sheet.y >= 0 && sheet.x + sheet.width <= 375 && sheet.y + sheet.height <= 812;
  assert(inside, `card at 375 px leaves the viewport: ${JSON.stringify(sheet)}`);
  await card.locator("[data-timeline-toggle]").last().click();
  mkdirSync(dirname(SCREENSHOT), { recursive: true });
  await page.screenshot({ path: SCREENSHOT });
  log(`375 px card ${sheet.width}x${sheet.height} at ${sheet.x},${sheet.y}; screenshot ${SCREENSHOT}`);

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  await context.close();
}

async function main(): Promise<void> {
  const saved = new Map(DEV_SIDE_EFFECTS.map((file) => [file, existsSync(file) ? readFileSync(file) : null]));
  const stub = startStub();
  const dataDir = mkdtempSync(join(tmpdir(), "inversa-e2e-agent-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const next = spawn(join(WEB, "node_modules/.bin/next"), ["dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: WEB,
    detached: true,
    env: { ...process.env, AGENT_HARNESS: "mock", INVERSA_API_ORIGIN: stub.origin, INVERSA_DATA_DIR: dataDir, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout?.on("data", (chunk) => (output += String(chunk)));
  next.stderr?.on("data", (chunk) => (output += String(chunk)));
  let browser: Browser | null = null;
  try {
    await waitForHttp(`${origin}/dev/agent`, next, () => output);
    const seeded = await fetch(`${origin}/dev/agent/mock`, { method: "POST" });
    assert(seeded.ok, `seeding mock scripts failed: ${seeded.status}`);
    log(`next dev on ${origin}, stub ${stub.origin}, mock scripts loaded`);
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
