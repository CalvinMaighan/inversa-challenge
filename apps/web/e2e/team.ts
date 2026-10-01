/**
 * Team realtime browser gates (gates/leaf-T21.md G2, G3; docs/perf.md) against a real stack on free ports, so
 * `applyOps`, `opsSince` and the `ops` subscription are the production code:
 *
 *   bun run e2e:team                 the shared stack (e2e/stack.ts): the production e2e build under `next start`,
 *                                    which needs no `next dev` lock, so it runs beside a developer's `bun run dev`
 *   E2E_TEAM_STACK=dev bun run e2e:team   e2e/dev-stack.ts: `next dev` (fails while another `next dev` holds
 *                                    apps/web's dev lock)
 *   E2E_SKIP_BUILD=1 …               reuse the last e2e build (shared stack)
 *
 * Both stacks run `wrangler dev --local` for the signal Worker and a real Axum (INVERSA_SOURCES=off).
 *
 * Two Playwright contexts (separate storage: two identities, two db workers, one WebRTC mesh) open the ops page
 * and switch the chat column to its Notes tab, where the crew missions sit behind a disclosure (T43). A edits
 * through the panel, B is watched by a MutationObserver; both timestamps come from the same machine clock. First,
 * A's own chat log: an optimistic local edit must be in the DOM before the next animation frame after the submit
 * (PRD §13 "same frame"). Then 20 chat lines over RTC, then 20 more with peer traffic blocked (`window.__team.blockRtc`) so they ride
 * applyOps → Axum → the WebSocket. Then concurrent removal logging from both contexts must sum, and an edit made
 * while B is offline must converge after it reconnects.
 *
 * Prints `TEAM local_same_frame=<n>/<n> local_p50=<ms> rtc_p50=<ms> rtc_p95=<ms> ws_p50=<ms> ws_p95=<ms> converged=1`
 * and `COUNTERS-OK OFFLINE-OK` on success.
 */
import { chromium, type BrowserContext, type Page } from "playwright";

import { fail, openBoard, openCrewMissions, sleep, startDevStack, tail, watchFor } from "./dev-stack";
import { buildApi, buildWeb, startStack } from "./stack";

/** What the scenario needs from either stack. */
type TeamStack = {
  /** The ops page. */
  page: string;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Process log tails, for failures. */
  logs(): string;
  stop(): Promise<void>;
};

async function startTeamStack(): Promise<TeamStack> {
  if (process.env.E2E_TEAM_STACK === "dev") {
    const dev = await startDevStack("team");
    return { page: dev.page, graphql: dev.graphql, logs: () => dev.procs.map((p) => `---- ${p.name} log ----\n${tail(p)}`).join("\n"), stop: dev.stop };
  }
  buildApi(log);
  buildWeb(log);
  const stack = await startStack({ name: "team" });
  return { page: `${stack.origin}/`, graphql: stack.graphql, logs: stack.logs, stop: stack.stop };
}

const EDITS = 20;
const REMOVALS_EACH = 5;
const RTC_TIMEOUT_MS = 90_000;
const CONVERGE_TIMEOUT_MS = 60_000;

const log = (...args: unknown[]) => console.error("[e2e:team]", ...args);

// ---- page helpers -----------------------------------------------------------------------------------

// `window.__team` is declared by client/hud/missions/team.ts (the same tsconfig program).
declare global {
  interface Window {
    __t0?: number;
    __local?: { at: number; inFrame: boolean } | null;
  }
}

const pageErrors = new Map<string, string[]>();
/** Pages whose browser refused to transfer the RTCDataChannel and relayed through main instead. */
const relayed = new Set<string>();

async function open(ctx: BrowserContext, name: string, url: string): Promise<Page> {
  const page = await ctx.newPage();
  const errs: string[] = [];
  pageErrors.set(name, errs);
  await openBoard(page, url, errs, (text) => {
    if (/relaying through main/.test(text)) relayed.add(name);
  });
  await openCrewMissions(page);
  return page;
}

const nodeId = (page: Page) => page.evaluate(() => window.__team!.nodeId);

async function waitRtc(page: Page, peer: string): Promise<void> {
  await page.waitForFunction((id) => window.__team!.peers().some((p) => p.peerId === id && p.link === "open"), peer, { timeout: RTC_TIMEOUT_MS, polling: 250 });
}

/** Type into the chat box and press Enter; `__t0` is stamped by a capture-phase submit listener in the page. */
async function sayViaUi(page: Page, text: string): Promise<number> {
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="chat-input"]')!.closest("form")!;
    form.addEventListener("submit", () => (window.__t0 = Date.now()), { capture: true, once: true });
  });
  await page.fill('[data-testid="chat-input"]', text);
  await page.press('[data-testid="chat-input"]', "Enter");
  return page.evaluate(() => window.__t0!);
}

/**
 * Optimistic local edit: at submit (capture phase), arm a MutationObserver on the sender's own chat log and a
 * `requestAnimationFrame` callback. rAF callbacks run before the frame is painted, so the edit is "same frame"
 * when the line is already in the DOM by then. Returns the DOM latency (performance.now, ms) and that verdict.
 */
