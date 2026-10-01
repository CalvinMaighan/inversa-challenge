/**
 * Field notes browser gate (gates/leaf-T43.md G3, G6) on the real stack (e2e/dev-stack.ts: `wrangler dev`, a real
 * Axum, `next dev`, free ports) with two Playwright contexts, two identities and one WebRTC mesh:
 *
 *   1. A arms "Pick on map", clicks the globe near Homestead and posts a note; B sees the list entry (timed by a
 *      MutationObserver from A's submit) and the pin (the notes layer's count, and `pick()` at its spot answers
 *      `note:<id>`), and B's row offers no Edit or Delete (not the author).
 *   2. B posts a note of its own, so the Notes tab shows two authors; screenshots: docs/evidence/notes-tab.png,
 *      and A clicks its pin, the drawer shows the note card: docs/evidence/notes-map.png.
 *   3. A edits its note; B sees the new text. A deletes it; the row and the pin disappear on B.
 *   4. With peer traffic blocked and B offline, A posts a note; B must not see it until it reconnects, then both
 *      converge (list and pin).
 *   5. With an OpenRouter key in the environment (`bun run e2e:notes` wraps doppler), A asks the agent what people
 *      noted near Homestead today, waits for a cited answer and saves docs/evidence/notes-agent.png.
 *
 * Prints `NOTES rtc_ms=<n> pin=1 list=1 edit=1 delete=1 offline_sync=1` on success.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { fail, openBoard, REPO_DIR, sleep, startDevStack, tail, watchFor, watchGone, type DevStack } from "./dev-stack";

const SHOT_DIR = join(REPO_DIR, "docs/evidence");
const RTC_TIMEOUT_MS = 90_000;
const CONVERGE_TIMEOUT_MS = 60_000;
const GLOBE_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 240_000;
const NOTES_LAYER = "notes";
const QUESTION = "What have people noted near Homestead today?";

/** Spots on the region overview, well apart so pins never overlap, and clear of the HUD's top bar and timeline. */
const HOMESTEAD = { lon: -80.4776, lat: 25.4687 };
const ROYAL_PALM = { lon: -80.6093, lat: 25.3827 };
/** The third note goes a few hundred metres from the camera's centre (A is zoomed onto its first note by then). */
const NEARBY_PX: [number, number] = [-180, -110];

const log = (...args: unknown[]) => console.error("[e2e:notes]", ...args);

declare global {
  interface Window {
    __t0?: number;
  }
}

type FieldNote = { id: string; text: string; createdBy: string; lon: number; lat: number };
type LayerStat = { id: string; enabled: boolean; count: number };

const pageErrors = new Map<string, string[]>();

async function open(ctx: BrowserContext, name: string, url: string): Promise<Page> {
  const page = await ctx.newPage();
  const errs: string[] = [];
  pageErrors.set(name, errs);
  await openBoard(page, url, errs);
  await page.waitForFunction(() => (window.__inversa?.globe()?.layers.length ?? 0) > 0, null, { timeout: GLOBE_TIMEOUT_MS });
  return page;
}

const nodeId = (page: Page) => page.evaluate(() => window.__team!.nodeId);

async function waitRtc(page: Page, peer: string): Promise<void> {
  await page.waitForFunction((id) => window.__team!.peers().some((p) => p.peerId === id && p.link === "open"), peer, { timeout: RTC_TIMEOUT_MS, polling: 250 });
}

const fieldNotes = async (page: Page): Promise<FieldNote[]> => ((await page.evaluate(() => window.__team!.board()?.fieldNotes ?? [])) as FieldNote[]) ?? [];

async function waitNotes(page: Page, pred: (notes: FieldNote[]) => boolean, what: string, timeoutMs = CONVERGE_TIMEOUT_MS): Promise<FieldNote[]> {
  const deadline = Date.now() + timeoutMs;
  let last: FieldNote[] = [];
  while (Date.now() < deadline) {
    last = await fieldNotes(page);
    if (pred(last)) return last;
    await sleep(200);
  }
  return fail(`${what}: ${JSON.stringify(last).slice(0, 600)}`);
}

