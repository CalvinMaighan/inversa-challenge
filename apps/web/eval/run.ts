/**
 * Agent eval: golden questions against the fixture GraphQL stub.
 *
 *   AGENT_EVAL_MODE=replay bun run eval   scripted mock LLM, must pass every question
 *   AGENT_EVAL_MODE=live   bun run eval   DeepSeek on Fireworks, needs FIREWORKS_API_KEY
 *
 * Checks per question: the expected tools ran, every citation (events and
 * final text) names evidence a tool returned in that turn, enough citations,
 * required phrases, the C7 stream shape. Last line: `EVAL passed P/T`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GOLDEN, replayScript, type Golden } from "./golden";
import { FIXTURE_NOW, startStub } from "./stub-server";

import { REGION_BBOX } from "@/server/agent/config";
import { resetHarness } from "@/server/agent/cordis/boot";
import { citedIds } from "@/server/agent/cordis/citations";
import { clearMockScripts, setMockScript } from "@/server/agent/cordis/plugins/mock-llm";
import type { Evidence } from "@/server/agent/runtime/registry";
import { runTurn } from "@/server/agent/run-turn";
import { isAgentStreamEvent, type AgentStreamEvent } from "@/shared/agent/events";

type Mode = "replay" | "live";

function check(golden: Golden, events: AgentStreamEvent[], mode: Mode): { reasons: string[]; tools: string[]; cited: string[] } {
  const reasons: string[] = [];
  if (!events.every(isAgentStreamEvent)) reasons.push("stream has an event outside the C7 union");
  const done = events.filter((event) => event.type === "done");
  if (done.length !== 1 || events.at(-1)?.type !== "done") reasons.push("stream must end with exactly one done event");
  for (const event of events) if (event.type === "error") reasons.push(`error event: ${event.message}`);

  const tools = events.flatMap((event) => (event.type === "tool_start" ? [event.capabilityName] : []));
  for (const tool of golden.expect.tools) if (!tools.includes(tool)) reasons.push(`tool not called: ${tool}`);
  if (mode === "replay") {
    for (const event of events) {
      if (event.type === "tool_end" && !event.ok) reasons.push(`tool failed: ${event.capabilityName}: ${event.error}`);
    }
  }

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
  for (const phrase of golden.expect.phrases) if (!phrase.test(content)) reasons.push(`missing phrase ${phrase}`);
  if (golden.expect.view && !events.some((event) => event.type === "view")) reasons.push("no view event");
  if (mode === "replay" && golden.expect.debug) {
    const debug = golden.expect.debug;
    if (!events.some((event) => event.type === "debug" && debug.test(event.text))) reasons.push(`no debug event ${debug}`);
  }
  return { reasons, tools, cited };
}

async function main(): Promise<number> {
  const mode: Mode = process.env.AGENT_EVAL_MODE === "live" ? "live" : "replay";
  const total = GOLDEN.length;
  const qualityTotal = GOLDEN.filter((golden) => golden.quality).length;
  if (mode === "live" && !process.env.FIREWORKS_API_KEY?.trim()) {
    console.log("EVAL live mode needs FIREWORKS_API_KEY");
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

  let passed = 0;
  let qualityPassed = 0;
  console.log(`EVAL mode=${mode} questions=${total} fixture=${FIXTURE_NOW}`);
  try {
    clearMockScripts();
    for (const golden of GOLDEN) {
      if (mode === "replay") setMockScript(golden.question, replayScript(golden));
      const events: AgentStreamEvent[] = [];
      const started = Date.now();
      await runTurn(
        {
          sessionId: `eval-${golden.id}-${started}`,
          question: golden.question,
          view,
          now,
          harnessMode: mode === "live" ? "live" : "mock",
          cache: false,
        },
        (event) => events.push(event),
      );
      const { reasons, tools, cited } = check(golden, events, mode);
      const ok = reasons.length === 0;
      if (ok) passed += 1;
      if (ok && golden.quality) qualityPassed += 1;
      const tag = golden.quality ? " [quality]" : "";
      console.log(
        `${ok ? "PASS" : "FAIL"} ${golden.id}${tag} tools=${tools.join(",") || "-"} citations=${cited.length} ${Date.now() - started}ms`,
      );
      for (const reason of reasons) console.log(`     - ${reason}`);
      if (process.env.EVAL_VERBOSE) {
        const done = events.at(-1);
        console.log(`     > ${done?.type === "done" ? done.content : "(no done event)"}`);
      }
    }
  } finally {
    await resetHarness();
    stub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`EVAL quality passed ${qualityPassed}/${qualityTotal}`);
  console.log(`EVAL passed ${passed}/${total}`);
  return passed === total ? 0 : 1;
}

process.exit(await main());
