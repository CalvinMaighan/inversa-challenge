/**
 * Removed species (gates/leaf-K1.md G2) may appear in the question files only as boundary questions the agent
 * refuses or caveats. Scans every question in spec/apps/questions/*.json (golden and holdout) and prints any that
 * names a removed species without being category `boundary` with pass mode `refuse` or `caveat`.
 *
 *   bun scripts/check-removed-species.ts
 *
 * Last line: `REMOVED-SPECIES allowed=<n> violations=<m>`; exit 1 when m > 0.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "spec/apps/questions");
const TERMS = /tegu|iguana|salvator|anole|tree frog/i;

type Question = { id: string; category: string; pass?: { mode?: string } };

const allowed: string[] = [];
const violations: string[] = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const { questions } = JSON.parse(readFileSync(join(DIR, file), "utf8")) as { questions: Question[] };
  for (const q of questions) {
    if (!TERMS.test(JSON.stringify(q))) continue;
    const ok = q.category === "boundary" && (q.pass?.mode === "refuse" || q.pass?.mode === "caveat");
    (ok ? allowed : violations).push(`${file} ${q.id} category=${q.category} mode=${q.pass?.mode}`);
  }
}
for (const line of allowed) console.log(`allowed ${line}`);
for (const line of violations) console.log(`VIOLATION ${line}`);
console.log(`REMOVED-SPECIES allowed=${allowed.length} violations=${violations.length}`);
if (violations.length) process.exit(1);