const notesLayer = (page: Page) => page.evaluate((id) => (window.__inversa!.globe()!.layers.find((l) => l.id === id) as LayerStat | undefined) ?? null, NOTES_LAYER);

async function waitPins(page: Page, count: number, what: string): Promise<void> {
  await page.waitForFunction(
    ([id, n]) => (window.__inversa?.globe()?.layers.find((l) => l.id === id) as LayerStat | undefined)?.count === n,
    [NOTES_LAYER, count] as const,
    { timeout: CONVERGE_TIMEOUT_MS, polling: 200 },
  );
  log(`${what}: ${count} pin${count === 1 ? "" : "s"} drawn`);
}

/** Screen position of a globe point, in page coordinates, with the element under it (must be the globe canvas). */
async function screenPoint(page: Page, at: { lon: number; lat: number }): Promise<{ x: number; y: number }> {
  const canvas = page.locator("[data-globe] canvas").first();
  const box = (await canvas.boundingBox()) ?? fail("globe canvas has no box");
  const local = await page.evaluate(({ lon, lat }) => window.__inversa!.project(lon, lat), at);
  if (!local) fail(`${at.lat},${at.lon} is off screen`);
  const x = box.x + local.x;
  const y = box.y + local.y;
  const under = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? `${el.tagName}${[...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `[${a.name}]`).join("")}` : null;
  }, [x, y]);
  if (under !== "CANVAS") fail(`${at.lat},${at.lon} is under ${under}, not the globe`);
  return { x, y };
}

/** Arm "Pick on map", click the globe at `at` (or `offsetPx` from the canvas centre), and wait for the place. */
async function pickOnMap(page: Page, at: { lon: number; lat: number } | { offsetPx: [number, number] }): Promise<void> {
  const pick = page.locator('[data-testid="note-pick"]');
  if ((await pick.getAttribute("aria-pressed")) !== "true") {
    // The presence list above it settles as peers connect; a plain button needs no stability check.
    await pick.waitFor({ state: "visible", timeout: 30_000 });
    await pick.click({ force: true });
  }
  await page.waitForFunction(() => (window.__inversa!.state("NOTES") as { picking: boolean }).picking === true);
  let x: number;
  let y: number;
  if ("offsetPx" in at) {
    const box = (await page.locator("[data-globe] canvas").first().boundingBox()) ?? fail("globe canvas has no box");
    x = box.x + box.width / 2 + at.offsetPx[0];
    y = box.y + box.height / 2 + at.offsetPx[1];
  } else ({ x, y } = await screenPoint(page, at));
  await page.mouse.click(x, y);
  await page.locator('[data-testid="note-location"]').waitFor({ timeout: 10_000 });
}

/** Fill the composer and post; returns the submit's Date.now() (a capture-phase listener in the page). */
async function postNote(page: Page, text: string, species?: string): Promise<number> {
  await page.fill('[data-testid="note-text"]', text);
  if (species) await page.selectOption('[data-testid="note-species"]', species);
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="note-composer"]') as HTMLFormElement;
    form.addEventListener("submit", () => (window.__t0 = Date.now()), { capture: true, once: true });
  });
  await page.click('[data-testid="note-post"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="note-text"]') as HTMLTextAreaElement).value === "", null, { timeout: 10_000 });
  return page.evaluate(() => window.__t0!);
}

/** `pick()` on the pin above `at`: the billboard stands on its point, so probe a few px up the pin. */
async function pickPin(page: Page, at: { lon: number; lat: number }): Promise<string | null> {
  const local = await page.evaluate(({ lon, lat }) => window.__inversa!.project(lon, lat), at);
  if (!local) return null;
  for (let dy = 2; dy <= 26; dy += 3) {
    const id = await page.evaluate(([x, y]) => window.__inversa!.pick(x, y), [local.x, local.y - dy]);
    if (id?.startsWith("note:")) return id;
  }
  return null;
}

