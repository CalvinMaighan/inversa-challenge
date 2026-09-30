/**
 * Live agent eval: the golden questions go to the real agent (GPT-6 Luna on
 * OpenRouter) with its tools answering from the fixture GraphQL stub.
 *
 *   bun run eval      (wraps `doppler run --project inversa --config dev`, which supplies OPENROUTER_API_KEY)
 *
 * Checks per question: the expected tools ran, every citation (events and
 * final text) names evidence a tool returned in that turn, enough citations,
 * required phrases, the C7 stream shape. Last two lines:
 * `EVAL quality passed q/5` and `EVAL passed P/T`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GOLDEN, type Golden } from "./golden";
import { FIXTURE_NOW, startStub } from "./stub-server";
import { checkViews } from "./views";

import { REGION_BBOX } from "@/server/agent/config";
import { resetHarness } from "@/server/agent/cordis/boot";
import { citedIds } from "@/server/agent/cordis/citations";
import { runTurn, type RunTurnResult } from "@/server/agent/run-turn";
import { AGENT_MODEL_ID, MISSING_KEY_MESSAGE, openRouterApiKey } from "@/server/agent/runtime/model";
import type { Evidence } from "@/server/agent/runtime/registry";
import { isAgentStreamEvent, type AgentStreamEvent } from "@/shared/agent/events";

/** OpenRouter list price for GPT-6 Luna, USD per million tokens. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
/** Questions in flight at once. */
const CONCURRENCY = 3;

function check(golden: Golden, events: AgentStreamEvent[]): { reasons: string[]; tools: string[]; cited: string[] } {
  const reasons: string[] = [];
  if (!events.every(isAgentStreamEvent)) reasons.push("stream has an event outside the C7 union");
  const done = events.filter((event) => event.type === "done");
  if (done.length !== 1 || events.at(-1)?.type !== "done") reasons.push("stream must end with exactly one done event");
  for (const event of events) if (event.type === "error") reasons.push(`error event: ${event.message}`);

  const tools = events.flatMap((event) => (event.type === "tool_start" ? [event.capabilityName] : []));
  for (const tool of golden.expect.tools) if (!tools.includes(tool)) reasons.push(`tool not called: ${tool}`);

  const returned = new Set(
    events.flatMap((event) =>
      event.type === "tool_end" && event.ok ? ((event.data as { evidence?: Evidence[] } | undefined)?.evidence ?? []).map((row) => row.id) : [],
    ),
  );
  for (const event of events) {
    if (event.type === "citation" && !returned.has(event.id)) reasons.push(`citation event for unreturned id ${event.id}`);
  }
  const content = done[0]?.type === "done" ? done[0].content : "";
  const cited = [...new Set(citedIds(content))];
  for (const id of cited) if (!returned.has(id)) reasons.push(`final text cites unreturned id ${id}`);
  if (cited.length < golden.expect.minCitations) {
    reasons.push(`${cited.length} citations, need ${golden.expect.minCitations}`);
  }
  for (const [kind, need] of Object.entries(golden.expect.cites ?? {})) {
    const got = cited.filter((id) => id.startsWith(`${kind}:`)).length;
    if (got < need) reasons.push(`${got} ${kind} citations, need ${need}`);
  }
  for (const phrase of golden.expect.phrases) if (!phrase.test(content)) reasons.push(`missing phrase ${phrase}`);
  if (golden.expect.view && !events.some((event) => event.type === "view")) reasons.push("no view event");
  return { reasons, tools, cited };
}

type Outcome = { golden: Golden; events: AgentStreamEvent[]; result: RunTurnResult; ms: number };

