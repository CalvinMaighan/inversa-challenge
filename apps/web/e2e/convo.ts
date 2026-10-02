/**
 * Conversation integration (gates/node-convo.md N3) on the real stack (e2e/stack.ts) with the real agent: no
 * mock harness. The Next server gets its model key from Doppler (`doppler run --project inversa --config dev`)
 * unless `OPENROUTER_API_KEY` is already in the environment; the key is never printed.
 *
 *   bun run e2e:convo           build, run, print CONVO-OK last
 *   bun run e2e:convo --shot    also save docs/evidence/convo.png
 *   E2E_SKIP_BUILD=1 …          reuse the last e2e build
 *
 * On the ops page `/`: in the chat column, ask a question that needs a place and a time, and check what the real
 * model's answer did, whatever its wording:
 * 1. the stream carried a `view` event, and the real Cesium camera now looks at that box (the globe writes its
 *    camera back to VIEW after the flight; the box centre also projects near the globe pane centre);
 * 2. the answer has citation chips; clicking the first opens the evidence drawer on that id, and the drawer shows
 *    the record Axum returns for `evidence(id)` (every field name, and its values).
 * A real model can skip `set_view` or citations on one turn; one follow-up asks for what is missing.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";

import { buildApi, buildWeb, REPO_DIR, startStack } from "./stack";

const QUESTION =
  "Fly the map to Shark Valley and show me the Burmese python sightings there around 17:00 UTC on 1 February 2026, during the cold snap. Cite the sighting records.";
const FOLLOW_UP = "Please move the map to those sightings with set_view (time 2026-02-01T17:00:00Z) and cite each sighting record you used.";
const TURN_TIMEOUT_MS = 240_000;
const SHOT = path.join(REPO_DIR, "docs/evidence/convo.png");
const DOPPLER = ["doppler", "run", "--project", "inversa", "--config", "dev", "--"];

const log = (...a: unknown[]) => console.error("[e2e:convo]", ...a);

type BBox = { west: number; south: number; east: number; north: number };
type StreamEvent = { type: string; bbox?: BBox; time?: string; id?: string; message?: string };

function fail(message: string): never {
  throw new Error(message);
}

type Tapped = { status: number; text: string; done: boolean };

/**
 * Test tap, installed before the page loads: tees the body of each `/api/agent/stream` response, so the script
 * reads the NDJSON the column read without taking the stream from it (Playwright cannot always hand back the
 * body of a streamed response).
 */
function tapAgentStreams(): void {
  const w = window as unknown as { __agentStreams: Tapped[] };
  w.__agentStreams = [];
  const original = window.fetch.bind(window);
  const tapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/agent/stream") || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    const entry: Tapped = { status: res.status, text: "", done: false };
    w.__agentStreams.push(entry);
    void (async () => {
      const reader = mine.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        entry.text += decoder.decode(value, { stream: true });
      }
      entry.done = true;
    })();
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  window.fetch = tapped as typeof fetch;
}

/** Ask in the chat column and return the NDJSON events of that turn's stream. */
async function ask(page: Page, text: string): Promise<StreamEvent[]> {
  const column = page.locator("[data-chat-column]");
  const input = column.getByRole("textbox", { name: "Question" });
  const before = await page.evaluate(() => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams.length);
  await input.fill(text);
  await input.press("Enter");
  await page.waitForFunction(
    (n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]?.done === true,
    before,
    { timeout: TURN_TIMEOUT_MS },
  );
  const res = await page.evaluate((n) => (window as unknown as { __agentStreams: Tapped[] }).__agentStreams[n]!, before);
  // The column has rendered the end of the turn.
  await page.waitForFunction(
    () => !document.querySelector('[data-chat-column] [data-source="text"][data-status="streaming"], [data-chat-column] [data-source="text"][data-status="pending"]'),
    undefined,
    { timeout: 30_000 },
  );
  const body = res.text;
  const events = body
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as StreamEvent;
      } catch {
        return { type: "unparsed" };
      }
    });
  if (res.status !== 200) fail(`agent stream answered ${res.status}: ${body.slice(0, 400)}`);
  const error = events.find((e) => e.type === "error");
  if (error) fail(`the agent turn failed: ${error.message ?? JSON.stringify(error)}`);
  return events;
}

const inside = (b: BBox, lat: number, lon: number, pad: number) => {
  const dx = (b.east - b.west) * pad;
  const dy = (b.north - b.south) * pad;
  return lon >= b.west - dx && lon <= b.east + dx && lat >= b.south - dy && lat <= b.north + dy;
};