async function clickPin(page: Page, at: { lon: number; lat: number }): Promise<void> {
  const { x, y } = await screenPoint(page, at);
  // The pin's head sits about 20 px above its tip.
  await page.mouse.click(x, y - 18);
}

const authorRow = (id: string) => `[data-testid="note-row"][data-note-id="${id}"]`;

// ---- agent (live) -----------------------------------------------------------------------------------

async function askAgent(page: Page, stack: DevStack): Promise<string> {
  // The notes must have reached Axum (the outbox flushes them) before the agent reads the board.
  const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
  for (;;) {
    const { board } = await stack.graphql<{ board: { notes: { id: string; fields: Record<string, unknown> }[] } }>('query { board(id: "everglades") { notes { id fields } } }');
    const live = board.notes.filter((n) => n.fields._deleted !== true && typeof n.fields.text === "string");
    if (live.length >= 2) break;
    if (Date.now() > deadline) fail(`server board has ${live.length} live notes`);
    await sleep(500);
  }
  const column = page.locator("[data-chat-column]");
  await column.locator('[data-tab="agent"]').click();
  const input = column.getByRole("textbox", { name: "Question" });
  await input.fill(QUESTION);
  await input.press("Enter");
  const answer = column.locator('[data-source="text"][data-status="done"]').last();
  await answer.waitFor({ timeout: AGENT_TIMEOUT_MS });
  // Tool rows fold under "Worked for"; open them so the screenshot shows the notes call.
  await answer.locator("[data-timeline-toggle]").click();
  const rows = await answer.locator("[data-tool-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-tool-row")));
  const text = (await answer.textContent()) ?? "";
  if (!rows.includes("notes")) fail(`agent did not call notes: tools ${rows.join(",")}`);
  const cites = await answer.locator(".agent-cite").count();
  if (cites < 1) fail(`agent answer cites nothing: ${text.slice(0, 300)}`);
  return text;
}

// ---- scenario ---------------------------------------------------------------------------------------