async function main(): Promise<number> {
  // EVAL_ONLY=id,id runs a subset while iterating; the gate runs all of them.
  const only = process.env.EVAL_ONLY?.split(",").map((id) => id.trim()).filter(Boolean);
  const questions = only?.length ? GOLDEN.filter((golden) => only.includes(golden.id)) : GOLDEN;
  const total = questions.length;
  const qualityTotal = questions.filter((golden) => golden.quality).length;
  if (!openRouterApiKey()) {
    console.log(`EVAL ${MISSING_KEY_MESSAGE} (run it through \`bun run eval\`, which wraps doppler)`);
    console.log(`EVAL quality passed 0/${qualityTotal}`);
    console.log(`EVAL passed 0/${total}`);
    return 1;
  }

  const stub = startStub();
  const dataDir = mkdtempSync(join(tmpdir(), "inversa-eval-"));
  process.env.INVERSA_API_ORIGIN = stub.origin;
  process.env.INVERSA_DATA_DIR = dataDir;
  const now = new Date(FIXTURE_NOW);
  const view = { bbox: { ...REGION_BBOX }, time: FIXTURE_NOW, layers: ["sightings", "hotspots"], selection: null };

  console.log(`EVAL model=${AGENT_MODEL_ID} questions=${total} fixture=${FIXTURE_NOW}`);
  const outcomes: Outcome[] = [];
  try {
    const queue = [...questions];
    const worker = async () => {
      for (let golden = queue.shift(); golden; golden = queue.shift()) {
        const events: AgentStreamEvent[] = [];
        const started = Date.now();
        const result = await runTurn(
          { sessionId: `eval-${golden.id}-${started}`, question: golden.question, view, now, cache: false },
          (event) => events.push(event),
        );
        outcomes.push({ golden, events, result, ms: Date.now() - started });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    await resetHarness();
    stub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }

  let passed = 0;
  let qualityPassed = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let viewsValid = 0;
  let viewsTotal = 0;
  for (const golden of questions) {
    const outcome = outcomes.find((row) => row.golden === golden)!;
    const { reasons, tools, cited } = check(golden, outcome.events);
    // C17: every successful data tool call carries a ToolResultData with a view for the card.
    const views = checkViews(outcome.events);
    viewsValid += views.valid;
    viewsTotal += views.total;
    reasons.push(...views.reasons);
    const ok = reasons.length === 0;
    if (ok) passed += 1;
    if (ok && golden.quality) qualityPassed += 1;
    tokensIn += outcome.result.usage.promptTokens + outcome.result.usage.cacheRead;
    tokensOut += outcome.result.usage.completionTokens;
    const tag = golden.quality ? " [quality]" : "";
    console.log(`${ok ? "PASS" : "FAIL"} ${golden.id}${tag} tools=${tools.join(",") || "-"} citations=${cited.length} ${outcome.ms}ms`);
    for (const reason of reasons) console.log(`     - ${reason}`);
    if (process.env.EVAL_VERBOSE) {
      for (const event of outcome.events) {
        if (event.type === "tool_start") console.log(`     $ ${event.capabilityName} ${JSON.stringify(event.args)}`);
        if (event.type === "tool_end") {
          const data = event.data as { count?: number; feeds?: { source: string; state: string }[] } | undefined;
          const feeds = (data?.feeds ?? []).map((feed) => `${feed.source}:${feed.state}`).join(",");
          console.log(`     = ${event.capabilityName} ok=${event.ok} count=${data?.count ?? "-"} feeds=${feeds} ${event.error ?? ""}`);
        }
      }
    }
    if (process.env.EVAL_VERBOSE || !ok) {
      const done = outcome.events.at(-1);
      console.log(`     > ${done?.type === "done" ? done.content.replace(/\n+/g, " ") : "(no done event)"}`);
    }
  }
  // Cache reads are billed below list price, so this is an upper bound.
  const cost = (tokensIn * PRICE_IN + tokensOut * PRICE_OUT) / 1_000_000;
  console.log(`EVAL tokens in=${tokensIn} out=${tokensOut} cost<=$${cost.toFixed(4)}`);
  console.log(`EVAL views valid ${viewsValid}/${viewsTotal}`);
  console.log(`EVAL quality passed ${qualityPassed}/${qualityTotal}`);
  console.log(`EVAL passed ${passed}/${total}`);
  return passed === total ? 0 : 1;
}

process.exit(await main());
