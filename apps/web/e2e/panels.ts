/**
 * T38 e2e: agent data panels and globe highlights, with the real LLM, per app, on the real stack (e2e/stack.ts:
 * Axum over a temp data dir filled by `backfill --fixtures --app <id>`, the production e2e build, the signal Worker
 * and the Caddy-like proxy that sends /v1 to Axum). The Next server gets its model key from Doppler unless
 * `OPENROUTER_API_KEY` is set; the key is never printed.
 *
 *   doppler run --project inversa --config dev -- bun run e2e:panels -- --app <id>   (default python)
 *   E2E_SKIP_BUILD=1 …   reuse the last e2e build
 *
 * In Chromium on the ops page (`/?app=<id>`, real globe and HUD) the script asks the app's agent a question whose
 * answer has a table and a series. Clocks: python sits just after its fixtures were recorded (the default window
 * holds them), lionfish at its live edge (2026-10-01T09:00Z, as e2e/lionfish.ts), carp on the wall clock.
 *
 * Assertions are on what the answer shows, never on the model's wording: a table panel with rows, a series panel
 * with lines, and a row click that opens the evidence drawer on the real Axum record. Python also checks one
 * bracket per highlighted entity (capped at 50; station readings only when cited, T41), a camera move and the
 * expanded panels' place beside the chat column; other apps print the measured bracket count. Last line:
 *
 *   PANELS app=<id> table=<rows> series=<lines> brackets=<n> drawer=1
 *
 * Screenshots: python docs/evidence/agent-panels.png (and layout-desktop.png), else agent-panels-<app>.png.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

import type { AgentStreamEvent } from "../shared/agent/events";
import type { AppId } from "../shared/apps";
import { appArg } from "./args";
import { buildApi, buildWeb, REPO_DIR, startStack, type Stack } from "./stack";

const APP: AppId = appArg();
const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];
const SHOT = path.join(REPO_DIR, "docs/evidence", APP === "python" ? "agent-panels.png" : `agent-panels-${APP}.png`);
/** The answer with its panels in the chat column, before Expand (T40 layout evidence; python only). */
const LAYOUT_SHOT = path.join(REPO_DIR, "docs/evidence/layout-desktop.png");
const QUESTIONS: Record<AppId, string> = {
  python: "Show recent python sightings near Homestead and the water levels",
  carp: "Show the stage at Krotz Springs over the last week with the forecast, and list the latest readings at every site",
  lionfish: "Show the reef heat stress and the water temperature in the Florida Keys over the last week as a chart, and list the latest readings in a table",
};
/** Python: the Axum fixtures were recorded 2026-09-30T20:40Z. */
const FIXTURE_CLOCK = "2026-09-30T21:00:00Z";
/** Lionfish: the live edge e2e/lionfish.ts uses. */
const LIONFISH_CLOCK = "2026-10-01T09:00:00Z";
const ANSWER_TIMEOUT_MS = 240_000;
const LOAD_TIMEOUT_MS = 120_000;
const MAX_BRACKETS = 50;
/** The HUD labels and brackets the newest this many citations (client/hud/overlay/targets MAX_CITATIONS). */
const MAX_CITATIONS = 8;

const log = (...args: unknown[]) => console.error("[e2e:panels]", ...args);

