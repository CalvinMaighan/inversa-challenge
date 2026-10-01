/**
 * Direct messages browser gate (gates/leaf-M1.md G4, G5) on the real stack (e2e/dev-stack.ts: `wrangler dev`, a
 * real Axum, `next dev`, free ports) with two Playwright contexts, two identities and one WebRTC mesh:
 *
 *   1. A opens the thread with B, B opens the thread with A. A types a 40-character message one key at a time;
 *      for every key a MutationObserver on B's thread log stamps the moment the new prefix appears. B's
 *      "is typing" line is on while the keys flow.
 *   2. Backspace removes the last character on B too; the caret moved to the middle of the text and a key
 *      pressed there inserts on B at that spot, with B drawing A's caret right after it.
 *   3. Enter commits: both sides show exactly one message with the text, B's live draft and typing line are
 *      gone, Axum has the message (GraphQL `board`), and B after a reload still has it (persistence).
 *   4. B closes its page: A's thread header shows B as away.
 *
 * Prints `DM chars_streamed=40/40 p50_ms=<n> p95_ms=<n> backspace=ok insert=ok persist=ok reload=ok typing=ok presence=ok`
 * and `DM-AXE serious=<n> critical=<n> keyboard=ok` (axe-core over the chat column while the draft streams; the
 * reloaded B opens the thread and replies from the keyboard alone).
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { APP_DIR, fail, openBoard, REPO_DIR, sleep, startDevStack, tail, watchFor, type DevStack } from "./dev-stack";

const SHOT_DIR = join(REPO_DIR, "docs/evidence");
const AXE_PATH = Bun.resolveSync("axe-core/axe.min.js", APP_DIR);
const RTC_TIMEOUT_MS = 90_000;
const CONVERGE_TIMEOUT_MS = 60_000;
const KEY_TIMEOUT_MS = 10_000;
/** 40 characters, no character of which is in a callsign ("Ranger-XXXX") or the panel's own copy. */
const TEXT = "Two tegus by the canal gate heading west";
/** The mid-text insert goes after "Two " (caret at 4). */
const INSERT_AT = 4;

const log = (...args: unknown[]) => console.error("[e2e:dm]", ...args);

const pageErrors = new Map<string, string[]>();

async function open(ctx: BrowserContext, name: string, url: string): Promise<Page> {
  const page = await ctx.newPage();
  const errs: string[] = [];
  pageErrors.set(name, errs);
  await openBoard(page, url, errs);
  return page;
}

const nodeId = (page: Page) => page.evaluate(() => window.__team!.nodeId);

async function waitRtc(page: Page, peer: string): Promise<void> {
  await page.waitForFunction((id) => window.__team!.peers().some((p) => p.peerId === id && p.link === "open"), peer, { timeout: RTC_TIMEOUT_MS, polling: 250 });
}

/** Open the DM thread with `peer` and wait for its composer. */
async function openThread(page: Page, peer: string): Promise<void> {
  const row = page.locator(`[data-testid="dm-thread"][data-peer-id="${peer}"]`);
  await row.waitFor({ timeout: RTC_TIMEOUT_MS });
  await row.click();
  await page.locator(`[data-testid="dm-thread-open"][data-peer-id="${peer}"] [data-testid="dm-text"]`).waitFor({ timeout: 10_000 });
}

const liveText = (page: Page) => page.evaluate(() => document.querySelector('[data-testid="dm-live-text"]')?.textContent ?? null);

/** The text before A's caret as B draws it, or null when no caret is drawn. */
const textBeforeCaret = (page: Page) =>
  page.evaluate(() => {
    const caret = document.querySelector('[data-testid="dm-caret"]');
    if (!caret) return null;
    let s = "";
    for (const n of caret.parentElement!.childNodes) {
      if (n === caret) break;
      s += n.textContent ?? "";
    }
    return s;
  });

async function waitLive(page: Page, expected: string, what: string): Promise<void> {
  await page
    .waitForFunction((want) => document.querySelector('[data-testid="dm-live-text"]')?.textContent === want, expected, { timeout: KEY_TIMEOUT_MS, polling: 20 })
    .catch(async () => fail(`${what}: B shows ${JSON.stringify(await liveText(page))}, expected ${JSON.stringify(expected)}`));
}

