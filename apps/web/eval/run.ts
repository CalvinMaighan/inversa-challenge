/**
 * Live agent eval: the golden questions go to the real agent (GPT-6 Luna on
 * OpenRouter) with its tools answering from the fixture GraphQL stub.
 *
 *   bun run eval              (wraps `doppler run --project inversa --config dev`, which supplies OPENROUTER_API_KEY)
 *   bun run eval -- --app=carp   (or --app carp, or EVAL_APP=carp): that app's persona, tools and golden set; default python
 *   bun run eval -- --app carp --holdout   the held-out set (spec/apps/questions/carp.holdout.json) instead
 *
 * The benchmark is blind: the agent gets the question, the view and its own rules, never the golden tools,
 * wording or citations (tests/server/agent/no-answer-key.test.ts). Checks per question (eval/check.ts): the
 * expected tools ran, every citation (events and final text) names evidence a tool returned in that turn,
 * enough citations by count, kind and feed, required and forbidden phrases, every number in the answer traces
 * to a tool output, feed state is disclosed, the C7 stream shape, and the C17 views. Lines the grader parses
 * (docs/grading/rubric.md):
 *   EVAL app=<id> model=<id> questions=<N>
 *   EVAL category <c> passed P/T pct=<n>   (one per category, when the set has categories)
 *   EVAL ungrounded=<n> checked=<n>
 *   EVAL passed P/T pct=<n>
 *   EVAL bars overall>=95 category>=90 boundary=100 ungrounded=0 met=yes|no
 * Exit 0 only when the bars are met: a stochastic model is held to a rate, not to 100% (rubric.md).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BARS, barsMet, checkQuestion, pct } from "./check";
import { CATEGORIES, GOLDEN_SETS, type Golden } from "./golden";
import { fixtureNow, startStub } from "./stub-server";
import { checkViews } from "./views";

import { capturing, type ToolCapture } from "@/server/agent/answer-check";
import { resetHarness } from "@/server/agent/cordis/boot";
import { runTurn, type RunTurnResult } from "@/server/agent/run-turn";
import { AGENT_MODEL_ID, MISSING_KEY_MESSAGE, openRouterApiKey } from "@/server/agent/runtime/model";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import type { AgentStreamEvent, AgentStreamRequest } from "@/shared/agent/events";
import { APP_IDS, appBBox, appLayerIds, getApp, isAppId, type AppId } from "@/shared/apps";

/** OpenRouter list price for GPT-6 Luna, USD per million tokens. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
/** Questions in flight at once. */
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4);

type Outcome = { golden: Golden; events: AgentStreamEvent[]; result: RunTurnResult; captures: ToolCapture[]; ms: number };

/** `--app=<id>` or `--app <id>` beats `EVAL_APP`; python by default. */
export function evalApp(argv: readonly string[], env: Record<string, string | undefined>): AppId {
  const eq = argv.find((a) => a.startsWith("--app="))?.slice("--app=".length);
  const at = argv.indexOf("--app");
  const raw = eq ?? (at >= 0 ? argv[at + 1] : undefined) ?? env.EVAL_APP ?? "python";
  if (!isAppId(raw)) throw new Error(`unknown app "${raw}" (apps: ${APP_IDS.join(", ")})`);
  return raw;
}

/** The question's `context` as view state: the selected site, a knowledge time, a replay flag. */
function viewFor(base: NonNullable<AgentStreamRequest["view"]>, golden: Golden): NonNullable<AgentStreamRequest["view"]> {
  const context = golden.context ?? {};
  const asOf = context.asOf ? Date.parse(context.asOf) : NaN;
  return {
    ...base,
    ...(context.selectedSite ? { site: context.selectedSite } : {}),
    ...(Number.isFinite(asOf) ? { asOf, replay: true, time: new Date(asOf).toISOString() } : {}),
    ...(context.replay === "true" ? { replay: true } : {}),
  };
}

