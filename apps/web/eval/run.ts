/**
 * Live agent eval: the golden questions go to the real agent (GPT-6 Luna on
 * OpenRouter) with its tools answering from the fixture GraphQL stub.
 *
 *   bun run eval              (wraps `doppler run --project inversa --config dev`, which supplies OPENROUTER_API_KEY)
 *   bun run eval -- --app=carp   (or --app carp, or EVAL_APP=carp): that app's persona, tools and golden set; default python
 *   bun run eval -- --app carp --holdout   the held-out set (spec/apps/questions/carp.holdout.json) instead
 *   bun run eval -- --app carp --runs 3    the benchmark three times, pooled (gates/leaf-J1.md)
 *
 * The benchmark is blind: the agent gets the question, the view and its own rules, never the golden tools,
 * wording or citations (tests/server/agent/no-answer-key.test.ts). Checks per question (eval/check.ts): the
 * expected tools ran, every citation (events and final text) names evidence a tool returned in that turn,
 * enough citations by count, kind and feed, forbidden phrases, every number in the answer traces
 * to a tool output, feed state is disclosed, the C7 stream shape, and the C17 views; plus the `mustSay`
 * statements, judged semantically by an independent model with the quote rule (eval/judge.ts). Lines the grader
 * parses (docs/grading/rubric.md), per run and then pooled over the runs:
 *   EVAL app=<id> model=<id> questions=<N>
 *   EVAL category <c> passed P/T pct=<n>   (one per category, when the set has categories)
 *   EVAL ungrounded=<n> checked=<n>
 *   EVAL passed P/T pct=<n>
 *   EVAL bars overall>=95 category>=90 boundary=100 ungrounded=0 met=yes|no
 *   EVAL pooled app=<id> runs=<n> passed P/T pct=<n>
 *   EVAL pooled category <c> passed P/T pct=<n>
 *   EVAL pooled ungrounded=<n> checked=<n>
 *   EVAL pooled bars overall>=95 category>=90 boundary=100each ungrounded=0 met=yes|no
 * Exit 0 only when the pooled bars are met: a stochastic model is held to a rate over several runs, not to 100%
 * of one run (rubric.md). Boundary 100% and ungrounded=0 stay strict in every run.
 */

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evalApp, evalRuns } from "./args";
import { BARS, barsMet, checkQuestion, pct, pool, pooledBarsUnmet, type RunTally } from "./check";
import { CATEGORIES, GOLDEN_SETS, holdoutSet, type Golden } from "./golden";
import { JUDGE_MODEL_ID, judgeCost, judgeMustSay, type JudgeResult } from "./judge";
import { fixtureNow, fixtureSelection, startStub } from "./stub-server";
import { checkViews } from "./views";

import { capturing, plainQuotes, type ToolCapture } from "@/server/agent/answer-check";
import { resetHarness } from "@/server/agent/cordis/boot";
import { runTurn, type RunTurnResult } from "@/server/agent/run-turn";
import { AGENT_MODEL_ID, MISSING_KEY_MESSAGE, openRouterApiKey } from "@/server/agent/runtime/model";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import type { AgentStreamEvent, AgentStreamRequest } from "@/shared/agent/events";
import { appBBox, appLayerIds, getApp, type AppConfig } from "@/shared/apps";

/** OpenRouter list price for GPT-6 Luna, USD per million tokens. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
/** Questions in flight at once. */
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4);

type Outcome = { golden: Golden; events: AgentStreamEvent[]; result: RunTurnResult; captures: ToolCapture[]; ms: number; judge: JudgeResult };

/**
 * The question's `context` as view state: the selected site, a knowledge time, a replay flag (carp); a selected
 * area, the globe's window and a selected evidence record (lionfish, python; the record is looked up in the fixture).
 */
function viewFor(app: AppConfig, base: NonNullable<AgentStreamRequest["view"]>, golden: Golden): NonNullable<AgentStreamRequest["view"]> {
  const context = golden.context ?? {};
  const asOf = context.asOf ? Date.parse(context.asOf) : NaN;
  const areaId = context.selectedArea ?? context.area;
  const area = areaId ? app.regions.find((r) => r.id === areaId) : undefined;
  const windowHours = context.window ? (/90/.test(context.window) ? 2160 : /30/.test(context.window) ? 720 : /7|week/.test(context.window) ? 168 : undefined) : undefined;
  const selection = context.selectedEvidence ? fixtureSelection(app.id, context.selectedEvidence) : null;
  return {
    ...base,
    ...(context.selectedSite ? { site: context.selectedSite } : {}),
    ...(area ? { bbox: area.bbox, region: area.id, area: area.id, preset: area.id } : {}),
    ...(windowHours ? { windowHours } : {}),
    ...(selection ? { selection } : {}),
    ...(Number.isFinite(asOf) ? { asOf, replay: true, time: new Date(asOf).toISOString() } : {}),
    ...(context.replay === "true" ? { replay: true } : {}),
  };
}