function fail(message: string): never {
  throw new Error(message);
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

/** A value of the Axum record the drawer must show: its time when it has one, else its first short string. */
function recordMark(record: Record<string, unknown>): string | null {
  for (const key of ["observedAt", "issuedAt", "validAt", "fetchedAt"]) if (typeof record[key] === "string") return record[key];
  return Object.values(record).find((v): v is string => typeof v === "string" && v.length >= 3 && v.length <= 80) ?? null;
}

async function flow(stack: Stack): Promise<string> {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (APP === "python") await page.clock.install({ time: new Date(FIXTURE_CLOCK) });
    if (APP === "lionfish") await page.clock.setFixedTime(Date.parse(LIONFISH_CLOCK));

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

    await page.goto(`${stack.origin}/?app=${APP}`, { waitUntil: "load" });
    // The chat column is open from the start (T40).
    const column = page.locator("[data-chat-column]");
    await column.waitFor({ timeout: LOAD_TIMEOUT_MS });
    await page.locator('[data-testid="hud-overlay"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
    if (APP === "lionfish") {
      await page.locator('[data-testid="lionfish-hud"][data-ready="1"]').waitFor({ state: "attached", timeout: LOAD_TIMEOUT_MS });
      const dismiss = page.locator('[data-testid="lionfish-banner-dismiss"]');
      if (await dismiss.count()) await dismiss.click();
    }
    // Let the globe settle and write its camera into the share-link hash.
    await page.waitForTimeout(4_000);
    const cameraBefore = cameraOf(page.url());
    log(`page up; camera ${cameraBefore ?? "(default)"}`);

    const question = QUESTIONS[APP];
    const input = column.getByRole("textbox", { name: "Question" });
    await input.fill(question);
    await input.press("Enter");
    log(`asked: ${question}`);

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
    for (const e of events) if (e.type === "tool_end" && !e.ok) log(`  tool failed: ${JSON.stringify(e).slice(0, 300)}`);

    // The column shows the turn's panels under the answer.
    await turn.locator("[data-panels]").waitFor({ timeout: 10_000 }).catch(() => fail(`the answer shows no data panels (tools: ${tools.join(", ") || "none"})`));

    let brackets: { drawn: number; highlight: number; targets: number };
    if (APP === "python") {
      if (expected.length === 0) fail("the answer's tools returned nothing to highlight");
      // Globe: the camera framed the answer, and every highlighted entity is bracketed.
      await page.waitForFunction((before) => {
        const c = location.hash.match(/[#&]c=([^&]+)/)?.[1] ?? null;
        return c !== null && c !== before;
      }, cameraBefore, { timeout: 30_000 });
      log(`camera ${cameraBefore ?? "(default)"} → ${cameraOf(page.url())}`);
      await page
        .waitForFunction(
          (want) => Number((document.querySelector('[data-testid="hud-overlay"]') as HTMLElement | null)?.dataset.highlightBrackets ?? -1) === want,
          expected.length,
          { timeout: 45_000 },
        )
        .catch(async () => fail(`brackets ${JSON.stringify(await overlay(page))}, want ${expected.length} highlight brackets`));
      brackets = await overlay(page);
      // The answer and its panels in the column, the globe framed and bracketed beside it (T40 layout evidence).
      await page.waitForTimeout(1_500);
      mkdirSync(path.dirname(LAYOUT_SHOT), { recursive: true });
      await page.screenshot({ path: LAYOUT_SHOT });
      log(`screenshot ${path.relative(REPO_DIR, LAYOUT_SHOT)}`);
    } else {
      // No bracket bound for the other apps: measure what the overlay draws once it settles.
      await page.waitForTimeout(3_000);
      brackets = await overlay(page);
      log(`camera ${cameraBefore ?? "(default)"} → ${cameraOf(page.url()) ?? "(default)"}; highlight ids ${expected.length}`);
    }
    log(`brackets drawn=${brackets.drawn} highlight=${brackets.highlight} targets=${brackets.targets}`);

    // Expand: every panel of the answer, over the globe pane next to the column.
    await turn.locator("[data-expand-panels]").click();
    const expanded = page.locator("[data-expanded-panels]");
    await expanded.waitFor();
    // Let the pop-out finish its entrance and the globe finish drawing before measuring and the screenshot.
    await page.waitForTimeout(800);
    const box = (await expanded.boundingBox())!;
    const columnBox = (await column.boundingBox())!;
    const globeBox = (await page.locator("[data-globe]").boundingBox())!;
    const cx = globeBox.x + globeBox.width / 2;
    const cy = globeBox.y + globeBox.height / 2;
    const placement = [
      box.x < columnBox.x + columnBox.width ? `expanded panel ${JSON.stringify(box)} overlaps the chat column ${JSON.stringify(columnBox)}` : null,
      box.x > globeBox.x + globeBox.width / 2 ? `expanded panel ${JSON.stringify(box)} is not over the left part of the globe pane ${JSON.stringify(globeBox)}` : null,
      box.x <= cx && box.x + box.width >= cx && box.y <= cy && box.y + box.height >= cy ? "expanded panel covers the globe centre" : null,
    ].filter((p): p is string => p !== null);
    if (placement.length) {
      if (APP === "python") fail(placement[0]!);
      log(`layout: ${placement.join("; ")}`);
    }

    const tables = await expanded.locator("[data-panel='table']").evaluateAll((els) =>
      els.map((el, index) => ({ index, tool: el.getAttribute("data-panel-tool"), rows: Number(el.querySelector("table")?.getAttribute("data-table-rows") ?? 0) })),
    );
    const series = Math.max(0, ...(await expanded.locator("svg[data-series-lines]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-series-lines"))))));
    log(`tables ${JSON.stringify(tables)}; series lines ${series}`);
    const ranked = [...tables.filter((t) => t.tool === "sightings" && t.rows > 0), ...tables.filter((t) => t.tool !== "sightings").sort((a, b) => b.rows - a.rows)];
    const table = ranked.find((t) => t.rows > 0) ?? fail(`no table panel with rows (${JSON.stringify(tables)})`);
    if (series < 1) fail("no series panel with a line");

    mkdirSync(path.dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
    log(`screenshot ${path.relative(REPO_DIR, SHOT)}`);

    // A row click opens the evidence drawer on the real record: the first row (of the chosen table, else of any
    // table with rows) whose evidence id Axum resolves.
    const tableEls = expanded.locator("[data-panel='table']");
    let picked: { tableIndex: number; rowIndex: number; id: string; record: Record<string, unknown> } | null = null;
    for (const t of [table, ...ranked.filter((r) => r !== table && r.rows > 0)]) {
      const ids = await tableEls.nth(t.index).locator("tbody tr").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-evidence-id") ?? ""));
      for (const [rowIndex, id] of ids.entries()) {
        if (!id) continue;
        const record = await stack
          .graphql<{ evidence: { record: Record<string, unknown> | null } | null }>("query($id: ID!) { evidence(id: $id) { record } }", { id })
          .then((d) => d.evidence?.record ?? null)
          .catch((err: unknown) => (log(`evidence ${id}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`), null));
        if (record) {
          picked = { tableIndex: t.index, rowIndex, id, record };
          break;
        }
        log(`row ${id}: no Axum record`);
      }
      if (picked) break;
    }
    if (!picked) fail("no table row carries an evidence id Axum resolves");
    const { id, record } = picked;
    const row = tableEls.nth(picked.tableIndex).locator("tbody tr").nth(picked.rowIndex);
    // A cell that is not the ↗ source-page link (that one opens the publisher's page in a new tab).
    const cell = row.locator("td:not([data-kind=link])").first();
    await ((await cell.count()) ? cell : row).click();
    await page
      .waitForFunction((want) => document.querySelector('[data-testid="hud-drawer-id"]')?.textContent?.trim() === want, id, { timeout: 15_000 })
      .catch(async () => fail(`drawer id "${await page.locator('[data-testid="hud-drawer-id"]').textContent().catch(() => null)}", want ${id}`));
    const mark = recordMark(record);
    if (mark) {
      await page
        .waitForFunction((want) => document.querySelector('[data-testid="hud-drawer"]')?.textContent?.includes(want) ?? false, mark, { timeout: 15_000 })
        .catch(() => fail(`drawer for ${id} never showed the record's ${mark}`));
    } else {
      await page.locator('[data-testid="hud-drawer"] [data-testid="drawer-expert"]').waitFor({ state: "attached", timeout: 15_000 });
    }
    if (await page.locator('[data-testid="hud-drawer"] [role="alert"]').count()) fail("the drawer shows a load error");
    if (!(await column.isVisible())) fail("the chat column hid when the row was clicked");
    log(`row ${id} → drawer with the Axum record (${mark ?? "no time field"})`);

    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    return `PANELS app=${APP} table=${table.rows} series=${series} brackets=${brackets.highlight} drawer=1`;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  buildApi(log);
  buildWeb(log);
  const nextPrefix = process.env.OPENROUTER_API_KEY?.trim() ? [] : DOPPLER;
  log(nextPrefix.length ? "model key from Doppler (inversa/dev)" : "model key from the environment");
  const stack = await startStack({ name: "panels", app: APP, apps: [APP], nextPrefix });
  try {
    console.log(await flow(stack));
  } catch (err) {
    log(stack.logs());
    throw err;
  } finally {
    await stack.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`[e2e:panels] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