async function main(): Promise<number> {
  const app = getApp(evalApp(process.argv.slice(2), process.env));
  const set = process.argv.includes("--holdout") ? `${app.eval.goldenSet}-holdout` : app.eval.goldenSet;
  const golden = GOLDEN_SETS[set] ?? [];
  // EVAL_ONLY=id,id runs a subset while iterating; EVAL_CATEGORY=c one category; the gate runs all of them.
  const only = process.env.EVAL_ONLY?.split(",").map((id) => id.trim()).filter(Boolean);
  const category = process.env.EVAL_CATEGORY?.trim();
  const questions = golden.filter((g) => (!only?.length || only.includes(g.id)) && (!category || g.category === category));
  const total = questions.length;
  const categories = [...new Set(questions.map((g) => g.category).filter((c): c is string => !!c))].sort((a, b) => CATEGORIES.indexOf(a as (typeof CATEGORIES)[number]) - CATEGORIES.indexOf(b as (typeof CATEGORIES)[number]));
  const qualityTotal = questions.filter((g) => g.quality).length;
  const fixture = fixtureNow(app.id);
  console.log(`EVAL app=${app.id} set=${set} model=${AGENT_MODEL_ID} questions=${total} fixture=${fixture}`);
  if (total === 0) {
    console.log(`EVAL no questions in set ${set}`);
    return 1;
  }
  if (!openRouterApiKey()) {
    console.log(`EVAL ${MISSING_KEY_MESSAGE} (run it through \`bun run eval\`, which wraps doppler)`);
    for (const c of categories) console.log(`EVAL category ${c} passed 0/${questions.filter((g) => g.category === c).length} pct=0`);
    console.log("EVAL ungrounded=0 checked=0");
    console.log(`EVAL quality passed 0/${qualityTotal}`);
    console.log(`EVAL passed 0/${total} pct=0`);
    console.log(`EVAL bars overall>=${BARS.overall} category>=${BARS.category} boundary=${BARS.boundary} ungrounded=${BARS.ungrounded} met=no`);
    return 1;
  }

  const stub = startStub();
  const dataDir = mkdtempSync(join(tmpdir(), "inversa-eval-"));
  process.env.INVERSA_API_ORIGIN = stub.origin;
  process.env.INVERSA_DATA_DIR = dataDir;
  const now = new Date(fixture);
  const layers = appLayerIds(app).filter((l) => l === "sightings" || l === "hotspots" || l === "stations" || l === "alerts");
  const baseView = { bbox: appBBox(app), time: fixture, layers, selection: null };

  const outcomes: Outcome[] = [];
  const startedAll = Date.now();
  try {
    const queue = [...questions];
    const worker = async () => {
      for (let g = queue.shift(); g; g = queue.shift()) {
        const events: AgentStreamEvent[] = [];
        const captures: ToolCapture[] = [];
        const started = Date.now();
        const result = await runTurn(
          { app: app.id, sessionId: `eval-${g.id}-${started}`, question: g.question, view: viewFor(baseView, g), now, cache: false, registry: capturing(buildAgentRegistry(app), captures) },
          (event) => events.push(event),
        );
        outcomes.push({ golden: g, events, result, captures, ms: Date.now() - started });
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
  let cacheRead = 0;
  let viewsValid = 0;
  let viewsTotal = 0;
  let ungrounded = 0;
  let checked = 0;
  const byCategory = new Map<string, { passed: number; total: number }>();
  for (const g of questions) {
    const outcome = outcomes.find((row) => row.golden === g)!;
    const { reasons, tools, cited, trace } = checkQuestion(g, outcome.events, outcome.captures);
    const views = checkViews(outcome.events);
    viewsValid += views.valid;
    viewsTotal += views.total;
    reasons.push(...views.reasons);
    ungrounded += trace.ungrounded.length;
    checked += trace.checked;
    const ok = reasons.length === 0;
    if (ok) passed += 1;
    if (ok && g.quality) qualityPassed += 1;
    if (g.category) {
      const row = byCategory.get(g.category) ?? { passed: 0, total: 0 };
      row.total += 1;
      if (ok) row.passed += 1;
      byCategory.set(g.category, row);
    }
    tokensIn += outcome.result.usage.promptTokens + outcome.result.usage.cacheRead;
    cacheRead += outcome.result.usage.cacheRead;
    tokensOut += outcome.result.usage.completionTokens;
    const tag = g.quality ? " [quality]" : "";
    console.log(`${ok ? "PASS" : "FAIL"} ${g.id}${tag} tools=${tools.join(",") || "-"} citations=${cited.length} numbers=${trace.checked} ${outcome.ms}ms`);
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
  // cache_read is the part of `in` the provider served from its prompt cache (system prompt and tool definitions).
  console.log(`EVAL tokens in=${tokensIn} cache_read=${cacheRead} out=${tokensOut} cost<=$${cost.toFixed(4)} wall=${Math.round((Date.now() - startedAll) / 1000)}s finished=${new Date().toISOString()}`);
  console.log(`EVAL views valid ${viewsValid}/${viewsTotal}`);
  for (const c of categories) {
    const row = byCategory.get(c) ?? { passed: 0, total: 0 };
    console.log(`EVAL category ${c} passed ${row.passed}/${row.total} pct=${pct(row.passed, row.total)}`);
  }
  console.log(`EVAL ungrounded=${ungrounded} checked=${checked}`);
  console.log(`EVAL quality passed ${qualityPassed}/${qualityTotal}`);
  console.log(`EVAL passed ${passed}/${total} pct=${pct(passed, total)}`);
  const met = barsMet(passed, total, byCategory, ungrounded);
  console.log(`EVAL bars overall>=${BARS.overall} category>=${BARS.category} boundary=${BARS.boundary} ungrounded=${BARS.ungrounded} met=${met ? "yes" : "no"}`);
  return met ? 0 : 1;
}

process.exit(await main());