/** axe-core over the chat column: serious and critical violations, one per rule and element. */
async function axeColumn(page: Page, label: string): Promise<{ serious: number; critical: number }> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    type V = { id: string; impact: string | null; help: string; nodes: { target: string[]; failureSummary?: string }[] };
    const axe = (window as unknown as { axe: { run: (ctx: Element, opts: object) => Promise<{ violations: V[] }> } }).axe;
    const res = await axe.run(document.querySelector("[data-chat-column]")!, { resultTypes: ["violations"] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[0]}`) }));
  });
  const counts = { serious: 0, critical: 0 };
  for (const v of violations) {
    if (v.impact === "serious") counts.serious += v.nodes.length;
    if (v.impact === "critical") counts.critical += v.nodes.length;
    log(`axe ${label}: ${v.impact} ${v.id} (${v.help}) ×${v.nodes.length}${v.impact === "serious" || v.impact === "critical" ? `\n     ${v.nodes.slice(0, 4).join("\n     ")}` : ""}`);
  }
  log(`axe ${label}: ${violations.length} rules violated, serious=${counts.serious} critical=${counts.critical}`);
  return counts;
}

const p50 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
};

type ServerMessages = { board: { messages: { id: string; body: string; nodeId: string }[] } };

async function scenario(stack: DevStack): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const pages: Page[] = [];
  try {
    return await run(stack, browser, pages);
  } catch (err) {
    for (const [i, p] of pages.entries()) {
      const path = join(tmpdir(), `dm-e2e-fail-${i === 0 ? "A" : "B"}.png`);
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
  let b = await open(ctxB, "B", stack.page);
  pages.push(a, b);
  const [idA, idB] = await Promise.all([nodeId(a), nodeId(b)]);
  if (!idA || !idB || idA === idB) fail(`identities: ${idA} ${idB}`);
  const boardId = await a.evaluate(() => window.__team!.boardId);
  log(`A=${idA.slice(0, 8)} B=${idB.slice(0, 8)} board=${boardId}; waiting for the data channel`);
  await Promise.all([waitRtc(a, idB), waitRtc(b, idA)]);

  // 1. Both open the thread; A types, B sees each key.
  await openThread(a, idB);
  await openThread(b, idA);
  const callsignA = (await a.evaluate(() => (window.__inversa!.state("ME") as { callsign: string }).callsign)) || idA.slice(0, 8);
  const textarea = a.locator('[data-testid="dm-text"]');
  await textarea.click();
  const samples: number[] = [];
  let streamed = 0;
  for (let i = 0; i < TEXT.length; i++) {
    const prefix = TEXT.slice(0, i + 1);
    const seen = watchFor(b, '[data-testid="dm-log"]', prefix, KEY_TIMEOUT_MS);
    const t0 = Date.now();
    await a.keyboard.press(TEXT[i] === " " ? "Space" : TEXT[i]!);
    const t1 = await seen;
    samples.push(t1 - t0);
    streamed += 1;
  }
  await waitLive(b, TEXT, "after 40 keys");
  const typingOn = await b.getAttribute('[data-testid="dm-typing"]', "data-on");
  const typingText = await b.textContent('[data-testid="dm-typing"]');
  if (typingOn !== "1" || !typingText?.includes(`${callsignA} is typing`)) fail(`B's typing line while A types: on=${typingOn} text=${JSON.stringify(typingText)}`);
  const caret0 = await textBeforeCaret(b);
  if (caret0 !== TEXT) fail(`B draws A's caret after ${JSON.stringify(caret0)}, expected the end of the text`);
  log(`40 keys streamed; per-key ms: ${samples.join(" ")} p50=${p50(samples)} p95=${p95(samples)}`);
  mkdirSync(SHOT_DIR, { recursive: true });
  await b.locator("[data-chat-column]").screenshot({ path: join(SHOT_DIR, "dm-streaming.png") });
  log("dm-streaming.png: B's thread with A's live draft, caret and typing line");
  const axe = await axeColumn(b, "DM thread, draft streaming");

  // 2. Backspace, then a key in the middle of the text.
  await a.keyboard.press("Backspace");
  await waitLive(b, TEXT.slice(0, -1), "after Backspace");
  await a.keyboard.press("t");
  await waitLive(b, TEXT, "after retyping the last key");
  await a.evaluate((at) => {
    const el = document.querySelector('[data-testid="dm-text"]') as HTMLTextAreaElement;
    el.setSelectionRange(at, at);
  }, INSERT_AT);
  await a.keyboard.press("X");
  const inserted = `${TEXT.slice(0, INSERT_AT)}X${TEXT.slice(INSERT_AT)}`;
  await waitLive(b, inserted, "after the mid-text insert");
  const caret1 = await textBeforeCaret(b);
  if (caret1 !== `${TEXT.slice(0, INSERT_AT)}X`) fail(`B draws A's caret after ${JSON.stringify(caret1)}, expected ${JSON.stringify(`${TEXT.slice(0, INSERT_AT)}X`)}`);
  await a.keyboard.press("Backspace");
  await waitLive(b, TEXT, "after removing the inserted key");
  log("backspace and mid-text insert seen on B, caret where A's is");

  // 3. Commit: one message on both sides, no draft, no typing; persisted; survives a reload.
  const seenMsg = watchFor(b, '[data-testid="dm-log"]', TEXT, 30_000);
  await a.keyboard.press("Enter");
  await seenMsg;
  for (const [name, p] of [
    ["A", a],
    ["B", b],
  ] as const) {
    await p.waitForFunction((want) => [...document.querySelectorAll('[data-testid="dm-message"]')].filter((el) => el.textContent?.includes(want)).length === 1, TEXT, { timeout: 30_000 });
    const n = await p.locator('[data-testid="dm-message"]').count();
    if (n !== 1) fail(`${name} shows ${n} messages, expected 1`);
    const from = await p.getAttribute('[data-testid="dm-message"]', "data-from");
    if (from !== idA) fail(`${name}: message author ${from}, expected ${idA}`);
  }
  // The commit frame precedes the op broadcast on the same channel; a reload-synced tab may see them a tick apart.
  await b.waitForFunction(() => document.querySelector('[data-testid="dm-live"]') === null, null, { timeout: 2_000 }).catch(() => fail("B still shows A's draft after the commit"));
  await b.waitForFunction(() => document.querySelector('[data-testid="dm-typing"]')?.getAttribute("data-on") === "0", null, { timeout: 3_500 }).catch(() => fail("B's typing line did not clear within 3 s of the commit"));
  if ((await a.inputValue('[data-testid="dm-text"]')) !== "") fail("A's composer did not clear after Enter");
  log("committed: one message on both sides, draft and typing gone");

  const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
  let persisted = false;
  while (Date.now() < deadline && !persisted) {
    const { board } = await stack.graphql<ServerMessages>(`query { board(id: ${JSON.stringify(boardId)}) { messages { id body nodeId } } }`);
    persisted = board.messages.some((m) => m.body === TEXT && m.nodeId === idA);
    if (!persisted) await sleep(500);
  }
  if (!persisted) fail("Axum's board has no message with the text");
  log("persisted on Axum");

  await b.close();
  b = await open(ctxB, "B2", stack.page);
  pages[1] = b;
  // Keyboard only this time: focus the thread row, Enter opens it, the composer takes focus, a reply goes with Enter.
  const row = b.locator(`[data-testid="dm-thread"][data-peer-id="${idA}"]`);
  await row.waitFor({ timeout: RTC_TIMEOUT_MS });
  await row.focus();
  await b.keyboard.press("Enter");
  await b.locator(`[data-testid="dm-thread-open"][data-peer-id="${idA}"] [data-testid="dm-text"]`).waitFor({ timeout: 10_000 });
  if (!(await b.evaluate(() => document.activeElement?.getAttribute("data-testid") === "dm-text"))) fail("the composer did not take focus when the thread opened from the keyboard");
  await b.waitForFunction((want) => [...document.querySelectorAll('[data-testid="dm-message"]')].some((el) => el.textContent?.includes(want)), TEXT, { timeout: CONVERGE_TIMEOUT_MS });
  if ((await b.locator('[data-testid="dm-message"]').count()) !== 1) fail("B after reload shows a different number of messages than 1");
  const seenReply = watchFor(a, '[data-testid="dm-log"]', "Copy that", 30_000);
  await b.keyboard.type("Copy that");
  await b.keyboard.press("Enter");
  await seenReply;
  await a.waitForFunction(() => document.querySelectorAll('[data-testid="dm-message"]').length === 2, null, { timeout: 30_000 });
  log("B reloaded and still has the message; replied from the keyboard, A has both");

  // 4. B leaves: A's thread shows B as away.
  await waitRtc(a, idB);
  await b.close();
  await a.waitForFunction(() => document.querySelector('[data-testid="dm-presence"]')?.textContent === "away", null, { timeout: RTC_TIMEOUT_MS, polling: 250 }).catch(() => fail("A never showed B as away after B left"));
  log("B gone: A shows the thread as away");

  const fatal = [...pageErrors.entries()].flatMap(([n, errs]) => errs.filter((e) => /\[rtc\]|\[team\]|\[missions\]|\[messages\]|Uncaught/.test(e)).map((e) => `${n}: ${e}`));
  if (fatal.length) fail(`page errors:\n${fatal.join("\n")}`);

  return [
    `DM chars_streamed=${streamed}/${TEXT.length} p50_ms=${p50(samples)} p95_ms=${p95(samples)} backspace=ok insert=ok persist=ok reload=ok typing=ok presence=ok`,
    `DM-AXE serious=${axe.serious} critical=${axe.critical} keyboard=ok`,
  ];
}

async function main(): Promise<number> {
  let stack: DevStack | null = null;
  try {
    stack = await startDevStack("dm");
    const lines = await scenario(stack);
    for (const l of lines) console.log(l);
    return 0;
  } catch (err) {
    for (const p of stack?.procs ?? []) console.log(`---- ${p.name} log ----\n${tail(p)}`);
    for (const [name, errs] of pageErrors) if (errs.length) console.log(`---- page ${name} errors ----\n${errs.slice(-20).join("\n")}`);
    console.log(`DM-FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await stack?.stop();
  }
}

const code = await main();
process.exit(code);
