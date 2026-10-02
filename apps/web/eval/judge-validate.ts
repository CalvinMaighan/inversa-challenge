/**
 * Validates the semantic judge (eval/judge.ts) against the labelled corpus eval/judge-corpus.json (gates/leaf-J1.md
 * G1): answers written and labelled independently of the judge, some good in varied phrasing, some plausible but
 * wrong or incomplete, some adversarial (right keywords in the wrong sense, quoted questions, injected instructions,
 * contradictions). Prints the confusion matrix per split and overall:
 *
 *   JUDGE split=<dev|test> agree=<n>/<N> false_accept=<n> false_reject=<n>
 *   JUDGE agree=<n>/<N> false_accept=<n> false_reject=<n>
 *
 * An answer "agrees" when the judge's per-item verdicts equal the labels. A false accept is a bad or adversarial
 * answer the judge would pass (every item met); a false reject is a good answer the judge would fail (any item not
 * met). The prompt was tuned on the dev split only; the test split is reported untouched.
 *
 *   cd apps/web && doppler run --project inversa --config dev -- bun eval/judge-validate.ts [--split dev|test|all] [--verbose]
 */

import corpus from "./judge-corpus.json";
import { JUDGE_MODEL_ID, judgeCost, judgeMustSay, type JudgeUsage } from "./judge";

export type CorpusEntry = {
  id: string;
  app: "carp" | "lionfish" | "python";
  split: "dev" | "test";
  label: "good" | "bad" | "adversarial";
  /** Why the answer is labelled as it is: the defect it carries, or the phrasing it varies. */
  note: string;
  question: string;
  mustSay: string[];
  toolOutputs: string[];
  answer: string;
  /** Per item, whether a careful human reader says the answer states it. */
  expect: boolean[];
};

const CONCURRENCY = 6;

export function validateCorpus(entries: readonly CorpusEntry[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) errors.push(`${e.id}: duplicate id`);
    ids.add(e.id);
    if (e.mustSay.length !== e.expect.length) errors.push(`${e.id}: ${e.mustSay.length} items, ${e.expect.length} labels`);
    if (e.label === "good" && !e.expect.every(Boolean)) errors.push(`${e.id}: a good answer must meet every item`);
    if (e.label !== "good" && e.expect.every(Boolean)) errors.push(`${e.id}: a ${e.label} answer must miss at least one item`);
    if (!e.answer.trim()) errors.push(`${e.id}: empty answer`);
  }
  return errors;
}

type Row = { entry: CorpusEntry; met: boolean[]; quotes: string[]; reasons: string[]; error?: string };

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const split = args.includes("--split") ? args[args.indexOf("--split") + 1] : "all";
  const verbose = args.includes("--verbose");
  const entries = (corpus.entries as CorpusEntry[]).filter((e) => split === "all" || e.split === split);
  const problems = validateCorpus(corpus.entries as CorpusEntry[]);
  for (const p of problems) console.log(`CORPUS ${p}`);
  if (problems.length) return 2;
  const byLabel = (label: CorpusEntry["label"]) => entries.filter((e) => e.label === label).length;
  console.log(`JUDGE model=${JUDGE_MODEL_ID} corpus=${entries.length} good=${byLabel("good")} bad=${byLabel("bad")} adversarial=${byLabel("adversarial")} split=${split}`);

  const rows: Row[] = [];
  const usage: JudgeUsage = { promptTokens: 0, completionTokens: 0 };
  const queue = [...entries];
  const started = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        const r = await judgeMustSay({ question: e.question, answer: e.answer, toolOutputs: e.toolOutputs, items: e.mustSay });
        usage.promptTokens += r.usage.promptTokens;
        usage.completionTokens += r.usage.completionTokens;
        rows.push({ entry: e, met: r.items.map((i) => i.met), quotes: r.items.map((i) => i.quote), reasons: r.items.map((i) => i.reason ?? ""), error: r.error });
      }
    }),
  );

  const report = (name: string, subset: Row[]) => {
    let agree = 0;
    let falseAccept = 0;
    let falseReject = 0;
    let itemAgree = 0;
    let items = 0;
    for (const r of subset) {
      const same = r.met.length === r.entry.expect.length && r.met.every((m, i) => m === r.entry.expect[i]);
      if (same) agree++;
      const judgePasses = r.met.every(Boolean);
      if (r.entry.label !== "good" && judgePasses) falseAccept++;
      if (r.entry.label === "good" && !judgePasses) falseReject++;
      r.met.forEach((m, i) => {
        items++;
        if (m === r.entry.expect[i]) itemAgree++;
      });
    }
    console.log(`JUDGE split=${name} agree=${agree}/${subset.length} false_accept=${falseAccept} false_reject=${falseReject} items=${itemAgree}/${items}`);
    return { agree, falseAccept, falseReject };
  };

  for (const r of rows.sort((a, b) => a.entry.id.localeCompare(b.entry.id))) {
    const same = r.met.every((m, i) => m === r.entry.expect[i]);
    if (same && !verbose) continue;
    console.log(`${same ? "ok  " : "DIFF"} ${r.entry.id} [${r.entry.label}/${r.entry.split}] ${r.entry.note}${r.error ? ` (judge error: ${r.error})` : ""}`);
    r.met.forEach((m, i) => {
      const mark = m === r.entry.expect[i] ? "   " : "!! ";
      console.log(`     ${mark}${m ? "met" : "not"} (expect ${r.entry.expect[i] ? "met" : "not"}) "${r.entry.mustSay[i]}" <- ${JSON.stringify(r.quotes[i])}${r.reasons[i] && !m ? ` ${r.reasons[i]}` : ""}`);
    });
  }
  for (const name of ["dev", "test"] as const) {
    const subset = rows.filter((r) => r.entry.split === name);
    if (subset.length) report(name, subset);
  }
  const all = report("all", rows);
  console.log(`JUDGE tokens in=${usage.promptTokens} out=${usage.completionTokens} cost<=$${judgeCost(usage).toFixed(4)} wall=${Math.round((Date.now() - started) / 1000)}s errors=${rows.filter((r) => r.error).length}`);
  console.log(`JUDGE agree=${all.agree}/${rows.length} false_accept=${all.falseAccept} false_reject=${all.falseReject}`);
  return all.falseAccept === 0 && all.agree / rows.length >= 0.95 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