async function sayLocal(page: Page, text: string): Promise<{ ms: number; inFrame: boolean }> {
  await page.evaluate((want) => {
    window.__local = null;
    const form = document.querySelector('[data-testid="chat-input"]')!.closest("form")!;
    const log = document.querySelector('[data-testid="chat-log"]')!;
    const has = () => (log.textContent ?? "").includes(want);
    form.addEventListener(
      "submit",
      () => {
        const t0 = performance.now();
        let at: number | null = null;
        const mo = new MutationObserver(() => {
          if (at === null && has()) at = performance.now() - t0;
        });
        mo.observe(log, { subtree: true, childList: true, characterData: true });
        requestAnimationFrame(() => {
          const inFrame = has();
          if (at === null && inFrame) at = performance.now() - t0;
          const settle = () => {
            if (at === null && !has()) return void setTimeout(settle, 1);
            mo.disconnect();
            window.__local = { at: at ?? performance.now() - t0, inFrame };
          };
          settle();
        });
      },
      { capture: true, once: true },
    );
  }, text);
  await page.fill('[data-testid="chat-input"]', text);
  await page.press('[data-testid="chat-input"]', "Enter");
  const r = await page.waitForFunction(() => window.__local ?? null, null, { timeout: 10_000 });
  const v = (await r.jsonValue()) as { at: number; inFrame: boolean };
  return { ms: v.at, inFrame: v.inFrame };
}

async function measure(a: Page, b: Page, tag: string): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < EDITS; i++) {
    const text = `${tag}-${i}-${Math.random().toString(36).slice(2, 6)}`;
    const seen = watchFor(b, '[data-testid="chat-log"]', text);
    const t0 = await sayViaUi(a, text);
    const t1 = await seen;
    samples.push(t1 - t0);
  }
  return samples;
}

const p50 = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};
const p95 = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
};

async function board(page: Page) {
  return (await page.evaluate(() => window.__team!.board()))!;
}

async function waitBoard(page: Page, pred: (b: Awaited<ReturnType<typeof board>>) => boolean, what: string, timeoutMs = CONVERGE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const b = await board(page);
    last = b;
    if (pred(b)) return;
    await sleep(200);
  }
  fail(`${what}: ${JSON.stringify(last).slice(0, 600)}`);
}

type ServerBoard = { board: { missions: { id: string; fields: Record<string, unknown> }[]; messages: { body: string }[]; removals: Record<string, number> } };

const serverBoard = (stack: TeamStack) => stack.graphql<ServerBoard>('query { board(id: "everglades") { missions { id fields } messages { body } removals } }').then((d) => d.board);

// ---- scenario ---------------------------------------------------------------------------------------