const finalText = (events: readonly AgentStreamEvent[]) => {
  const done = events.at(-1);
  return done?.type === "done" ? done.content : "";
};

type RunReport = RunTally & { tokensIn: number; cacheRead: number; tokensOut: number; judgeIn: number; judgeOut: number; wallMs: number };

/** One pass over the questions: agent turns, deterministic checks, the judge; prints the per-question and per-run lines. */
async function runOnce(app: AppConfig, questions: readonly Golden[], categories: readonly string[], runNo: number, runs: number): Promise<RunReport> {
  const fixture = fixtureNow(app.id);
  const stub = startStub();
  const dataDir = mkdtempSync(join(tmpdir(), "inversa-eval-"));
  process.env.INVERSA_API_ORIGIN = stub.origin;
  process.env.INVERSA_DATA_DIR = dataDir;
  const now = new Date(fixture);
  const layers = appLayerIds(app).filter((l) => l === "sightings" || l === "hotspots" || l === "stations" || l === "alerts");
  const baseView = { bbox: appBBox(app), time: fixture, layers, selection: null, ...(app.windows ? { windowHours: app.windows.defaultHours } : {}) };

  const outcomes: Outcome[] = [];
  const startedAll = Date.now();
  if (runs > 1) console.log(`EVAL run ${runNo}/${runs} started=${new Date().toISOString()}`);
  try {
    const queue = [...questions];
    const worker = async () => {
      for (let g = queue.shift(); g; g = queue.shift()) {
        const events: AgentStreamEvent[] = [];
        const captures: ToolCapture[] = [];
        const started = Date.now();
        const result = await runTurn(
          { app: app.id, sessionId: `eval-${g.id}-${started}`, question: g.question, view: viewFor(app, baseView, g), now, cache: false, registry: capturing(buildAgentRegistry(app), captures) },
          (event) => events.push(event),
        );
        // The judge sees the question, the answer and the tool outputs: never the golden tools, forbid patterns or ids.
        const answer = plainQuotes(finalText(events));
        const judge = await judgeMustSay({ question: g.question, answer, toolOutputs: captures.map((c) => c.text), items: g.mustSay });
        outcomes.push({ golden: g, events, result, captures, ms: Date.now() - started, judge });
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
  const qualityTotal = questions.filter((g) => g.quality).length;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let judgeIn = 0;
  let judgeOut = 0;
  let viewsValid = 0;
  let viewsTotal = 0;
  let ungrounded = 0;
  let checked = 0;
  const failedIds: string[] = [];
  const byCategory = new Map<string, { passed: number; total: number }>();
  for (const g of questions) {
    const outcome = outcomes.find((row) => row.golden === g)!;
    const { reasons, tools, cited, trace } = checkQuestion(g, outcome.events, outcome.captures);
    const views = checkViews(outcome.events);
    viewsValid += views.valid;
    viewsTotal += views.total;
    reasons.push(...views.reasons);
    for (const item of outcome.judge.items) if (!item.met) reasons.push(`not said: "${item.item}" (${item.reason ?? "judge: not met"})`);
    ungrounded += trace.ungrounded.length;
    checked += trace.checked;
    const ok = reasons.length === 0;
    if (ok) passed += 1;
    else failedIds.push(g.id);
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
    judgeIn += outcome.judge.usage.promptTokens;
    judgeOut += outcome.judge.usage.completionTokens;
    const tag = g.quality ? " [quality]" : "";
    const said = outcome.judge.items.filter((i) => i.met).length;
    console.log(`${ok ? "PASS" : "FAIL"} ${g.id}${tag} tools=${tools.join(",") || "-"} citations=${cited.length} numbers=${trace.checked} said=${said}/${g.mustSay.length} ${outcome.ms}ms`);
    for (const reason of reasons) console.log(`     - ${reason}`);
    if (process.env.EVAL_VERBOSE) {
      for (const event of outcome.events) {
        // The announcement from the first streamed delta carries no args; the full tool_start (same id) does.
        if (event.type === "tool_start" && event.args !== undefined) console.log(`     $ ${event.capabilityName} ${JSON.stringify(event.args)}`);
        if (event.type === "tool_end") {
          const data = event.data as { count?: number; feeds?: { source: string; state: string }[] } | undefined;
          const feeds = (data?.feeds ?? []).map((feed) => `${feed.source}:${feed.state}`).join(",");
          console.log(`     = ${event.capabilityName} ok=${event.ok} count=${data?.count ?? "-"} feeds=${feeds} ${event.error ?? ""}`);
        }
      }
      for (const item of outcome.judge.items) console.log(`     ${item.met ? "said" : "NOT "} "${item.item}" <- ${JSON.stringify(item.quote)}`);
    }
    if (process.env.EVAL_VERBOSE || !ok) {
      console.log(`     > ${finalText(outcome.events).replace(/\n+/g, " ") || "(no done event)"}`);
    }
    // EVAL_DUMP=<file>: one JSON line per question (answer, tool outputs, items, verdicts) for the judge corpus and analysis.
    if (process.env.EVAL_DUMP) {
      appendFileSync(
        process.env.EVAL_DUMP,
        `${JSON.stringify({ app: app.id, run: runNo, id: g.id, category: g.category, question: g.question, mustSay: g.mustSay, answer: plainQuotes(finalText(outcome.events)), toolOutputs: outcome.captures.map((c) => c.text), tools, reasons, judge: outcome.judge.items })}\n`,
      );
    }
  }
  // Cache reads are billed below list price, so this is an upper bound.
  const cost = (tokensIn * PRICE_IN + tokensOut * PRICE_OUT) / 1_000_000;
  const jcost = judgeCost({ promptTokens: judgeIn, completionTokens: judgeOut });
  const wallMs = Date.now() - startedAll;
  // cache_read is the part of `in` the provider served from its prompt cache (system prompt and tool definitions).
  console.log(`EVAL tokens in=${tokensIn} cache_read=${cacheRead} out=${tokensOut} cost<=$${cost.toFixed(4)} wall=${Math.round(wallMs / 1000)}s finished=${new Date().toISOString()}`);
  console.log(`EVAL judge model=${JUDGE_MODEL_ID} in=${judgeIn} out=${judgeOut} cost<=$${jcost.toFixed(4)} failed_calls=${outcomes.filter((o) => o.judge.error).length}`);
  console.log(`EVAL views valid ${viewsValid}/${viewsTotal}`);
  for (const c of categories) {
    const row = byCategory.get(c) ?? { passed: 0, total: 0 };
    console.log(`EVAL category ${c} passed ${row.passed}/${row.total} pct=${pct(row.passed, row.total)}`);
  }
  console.log(`EVAL ungrounded=${ungrounded} checked=${checked}`);
  console.log(`EVAL quality passed ${qualityPassed}/${qualityTotal}`);
  console.log(`EVAL passed ${passed}/${questions.length} pct=${pct(passed, questions.length)}`);
  const met = barsMet(passed, questions.length, byCategory, ungrounded);
  console.log(`EVAL bars overall>=${BARS.overall} category>=${BARS.category} boundary=${BARS.boundary} ungrounded=${BARS.ungrounded} met=${met ? "yes" : "no"}`);
  if (failedIds.length) console.log(`EVAL failed ids: ${failedIds.join(", ")}`);
  return { passed, total: questions.length, byCategory, ungrounded, checked, viewsValid, viewsTotal, failedIds, tokensIn, cacheRead, tokensOut, judgeIn, judgeOut, wallMs };
}

async function main(): Promise<number> {
  const app = getApp(evalApp(process.argv.slice(2), process.env));
  const runs = evalRuns(process.argv.slice(2));
  // `--holdout` runs the held-out set (paraphrases and new questions the prompts never saw) instead of the main set.
  const holdout = process.argv.includes("--holdout");
  const set = holdout ? `${app.id}.holdout` : app.eval.goldenSet;
  const golden = holdout ? holdoutSet(app.id) : (GOLDEN_SETS[app.eval.goldenSet] ?? []);
  // EVAL_ONLY=id,id runs a subset while iterating; EVAL_CATEGORY=c one category; the gate runs all of them.
  const only = process.env.EVAL_ONLY?.split(",").map((id) => id.trim()).filter(Boolean);
  const category = process.env.EVAL_CATEGORY?.trim();
  const questions = golden.filter((g) => (!only?.length || only.includes(g.id)) && (!category || g.category === category));
  const total = questions.length;
  const categories = [...new Set(questions.map((g) => g.category).filter((c): c is string => !!c))].sort((a, b) => CATEGORIES.indexOf(a as (typeof CATEGORIES)[number]) - CATEGORIES.indexOf(b as (typeof CATEGORIES)[number]));
  const fixture = fixtureNow(app.id);
  // The holdout bar is 90% overall with no per-category bar (rubric.md); boundary and ungrounded stay strict everywhere.
  const bars = holdout ? { overall: 90, category: null } : { overall: BARS.overall, category: BARS.category };
  const barsLine = (met: boolean) => `EVAL pooled bars overall>=${bars.overall} category>=${bars.category ?? 0} boundary=${BARS.boundary}each ungrounded=${BARS.ungrounded} met=${met ? "yes" : "no"}`;
  console.log(`EVAL app=${app.id} set=${set} model=${AGENT_MODEL_ID} judge=${JUDGE_MODEL_ID} questions=${total} runs=${runs} fixture=${fixture}`);
  if (total === 0) {
    console.log(`EVAL no questions in set ${set}`);
    return 1;
  }
  if (!openRouterApiKey()) {
    console.log(`EVAL ${MISSING_KEY_MESSAGE} (run it through \`bun run eval\`, which wraps doppler)`);
    for (const c of categories) console.log(`EVAL category ${c} passed 0/${questions.filter((g) => g.category === c).length} pct=0`);
    console.log("EVAL ungrounded=0 checked=0");
    console.log(`EVAL passed 0/${total} pct=0`);
    console.log(`EVAL bars overall>=${BARS.overall} category>=${BARS.category} boundary=${BARS.boundary} ungrounded=${BARS.ungrounded} met=no`);
    console.log(`EVAL pooled app=${app.id} runs=${runs} passed 0/${total * runs} pct=0`);
    console.log("EVAL pooled ungrounded=0 checked=0");
    console.log(barsLine(false));
    return 1;
  }

  const reports: RunReport[] = [];
  for (let i = 1; i <= runs; i++) reports.push(await runOnce(app, questions, categories, i, runs));

  const p = pool(reports);
  const sum = (f: (r: RunReport) => number) => reports.reduce((a, r) => a + f(r), 0);
  const agentCost = (sum((r) => r.tokensIn) * PRICE_IN + sum((r) => r.tokensOut) * PRICE_OUT) / 1_000_000;
  const jCost = judgeCost({ promptTokens: sum((r) => r.judgeIn), completionTokens: sum((r) => r.judgeOut) });
  console.log(`EVAL pooled app=${app.id} runs=${runs} passed ${p.passed}/${p.total} pct=${pct(p.passed, p.total)}`);
  console.log(`EVAL pooled per-run passed ${reports.map((r) => `${r.passed}/${r.total}`).join(" ")}`);
  for (const c of categories) {
    const row = p.byCategory.get(c) ?? { passed: 0, total: 0 };
    console.log(`EVAL pooled category ${c} passed ${row.passed}/${row.total} pct=${pct(row.passed, row.total)}`);
  }
  console.log(`EVAL pooled ungrounded=${p.ungrounded} checked=${p.checked}`);
  console.log(`EVAL pooled views valid ${p.viewsValid}/${p.viewsTotal}`);
  console.log(`EVAL pooled cost agent<=$${agentCost.toFixed(4)} judge<=$${jCost.toFixed(4)} wall=${Math.round(sum((r) => r.wallMs) / 1000)}s finished=${new Date().toISOString()}`);
  for (const [i, r] of reports.entries()) console.log(`EVAL pooled run ${i + 1} failed: ${r.failedIds.join(", ") || "-"}`);
  if (p.repeatFailures.length) console.log(`EVAL pooled repeat failures: ${p.repeatFailures.map((f) => `${f.id} (${f.runs}/${runs})`).join(", ")}`);
  const unmet = pooledBarsUnmet(p, bars);
  for (const reason of unmet) console.log(`EVAL pooled unmet: ${reason}`);
  console.log(barsLine(unmet.length === 0));
  return unmet.length === 0 ? 0 : 1;
}

process.exit(await main());