async function scenario(stack: DevStack): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const pages: Page[] = [];
  try {
    return await run(stack, browser, pages);
  } catch (err) {
    // A failure keeps a picture of each page next to the logs.
    for (const [i, p] of pages.entries()) {
      const path = join(tmpdir(), `notes-e2e-fail-${i === 0 ? "A" : "B"}.png`);
      await p.screenshot({ path }).then(() => log(`failure screenshot ${path}`), () => undefined);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

async function run(stack: DevStack, browser: Browser, pages: Page[]): Promise<string[]> {
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await open(ctxA, "A", stack.page);
  const b = await open(ctxB, "B", stack.page);
  pages.push(a, b);
  // Delete asks for confirmation (a native confirm); A always says yes.
  a.on("dialog", (d) => void d.accept());
  const [idA, idB] = await Promise.all([nodeId(a), nodeId(b)]);
  if (!idA || !idB || idA === idB) fail(`identities: ${idA} ${idB}`);
  log(`A=${idA.slice(0, 8)} B=${idB.slice(0, 8)}; waiting for the data channel`);
  await Promise.all([waitRtc(a, idB), waitRtc(b, idA)]);
  for (const [name, p] of [
    ["A", a],
    ["B", b],
  ] as const) {
    const stat = await notesLayer(p);
    if (!stat?.enabled) fail(`${name}: notes layer not on by default (${JSON.stringify(stat)})`);
  }

  // 1. A picks a spot and posts; B sees the list entry and the pin.
  const textA = `Two tegus by the canal gate, heading west ${Math.random().toString(36).slice(2, 6)}`;
  await pickOnMap(a, HOMESTEAD);
  const place = await a.textContent('[data-testid="note-location"]');
  log(`A picked ${place}`);
  const seen = watchFor(b, '[data-testid="note-list"]', textA);
  const t0 = await postNote(a, textA, "tegu");
  const t1 = await seen;
  const rtcMs = t1 - t0;
  const [noteA] = await waitNotes(b, (n) => n.some((x) => x.text === textA), "note on B");
  if (noteA!.createdBy !== idA) fail(`note author ${noteA!.createdBy}, expected ${idA}`);
  if (Math.abs(noteA!.lat - HOMESTEAD.lat) > 0.05 || Math.abs(noteA!.lon - HOMESTEAD.lon) > 0.05) fail(`note landed at ${noteA!.lat},${noteA!.lon}, asked for Homestead`);
  const list = (await b.$(authorRow(noteA!.id))) !== null;
  if (!list) fail("B's list has no row for A's note");
  if ((await b.$(`${authorRow(noteA!.id)} [data-testid="note-edit"]`)) !== null || (await b.$(`${authorRow(noteA!.id)} [data-testid="note-delete"]`)) !== null) fail("B is offered Edit or Delete on A's note");
  if ((await a.$(`${authorRow(noteA!.id)} [data-testid="note-edit"]`)) === null) fail("A is not offered Edit on its own note");
  await waitPins(b, 1, "B");
  const picked = await pickPin(b, { lon: noteA!.lon, lat: noteA!.lat });
  if (picked !== `note:${noteA!.id}`) fail(`pick() on B's pin answered ${picked}, expected note:${noteA!.id}`);
  log(`list and pin on B after ${rtcMs} ms; pick() answered ${picked}`);

  // 2. B posts too: two authors in the list. Screenshots.
  const textB = `Iguana carcass on the levee after the cold night ${Math.random().toString(36).slice(2, 6)}`;
  await pickOnMap(b, ROYAL_PALM);
  const seenB = watchFor(a, '[data-testid="note-list"]', textB);
  await postNote(b, textB, "iguana");
  await seenB;
  const [noteB] = await waitNotes(a, (n) => n.some((x) => x.text === textB), "B's note on A");
  await waitPins(a, 2, "A");
  const authors = await a.$$eval('[data-testid="note-author"]', (els) => els.map((el) => el.textContent));
  if (new Set(authors).size < 2) fail(`Notes tab shows one author: ${authors.join(",")}`);
  mkdirSync(SHOT_DIR, { recursive: true });
  await a.locator("[data-chat-column]").screenshot({ path: join(SHOT_DIR, "notes-tab.png") });
  log(`notes-tab.png: authors ${[...new Set(authors)].join(", ")}`);

  // A list row flies the camera onto its note (straight down, so the pin lands at the pane centre, clear of the
  // drawer that the pin click then opens).
  await a.click(`${authorRow(noteA!.id)} button[aria-label^="Note by"]`);
  await a.waitForFunction(
    ({ lon, lat }) => {
      const p = window.__inversa!.project(lon, lat);
      const c = document.querySelector("[data-globe] canvas") as HTMLCanvasElement | null;
      return Boolean(p && c && Math.abs(p.x - c.clientWidth / 2) < 40 && Math.abs(p.y - c.clientHeight / 2) < 40);
    },
    { lon: noteA!.lon, lat: noteA!.lat },
    { timeout: 20_000, polling: 200 },
  );
  await sleep(500);
  await clickPin(a, { lon: noteA!.lon, lat: noteA!.lat });
  await a.locator(`[data-testid="note-card"][data-note-id="${noteA!.id}"]`).waitFor({ timeout: 10_000 });
  const cardText = await a.textContent('[data-testid="note-card-text"]');
  if (cardText !== textA) fail(`note card text ${JSON.stringify(cardText)}`);
  await a.screenshot({ path: join(SHOT_DIR, "notes-map.png") });
  log("notes-map.png: pin clicked, note card open");

  // 3. A edits; B sees the edit. A deletes; the row and the pin go on B.
  const edited = `${textA} (edit: three, one juvenile)`;
  await a.click(`${authorRow(noteA!.id)} [data-testid="note-edit"]`);
  await a.fill('[data-testid="note-edit-text"]', edited);
  const seenEdit = watchFor(b, '[data-testid="note-list"]', edited);
  await a.click('[data-testid="note-save"]');
  await seenEdit;
  await waitNotes(b, (n) => n.some((x) => x.id === noteA!.id && x.text === edited), "edit on B");
  log("edit seen on B");
  const gone = watchGone(b, authorRow(noteA!.id));
  await a.click(`${authorRow(noteA!.id)} [data-testid="note-delete"]`);
  await gone;
  await waitNotes(b, (n) => !n.some((x) => x.id === noteA!.id), "delete on B");
  await waitPins(b, 1, "B after delete");
  if ((await pickPin(b, { lon: noteA!.lon, lat: noteA!.lat })) !== null) fail("the deleted note still picks on B");
  log("delete seen on B: row and pin gone");

  // 4. Offline: peer traffic blocked, B cut off; A posts; B converges after reconnecting.
  await Promise.all([a, b].map((p) => p.evaluate(() => window.__team!.blockRtc(true))));
  await ctxB.setOffline(true);
  const textC = `Python crossing the levee road ${Math.random().toString(36).slice(2, 6)}`;
  await pickOnMap(a, { offsetPx: NEARBY_PX });
  await postNote(a, textC, "python");
  await waitNotes(a, (n) => n.some((x) => x.text === textC), "note C on A");
  await sleep(1_500);
  if ((await fieldNotes(b)).some((x) => x.text === textC)) fail("B saw A's note while offline");
  await ctxB.setOffline(false);
  const [noteC] = await waitNotes(b, (n) => n.some((x) => x.text === textC), "B converged after reconnect");
  await b.locator(authorRow(noteC!.id)).waitFor({ timeout: 10_000 });
  await waitPins(b, 2, "B after reconnect");
  const [fa, fb] = await Promise.all([fieldNotes(a), fieldNotes(b)]);
  const canon = (n: FieldNote[]) => JSON.stringify(n.map((x) => [x.id, x.text]).sort());
  if (canon(fa) !== canon(fb)) fail(`notes differ after reconnect:\nA ${canon(fa)}\nB ${canon(fb)}`);
  log("offline note converged on B");
  void noteB;

  // 5. The agent reads the board (live model; skipped without a key).
  if (process.env.OPENROUTER_API_KEY) {
    const text = await askAgent(a, stack);
    await a.screenshot({ path: join(SHOT_DIR, "notes-agent.png") });
    log(`notes-agent.png: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    console.log("NOTES-AGENT ok=1");
  } else {
    log("no OPENROUTER_API_KEY: agent step skipped (run through `bun run e2e:notes`)");
    console.log("NOTES-AGENT skipped");
  }

  const fatal = [...pageErrors.entries()].flatMap(([n, errs]) => errs.filter((e) => /\[rtc\]|\[team\]|\[missions\]|\[notes\]|Uncaught/.test(e)).map((e) => `${n}: ${e}`));
  if (fatal.length) fail(`page errors:\n${fatal.join("\n")}`);

  return [`NOTES rtc_ms=${rtcMs} pin=1 list=1 edit=1 delete=1 offline_sync=1`];
}

async function main(): Promise<number> {
  let stack: DevStack | null = null;
  try {
    stack = await startDevStack("notes");
    const lines = await scenario(stack);
    for (const l of lines) console.log(l);
    return 0;
  } catch (err) {
    for (const p of stack?.procs ?? []) console.log(`---- ${p.name} log ----\n${tail(p)}`);
    for (const [name, errs] of pageErrors) if (errs.length) console.log(`---- page ${name} errors ----\n${errs.slice(-20).join("\n")}`);
    console.log(`NOTES-FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await stack?.stop();
  }
}

const code = await main();
process.exit(code);