async function scenario(stack: TeamStack): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const a = await open(ctxA, "A", stack.page);
    const b = await open(ctxB, "B", stack.page);
    const [idA, idB] = await Promise.all([nodeId(a), nodeId(b)]);
    if (!idA || !idB || idA === idB) fail(`identities: ${idA} ${idB}`);
    log(`A=${idA.slice(0, 8)} B=${idB.slice(0, 8)}; waiting for the data channel`);
    await Promise.all([waitRtc(a, idB), waitRtc(b, idA)]);
    log(`rtc open both ways; channel ${relayed.size ? `relayed through main on ${[...relayed].join(",")}` : "transferred to the rtc worker"}`);

    // A mission from a hotspot cell, through the real form: B must see it.
    const at = Date.now() - 3_600_000;
    await a.evaluate((id) => window.__team!.select(id), `hotspot:python:120:80:${at}`);
    await a.waitForSelector('[data-testid="mission-form"]');
    const cell = await a.textContent('[data-testid="mission-cell"]');
    if (cell !== "120:80") fail(`form cell: ${cell}`);
    await a.fill('[data-testid="mission-title"]', "Python sweep 120:80");
    await a.click('[data-testid="mission-create"]');
    await waitBoard(a, (m) => m.missions.some((x) => x.title === "Python sweep 120:80"), "mission on A");
    await waitBoard(b, (m) => m.missions.some((x) => x.title === "Python sweep 120:80"), "mission on B");
    const missionId = (await board(a)).missions.find((x) => x.title === "Python sweep 120:80")!.id;
    await b.waitForSelector(`[data-mission-id="${missionId}"]`);
    log(`mission ${missionId.slice(0, 8)} on both`);

    // Optimistic local edit: in A's own log before A's next frame.
    const local: { ms: number; inFrame: boolean }[] = [];
    for (let i = 0; i < EDITS; i++) local.push(await sayLocal(a, `local-${i}-${Math.random().toString(36).slice(2, 6)}`));
    const localMs = local.map((x) => Number(x.ms.toFixed(1)));
    const sameFrame = local.filter((x) => x.inFrame).length;
    log(`local samples ms: ${localMs.join(" ")} same_frame=${sameFrame}/${EDITS}`);

    // Latency over RTC: A types in the chat, B's chat log changes.
    const rtc = await measure(a, b, "rtc");
    const rtcP50 = p50(rtc);
    log(`rtc samples ms: ${rtc.join(" ")} p50=${rtcP50} p95=${p95(rtc)}`);

    // Latency over the WebSocket: peer traffic blocked on both sides.
    await Promise.all([a, b].map((p) => p.evaluate(() => window.__team!.blockRtc(true))));
    const ws = await measure(a, b, "ws");
    const wsP50 = p50(ws);
    log(`ws samples ms: ${ws.join(" ")} p50=${wsP50} p95=${p95(ws)}`);

    // Concurrent removals, still over the WebSocket: a grow-only counter per node must sum on both sides.
    for (const p of [a, b]) {
      // A focused the mission when it created it; B has it collapsed.
      if ((await p.$(`[data-mission-id="${missionId}"] [data-testid="removal-add"]`)) === null) await p.click(`[data-mission-id="${missionId}"] button[aria-expanded="false"]`);
      await p.waitForSelector(`[data-mission-id="${missionId}"] [data-testid="removal-add"]`);
    }
    const clicks = async (p: Page) => {
      for (let i = 0; i < REMOVALS_EACH; i++) await p.click(`[data-mission-id="${missionId}"] [data-testid="removal-add"]`);
    };
    await Promise.all([clicks(a), clicks(b)]);
    const expected = 2 * REMOVALS_EACH;
    await waitBoard(a, (m) => m.removals[missionId] === expected, `A removals=${expected}`);
    await waitBoard(b, (m) => m.removals[missionId] === expected, `B removals=${expected}`);
    for (const [name, p] of [
      ["A", a],
      ["B", b],
    ] as const) {
      const shown = await p.textContent(`[data-mission-id="${missionId}"] [data-testid="removal-total"]`);
      if (shown !== String(expected)) fail(`${name} shows removal total ${shown}, expected ${expected}`);
      const overall = await p.textContent('[data-testid="totals-overall"]');
      if (overall !== String(expected)) fail(`${name} overall total ${overall}, expected ${expected}`);
    }
    const server1 = await serverBoard(stack);
    if (server1.removals[missionId] !== expected) fail(`server removals ${JSON.stringify(server1.removals)}`);
    log(`counters: ${expected} on A, B and the server`);

    // Offline: B edits while cut off (WebSocket and HTTP), A edits too, then B reconnects and both converge.
    await ctxB.setOffline(true);
    await b.selectOption(`[data-mission-id="${missionId}"] [data-testid="mission-status"]`, "in_progress");
    await waitBoard(b, (m) => m.missions.find((x) => x.id === missionId)?.status === "in_progress", "B local status");
    await sayViaUi(a, "while-B-was-offline");
    await sayViaUi(b, "from-offline-B");
    await sleep(1_500);
    if ((await board(a)).missions.find((x) => x.id === missionId)?.status === "in_progress") fail("A saw B's offline edit before B reconnected");
    await ctxB.setOffline(false);
    await waitBoard(a, (m) => m.missions.find((x) => x.id === missionId)?.status === "in_progress" && m.messages.some((x) => x.body === "from-offline-B"), "A converged after B reconnected");
    await waitBoard(b, (m) => m.messages.some((x) => x.body === "while-B-was-offline"), "B caught up on A's edit");
    const [fa, fb] = await Promise.all([board(a), board(b)]);
    const canon = (x: Awaited<ReturnType<typeof board>>) => JSON.stringify({ m: x.missions, r: x.removals, msgs: x.messages.map((y) => y.id).sort() });
    if (canon(fa) !== canon(fb)) fail(`boards differ after reconnect:\nA ${canon(fa)}\nB ${canon(fb)}`);
    const server2 = await serverBoard(stack);
    if (server2.missions.find((x) => x.id === missionId)?.fields.status !== "in_progress") fail("server did not get B's offline status change");
    if (server2.messages.length !== fa.messages.length) fail(`server has ${server2.messages.length} messages, clients ${fa.messages.length}`);
    log("offline edit converged on A, B and the server");

    const fatal = [...pageErrors.entries()].flatMap(([n, errs]) => errs.filter((e) => /\[rtc\]|\[team\]|\[missions\]|Uncaught/.test(e)).map((e) => `${n}: ${e}`));
    if (fatal.length) fail(`page errors:\n${fatal.join("\n")}`);

    return [
      `TEAM local_same_frame=${sameFrame}/${EDITS} local_p50=${p50(localMs)} rtc_p50=${rtcP50} rtc_p95=${p95(rtc)} ws_p50=${wsP50} ws_p95=${p95(ws)} converged=1`,
      "COUNTERS-OK OFFLINE-OK",
    ];
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  let stack: TeamStack | null = null;
  try {
    stack = await startTeamStack();
    const lines = await scenario(stack);
    for (const l of lines) console.log(l);
    return 0;
  } catch (err) {
    if (stack) console.log(stack.logs());
    for (const [name, errs] of pageErrors) if (errs.length) console.log(`---- page ${name} errors ----\n${errs.slice(-20).join("\n")}`);
    console.log(`TEAM-FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await stack?.stop();
  }
}

const code = await main();
process.exit(code);
