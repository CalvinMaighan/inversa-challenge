/**
 * D1 G1: every path cited in docs/brief-compliance.md exists, and every MET row cites at least one gate file
 * (`gates/*.md`) or evidence path (`docs/evidence/**`, `docs/grading/**`).
 *
 *   bun scripts/check-compliance-paths.ts
 *
 * Reads the markdown tables of the doc. A data row is a table line whose last cell starts with MET, PARTIAL,
 * ABANDON or N/A. Cited paths are the backtick spans that look like repo paths; `{a,b}` expands, spans with
 * `<`, `*` or `…` are patterns and are skipped. Last line: `COMPLIANCE rows=<n> paths_ok=<n> missing=<n>`;
 * exit 1 when anything is missing.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const DOC = path.join(ROOT, "docs/brief-compliance.md");
const STATUS = /^(MET|PARTIAL|ABANDON|N\/A)\b/;
const PATHLIKE = /^(gates|docs|api|apps|spec|scripts|deploy|packages|\.github)\/[^\s`]+$|^(README|PLAN|GATES)\.md$/;
const EVIDENCE = /^(gates\/[^/]+\.md|docs\/evidence\/|docs\/grading\/)/;

/** One level of `{a,b}` expansion, enough for `docs/evidence/carp-{board,timeline}.png`. */
function expand(p: string): string[] {
  const m = p.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!m) return [p];
  return m[2]!.split(",").flatMap((part) => expand(`${m[1]}${part}${m[3]}`));
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const text = await Bun.file(DOC).text();
let rows = 0;
let ok = 0;
const missing: string[] = [];

for (const [i, line] of text.split("\n").entries()) {
  if (!line.startsWith("|")) continue;
  const c = cells(line);
  const status = c[c.length - 1] ?? "";
  if (!STATUS.test(status)) continue;
  rows++;
  const cited = [...line.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1]!.trim().replace(/[.,;:]+$/, "").replace(/\s+G\d+.*$/, ""))
    .filter((p) => !/[<*…]/.test(p) && PATHLIKE.test(p))
    .flatMap(expand);
  for (const p of cited) {
    if (existsSync(path.join(ROOT, p))) ok++;
    else missing.push(`line ${i + 1}: ${p} does not exist`);
  }
  if (status.startsWith("MET") && !cited.some((p) => EVIDENCE.test(p) && existsSync(path.join(ROOT, p)))) {
    missing.push(`line ${i + 1}: MET row "${c[1] ?? c[0]}" cites no gate file or evidence path`);
  }
}

for (const m of missing) console.log(`MISSING ${m}`);
console.log(`COMPLIANCE rows=${rows} paths_ok=${ok} missing=${missing.length}`);
if (rows === 0 || missing.length) process.exit(1);