async function main() {
  buildApi(log);
  buildWeb(log);
  const nextPrefix = process.env.OPENROUTER_API_KEY ? [] : DOPPLER;
  log(nextPrefix.length ? "model key from Doppler (inversa/dev)" : "model key from the environment");
  const stack = await startStack({ name: "convo", scene: true, nextPrefix });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(TURN_TIMEOUT_MS);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(tapAgentStreams);
    await page.goto(`${stack.origin}/`, { waitUntil: "load" });
    await page.waitForFunction(() => (window.__inversa?.snapshot().grid?.frameCount ?? 0) > 0 && window.__inversa?.globe() !== null, undefined, { timeout: 120_000 });
    const viewBefore = (await page.evaluate(() => window.__inversa!.state("VIEW"))) as { lat: number; lon: number };

    await page.locator("[data-chat-column]").waitFor();

    let events = await ask(page, QUESTION);
    const summary = (evs: StreamEvent[]) => evs.map((e) => e.type).filter((t, i, a) => a.indexOf(t) === i).join(",");
    log(`turn 1 events: ${summary(events)}`);
    let chips = page.locator("[data-chat-column] .agent-cite");
    if (!events.some((e) => e.type === "view") || (await chips.count()) === 0) {
      const more = await ask(page, FOLLOW_UP);
      log(`turn 2 events: ${summary(more)}`);
      events = [...events, ...more];
      chips = page.locator("[data-chat-column] .agent-cite");
    }
    const views = events.filter((e): e is StreamEvent & { bbox: BBox; time: string } => e.type === "view" && !!e.bbox);
    if (views.length === 0) fail(`no view event in the stream (${summary(events)})`);
    const view = views.at(-1)!;

    // 1. The real camera flew there: the globe's own write-back of its pose lands inside the box.
    await page.waitForFunction(
      ([b]) => {
        const v = window.__inversa!.state("VIEW") as { lat: number; lon: number };
        const dx = (b.east - b.west) * 0.25;
        const dy = (b.north - b.south) * 0.25;
        return v.lon >= b.west - dx && v.lon <= b.east + dx && v.lat >= b.south - dy && v.lat <= b.north + dy;
      },
      [view.bbox] as const,
      { timeout: 30_000 },
    );
    const camera = await page.evaluate(([b]) => {
      const d = window.__inversa!;
      const p = d.project((b.west + b.east) / 2, (b.south + b.north) / 2);
      return { view: d.state("VIEW") as { lat: number; lon: number; altitudeM: number }, centre: p, w: document.querySelector("[data-globe] canvas")?.clientWidth ?? window.innerWidth, h: document.querySelector("[data-globe] canvas")?.clientHeight ?? window.innerHeight, time: d.state("TIME") as { at: string } };
    }, [view.bbox] as const);
    if (!camera.centre || Math.abs(camera.centre.x - camera.w / 2) > camera.w * 0.2 || Math.abs(camera.centre.y - camera.h / 2) > camera.h * 0.2) {
      fail(`view box centre projects to ${JSON.stringify(camera.centre)}, not near the screen centre`);
    }
    if (inside(view.bbox, viewBefore.lat, viewBefore.lon, 0.25)) fail("camera already looked at the view box before the answer");
    log(`view ${JSON.stringify(view.bbox)} at ${view.time}: camera ${camera.view.lat.toFixed(4)},${camera.view.lon.toFixed(4)} alt ${Math.round(camera.view.altitudeM)} m, TIME ${camera.time.at}`);

    // 2. A citation opens the drawer on a real Axum record.
    const count = await chips.count();
    if (count === 0) fail("the answer has no citation chips");
    const id = (await chips.first().getAttribute("data-evidence-id")) ?? fail("citation chip without an evidence id");
    await chips.first().click();
    const drawer = page.locator("[data-testid=hud-drawer]");
    await page.waitForFunction((want) => document.querySelector("[data-testid=hud-drawer-id]")?.textContent?.trim() === want, id, { timeout: 30_000 });
    const selection = (await page.evaluate(() => window.__inversa!.state("SELECTION"))) as { evidenceId: string; drawerOpen: boolean };
    if (!selection.drawerOpen || selection.evidenceId !== id) fail(`SELECTION after the click: ${JSON.stringify(selection)}`);
    const record = drawer.locator('section[aria-label="Normalized record"]');
    // The record sits under "Details for experts" (T41), collapsed: attached, not visible.
    await record.waitFor({ state: "attached", timeout: 30_000 });
    const { evidence } = await stack.graphql<{ evidence: { id: string; kind: string; record: Record<string, unknown> } }>(
      "query($id: ID!) { evidence(id: $id) { id kind record } }",
      { id },
    );
    const shown = await record.evaluate((el) =>
      [...el.querySelectorAll("dt")].map((dt): [string, string] => [dt.textContent?.trim() ?? "", dt.nextElementSibling?.textContent?.trim() ?? ""]),
    );
    const shownKeys = new Map<string, string>(shown);
    const keys = Object.keys(evidence.record).filter((k) => k !== "revisions");
    const missing = keys.filter((k) => !shownKeys.has(k));
    if (keys.length === 0 || missing.length) fail(`drawer does not show Axum's record for ${id}: missing ${missing.join(", ")} (shown: ${[...shownKeys.keys()].join(", ")})`);
    const scalar = keys.find((k) => ["string", "number"].includes(typeof evidence.record[k]));
    if (scalar && !shownKeys.get(scalar)!.includes(String(evidence.record[scalar]))) fail(`drawer shows ${scalar}=${shownKeys.get(scalar)}, Axum says ${String(evidence.record[scalar])}`);
    log(`citation ${id} (${evidence.kind}, ${count} chips): drawer shows ${keys.length} record fields, e.g. ${scalar}=${String(scalar ? evidence.record[scalar] : "")}`);

    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    if (process.argv.includes("--shot")) {
      mkdirSync(path.dirname(SHOT), { recursive: true });
      await page.screenshot({ path: SHOT });
      log(`screenshot → ${path.relative(REPO_DIR, SHOT)}`);
    }
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    log(stack.logs());
    throw err;
  } finally {
    await browser.close();
    await stack.stop();
  }
  console.log("CONVO-OK");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[e2e:convo] FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
