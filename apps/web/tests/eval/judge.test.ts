import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { GOLDEN_SETS, holdoutSet } from "@/eval/golden";
import { applyQuoteRule, JUDGE_MODEL_ID, JUDGE_SYSTEM_PROMPT, judgeMustSay, judgeUserMessage, parseJudgeReply } from "@/eval/judge";
import { AGENT_MODEL_ID } from "@/server/agent/runtime/model";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { APP_IDS, getApp } from "@/shared/apps";
import type { QuestionFile } from "@/shared/apps/questions";

/**
 * gates/leaf-J1.md G2: the quote rule (a "met" without a verbatim answer substring is not met), judge failures count
 * as not met, and the judge is told nothing about the golden wording, forbid patterns, expected tools or ids.
 */

const ANSWER = "Krotz Springs reads 1.65 ft (USGS) as of 01:00 CDT; the NWPS forecast is stale, 40 h old. I can't say whether it is safe.";

describe("judge quote rule", () => {
  test("judge quote rule: met needs a verbatim, non-empty substring of the answer", () => {
    expect(applyQuoteRule(ANSWER, { met: true, quote: "reads 1.65 ft (USGS)" }, "x").met).toBe(true);
    // Whitespace and typographic quotes are normalised on both sides; words are not.
    expect(applyQuoteRule(ANSWER, { met: true, quote: "I can’t say  whether it is safe" }, "x").met).toBe(true);
    expect(applyQuoteRule(ANSWER, { met: true, quote: "" }, "x")).toMatchObject({ met: false, reason: "judge: met without a quote" });
    expect(applyQuoteRule(ANSWER, { met: true, quote: "the forecast is fresh" }, "x")).toMatchObject({ met: false, reason: "judge: quote is not a substring of the answer" });
    expect(applyQuoteRule(ANSWER, { met: true, quote: "reads 1.65 ft ... safe" }, "x").met).toBe(false);
    expect(applyQuoteRule(ANSWER, { met: true }, "x").met).toBe(false);
    expect(applyQuoteRule(ANSWER, { met: "true", quote: "reads 1.65 ft" }, "x").met).toBe(false);
    expect(applyQuoteRule(ANSWER, { met: false, quote: "reads 1.65 ft" }, "x").met).toBe(false);
  });

  test("judge quote rule: a malformed, short or looping reply is rejected, a fenced one is read", () => {
    expect(parseJudgeReply('{"items":[{"n":1,"met":true,"quote":"a"},{"n":2,"met":false,"quote":""}]}', 2)).toHaveLength(2);
    expect(parseJudgeReply('```json\n{"items":[{"n":1,"met":true,"quote":"a"}]}\n```', 1)).toHaveLength(1);
    expect(parseJudgeReply('{"items":[{"n":1,"met":true,"quote":"a"}]}', 2)).toBeNull();
    // A looping reply repeats item 1 until the token cap: truncated JSON, or a count that does not match.
    expect(parseJudgeReply('{"items":[{"n":1,"met":true,"quote":"a"},{"n":1,"met":true,"quote":"a"},{"n":1,"met":true,"qu', 2)).toBeNull();
    expect(parseJudgeReply('{"items":[{"n":1,"met":true,"quote":"a"},{"n":1,"met":true,"quote":"a"},{"n":1,"met":true,"quote":"a"}]}', 2)).toBeNull();
    expect(parseJudgeReply("All items are met.", 1)).toBeNull();
    expect(parseJudgeReply("", 1)).toBeNull();
  });

  test("judge quote rule: a judge failure (no key, so no call) counts every item as not met, never as met", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const out = await judgeMustSay({ question: "q", answer: ANSWER, toolOutputs: [], items: ["a", "b"] });
      expect(out.error).toContain("OPENROUTER_API_KEY");
      expect(out.items.map((i) => i.met)).toEqual([false, false]);
      expect(out.items[0]!.reason).toContain("judge failed");
      expect((await judgeMustSay({ question: "q", answer: ANSWER, toolOutputs: [], items: [] })).items).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  test("judge quote rule: the judge model is not the agent model", () => {
    expect(JUDGE_MODEL_ID).not.toBe(AGENT_MODEL_ID);
    expect(JUDGE_MODEL_ID).toMatch(/\//);
  });

  test("judge quote rule: the judge prompt carries no forbid pattern, expected tool name, question id or golden wording", () => {
    const dir = join(import.meta.dir, "../../../../spec/apps/questions");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as QuestionFile);
    const ids = new Set(files.flatMap((f) => f.questions.map((q) => q.id)));
    const forbids = new Set(files.flatMap((f) => f.questions.flatMap((q) => q.pass.forbid)));
    const tools = new Set(APP_IDS.flatMap((id) => buildAgentRegistry(getApp(id)).list().map((c) => c.name)));
    expect(ids.size).toBeGreaterThan(300);
    expect(forbids.size).toBeGreaterThan(20);
    expect(tools.size).toBeGreaterThan(10);
    const goldens = [...GOLDEN_SETS.carp!, ...GOLDEN_SETS.lionfish!, ...GOLDEN_SETS.python!, ...holdoutSet("carp"), ...holdoutSet("lionfish"), ...holdoutSet("python")];
    expect(goldens.length).toBeGreaterThan(300);
    const lower = JUDGE_SYSTEM_PROMPT.toLowerCase();
    for (const id of ids) expect(lower).not.toContain(id);
    for (const f of forbids) expect(JUDGE_SYSTEM_PROMPT).not.toContain(f);
    for (const t of tools) expect(lower).not.toMatch(new RegExp(`\\b${t}\\b`));
    // The user message is built from the question, answer, tool outputs and items only: the golden's id, forbid patterns
    // and expected-tool list cannot leak, whatever the golden holds (the question and the items may use ordinary words
    // such as "alerts"; the tool list itself never appears).
    for (const g of goldens) {
      const message = judgeUserMessage(g.question, "an answer", ["{}"], g.mustSay);
      expect(message).not.toContain(g.id);
      for (const f of g.expect.forbid ?? []) expect(message).not.toContain(f.source);
      if (g.expect.tools.length) expect(message).not.toContain(JSON.stringify(g.expect.tools));
      expect(message).not.toMatch(/expected tools|required tools|must cite|forbid/i);
    }
    // What it does carry: the question, the answer, the tool outputs and the numbered items.
    const message = judgeUserMessage("Q?", "A.", ["tool 1 text"], ["item one", "item two"]);
    expect(message).toContain("QUESTION:\nQ?");
    expect(message).toContain("<<<\nA.\n>>>");
    expect(message).toContain("--- tool output 1 ---\ntool 1 text");
    expect(message).toContain("1. item one\n2. item two");
  });

  test("judge quote rule: oversized tool outputs are truncated and budgeted, never dropped silently", () => {
    const big = "x".repeat(20_000);
    const message = judgeUserMessage("Q", "A", [big, big, big, big, big, big, big], ["i"]);
    expect(message).toContain("[truncated 12000 chars]");
    expect(message).toContain("omitted: budget");
    expect(message.length).toBeLessThan(60_000);
  });
});
