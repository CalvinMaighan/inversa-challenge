#!/usr/bin/env bun
// Scores the submission against docs/TASK_BRIEF.md using docs/grading/rubric.json.
// Honest by construction: a check earns points only when its command exits 0,
// prints something, finishes inside its timeout and every expectation holds.
// A check whose prerequisites are missing is PENDING and earns 0.
//
//   bun scripts/grade.ts                 full run, writes docs/grading/report.md
//   bun scripts/grade.ts --fast          static and unit checks only (skips build, e2e, live)
//   bun scripts/grade.ts --only a,b      only these criteria
//   bun scripts/grade.ts --app carp      only this app's checks (plus app-independent ones)
//   bun scripts/grade.ts --timeout 600   default per-check timeout in seconds
//   bun scripts/grade.ts --no-write      do not write the report
//   bun scripts/grade.ts --validate      validate the rubric only
//   bun scripts/grade.ts --confirm <criterion>/<manual>[@app] --by "<name>"   human sign-off (needs a TTY)
//   bun scripts/grade.ts --probe config|doc|ingest ...                        helpers the rubric calls

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const REPO = path.resolve(import.meta.dir, "..");
export const APPS = ["carp", "lionfish", "python"] as const;
export type AppId = (typeof APPS)[number];
export const KINDS = ["static", "unit", "build", "e2e", "live"] as const;
export type Kind = (typeof KINDS)[number];
const FAST_KINDS: ReadonlySet<Kind> = new Set(["static", "unit"]);

export type Bound = { min?: number; max?: number };
export type Expect = {
  re: string;
  flags?: string;
  bounds?: Record<string, Bound>;
  eq?: [string, string][];
  minCount?: number;
  absent?: boolean;
  forEach?: string[];
};
export type Requires = {
  files?: string[];
  scripts?: string[];
  contains?: { path: string; text: string }[];
  env?: string[];
};
export type Check = {
  id: string;
  kind: Kind;
  share: number;
  run: string;
  timeout?: number;
  repeat?: number;
  requires?: Requires;
  expect: Expect[];
};
export type Manual = { id: string; share: number; item: string; evidence: string[] };
export type Criterion = {
  id: string;
  title: string;
  group: string;
  source: "brief" | "overnight" | "apps";
  brief: string;
  weight: number;
  appliesTo: AppId[];
  threshold: number;
  checks: Check[];
  manual: Manual[];
};
export type Rubric = {
  version: number;
  apps: AppId[];
  passBar: { total: number; everyCriterionAtThreshold: boolean };
  defaults: { timeout: number };
  criteria: Criterion[];
};

export type RunResult = { code: number | null; out: string; timedOut: boolean; ms: number };
export type UnitStatus = "PASS" | "FAIL" | "PENDING" | "SKIP";
export type Unit = {
  criterion: string;
  id: string; // check or manual id
  app: AppId | null; // null = app-independent
  kind: Kind | "manual";
  share: number; // share of the criterion weight this unit is worth in the overall score
  appShare: number; // share of the criterion weight this unit is worth in its app's score
  status: UnitStatus;
  reason: string;
  matched: string[];
};

const EPS = 1e-9;

// ---------- small helpers ----------

export function expand(s: string, app: AppId | null, each?: string): string {
  let out = s;
  if (app) out = out.replaceAll("{app}", app);
  if (each !== undefined) out = out.replaceAll("{each}", each);
  return out;
}

const perApp = (s: string) => s.includes("{app}");

export function checkIsPerApp(c: Check): boolean {
  return perApp(c.run) || JSON.stringify(c.requires ?? {}).includes("{app}");
}

export function manualIsPerApp(m: Manual): boolean {
  return m.evidence.some(perApp);
}

function parseRegexArg(s: string): RegExp {
  const m = s.match(/^\/(.*)\/([a-z]*)$/s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(s, "i");
}

function normalizeQuote(s: string): string {
  return s.replace(/[*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function fileHasText(p: string, text: string): boolean {
  const abs = path.resolve(REPO, p);
  if (!existsSync(abs)) return false;
  const st = statSync(abs);
  if (st.isFile()) return readFileSync(abs, "utf8").includes(text);
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "target" || name === ".next" || name.startsWith(".")) continue;
    if (fileHasText(path.join(p, name), text)) return true;
  }
  return false;
}

function packageScripts(dir: string): Record<string, string> {
  const pj = path.resolve(REPO, dir, "package.json");
  if (!existsSync(pj)) return {};
  try {
    return JSON.parse(readFileSync(pj, "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

// ---------- requirements ----------

/** Returns the reason a check cannot run yet, or null when every prerequisite exists. */
export function missingRequirement(req: Requires | undefined, app: AppId | null, env = process.env): string | null {
  if (!req) return null;
  for (const f of req.files ?? []) {
    const p = expand(f, app);
    const abs = path.resolve(REPO, p);
    if (!existsSync(abs)) return `missing ${p}`;
    if (statSync(abs).isFile() && statSync(abs).size === 0) return `empty ${p}`;
  }
  for (const s of req.scripts ?? []) {
    const i = s.indexOf(":");
    const dir = s.slice(0, i);
    const name = s.slice(i + 1);
    if (!packageScripts(dir === "root" ? "." : dir)[name]) return `missing script ${name} in ${dir === "root" ? "" : dir + "/"}package.json`;
  }
  for (const c of req.contains ?? []) {
    const p = expand(c.path, app);
    const t = expand(c.text, app);
    if (!fileHasText(p, t)) return `${p} does not emit "${t}"`;
  }
  for (const e of req.env ?? []) {
    if (!env[e]) return `env ${e} unset`;
  }
  return null;
}

// ---------- running commands ----------

export function runCommand(cmd: string, timeoutSec: number, cwd = REPO): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn("bash", ["-c", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    const MAX = 8 * 1024 * 1024;
    const take = (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > MAX) out = out.slice(out.length - MAX);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, Math.max(1, timeoutSec) * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, out, timedOut, ms: performance.now() - t0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, out: out + String(err), timedOut, ms: performance.now() - t0 });
    });
  });
}

// ---------- expectations ----------

export function expandExpects(expects: Expect[], app: AppId | null): (Expect & { label: string })[] {
  const out: (Expect & { label: string })[] = [];
  for (const e of expects) {
    for (const each of e.forEach ?? [undefined]) {
      out.push({ ...e, re: expand(e.re, app, each), label: expand(e.re, app, each) });
    }
  }
  return out;
}

/** Evaluates one expectation against a command's output. Returns null on success, a reason otherwise. */
export function evaluateExpect(e: Expect, out: string): { fail: string | null; matched?: string } {
  const flags = (e.flags ?? "m").replace("g", "");
  const re = new RegExp(e.re, flags);
  if (e.absent) {
    const m = out.match(re);
    return m ? { fail: `forbidden output /${e.re}/: ${m[0].slice(0, 120)}` } : { fail: null };
  }
  const m = out.match(re);
  if (!m) return { fail: `no line matches /${e.re}/` };
  if (e.minCount) {
    const n = [...out.matchAll(new RegExp(e.re, flags + "g"))].length;
    if (n < e.minCount) return { fail: `/${e.re}/ matched ${n} times, need ${e.minCount}` };
  }
  const g = m.groups ?? {};
  for (const [name, b] of Object.entries(e.bounds ?? {})) {
    const v = Number(g[name]);
    if (g[name] === undefined || !Number.isFinite(v)) return { fail: `group ${name} not numeric in "${m[0]}"` };
    if (b.min !== undefined && v < b.min) return { fail: `${name}=${v} below ${b.min} in "${m[0]}"` };
    if (b.max !== undefined && v > b.max) return { fail: `${name}=${v} above ${b.max} in "${m[0]}"` };
  }
  for (const [a, b] of e.eq ?? []) {
    if (g[a] === undefined || g[b] === undefined || Number(g[a]) !== Number(g[b])) return { fail: `${a}=${g[a]} != ${b}=${g[b]} in "${m[0]}"` };
  }
  return { fail: null, matched: m[0].trim().slice(0, 200) };
}

/** A single run passes only if the command exited 0, did not time out, printed something, and every expectation holds. */
export function judgeRun(r: RunResult, expects: Expect[]): { ok: boolean; reason: string; matched: string[] } {
  if (r.timedOut) return { ok: false, reason: `timed out after ${(r.ms / 1000).toFixed(0)} s`, matched: [] };
  if (r.code !== 0) return { ok: false, reason: `exit ${r.code}: ${lastLine(r.out)}`, matched: [] };
  if (!r.out.trim()) return { ok: false, reason: "printed nothing", matched: [] };
  if (!expects.some((e) => !e.absent)) return { ok: false, reason: "no positive expectation", matched: [] };
  const matched: string[] = [];
  for (const e of expects) {
    const res = evaluateExpect(e, r.out);
    if (res.fail) return { ok: false, reason: res.fail, matched };
    if (res.matched && !matched.includes(res.matched)) matched.push(res.matched);
  }
  return { ok: true, reason: "ok", matched };
}

function lastLine(s: string): string {
  const lines = s.trim().split("\n").filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 160);
}

// ---------- manual confirmations ----------

export const CONFIRMATIONS = path.join(REPO, "docs/grading/confirmations.json");
type Confirmation = { by: string; at: string; sha256: string };

export function evidenceHash(paths: string[]): string | null {
  const h = createHash("sha256");
  for (const p of paths) {
    const abs = path.resolve(REPO, p);
    if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size === 0) return null;
    h.update(p).update("\0").update(readFileSync(abs));
  }
  return h.digest("hex");
}

function loadConfirmations(file = CONFIRMATIONS): Record<string, Confirmation> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function judgeManual(key: string, evidence: string[], confirmations: Record<string, Confirmation>): { status: UnitStatus; reason: string } {
  const missing = evidence.find((p) => !existsSync(path.resolve(REPO, p)));
  if (missing) return { status: "PENDING", reason: `missing ${missing}` };
  const hash = evidenceHash(evidence);
  if (!hash) return { status: "PENDING", reason: `empty evidence in ${evidence.join(", ")}` };
  const c = confirmations[key];
  if (!c || !c.by?.trim()) return { status: "PENDING", reason: `needs human sign-off: bun scripts/grade.ts --confirm ${key} --by <name>` };
  if (c.sha256 !== hash) return { status: "PENDING", reason: `evidence changed since ${c.by} signed off on ${c.at}` };
  return { status: "PASS", reason: `confirmed by ${c.by} on ${c.at}` };
}

// ---------- validation ----------

// Output any stub could print. Each check needs at least one expectation this does not satisfy.
const GENERIC = "ok\nOK\nPASS\ndone\n0\n1\ntrue\n 1 pass\n 0 fail\n1 pass\n0 fail\nall tests passed";

export function validateRubric(r: Rubric, briefs: Record<string, string>): { errors: string[]; maxAutomated: number } {
  const errors: string[] = [];
  const ids = new Set<string>();
  let weight = 0;
  let maxAutomated = 0;
  if (!Array.isArray(r.criteria) || r.criteria.length === 0) errors.push("no criteria");
  for (const c of r.criteria ?? []) {
    const at = `criterion ${c.id}`;
    if (!/^[a-z0-9-]+$/.test(c.id ?? "")) errors.push(`${at}: bad id`);
    if (ids.has(c.id)) errors.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (!Number.isInteger(c.weight) || c.weight <= 0) errors.push(`${at}: weight must be a positive integer`);
    weight += c.weight;
    if (!c.title?.trim()) errors.push(`${at}: no title`);
    if (!Array.isArray(c.appliesTo) || c.appliesTo.length === 0 || c.appliesTo.some((a) => !APPS.includes(a))) errors.push(`${at}: appliesTo must be a non-empty subset of ${APPS.join(",")}`);
    if (!(c.threshold > 0 && c.threshold <= 1)) errors.push(`${at}: threshold must be in (0, 1]`);
    const text = briefs[c.source];
    if (text === undefined) errors.push(`${at}: unknown source ${c.source}`);
    else if (!c.brief?.trim() || !normalizeQuote(text).includes(normalizeQuote(c.brief))) errors.push(`${at}: brief quote not found verbatim in ${c.source}`);
    if (!Array.isArray(c.checks) || c.checks.length === 0) errors.push(`${at}: needs at least one runnable check`);
    let shares = 0;
    let automated = 0;
    const unitIds = new Set<string>();
    for (const k of c.checks ?? []) {
      const kat = `${at} check ${k.id}`;
      if (unitIds.has(k.id)) errors.push(`${kat}: duplicate id`);
      unitIds.add(k.id);
      if (!KINDS.includes(k.kind)) errors.push(`${kat}: kind must be one of ${KINDS.join(",")}`);
      if (!(k.share > 0)) errors.push(`${kat}: share must be > 0`);
      shares += k.share;
      if (!(k.requires?.env?.length)) automated += k.share;
      if (!k.run?.trim()) errors.push(`${kat}: no command`);
      if (k.repeat !== undefined && !(Number.isInteger(k.repeat) && k.repeat >= 1)) errors.push(`${kat}: repeat must be an integer >= 1`);
      if (!Array.isArray(k.expect) || !k.expect.some((e) => !e.absent)) errors.push(`${kat}: needs at least one positive expectation`);
      let specific = false;
      for (const e of expandExpects(k.expect ?? [], "carp")) {
        let re: RegExp;
        try {
          re = new RegExp(e.re, e.flags ?? "m");
        } catch (err) {
          errors.push(`${kat}: bad regex /${e.re}/: ${err}`);
          continue;
        }
        if (e.re.includes("{")) {
          if (/\{(app|each)\}/.test(e.re)) errors.push(`${kat}: unexpanded placeholder in /${e.re}/`);
        }
        if (e.absent) continue;
        if (re.test("")) errors.push(`${kat}: /${e.re}/ matches empty output`);
        if (!re.test(GENERIC)) specific = true;
        const literal = e.re.replace(/\(\?<\w+>/g, "(").replace(/\\[a-zA-Z]/g, " ").replace(/\[[^\]]*\]/g, " ");
        if (!/[A-Za-z]{3,}/.test(literal)) errors.push(`${kat}: /${e.re}/ has no literal word to anchor on`);
        const groups = new Set([...e.re.matchAll(/\(\?<(\w+)>/g)].map((m) => m[1]));
        for (const g of Object.keys(e.bounds ?? {})) if (!groups.has(g)) errors.push(`${kat}: bound on unknown group ${g}`);
        for (const [a, b] of e.eq ?? []) if (!groups.has(a) || !groups.has(b)) errors.push(`${kat}: eq on unknown group ${a}/${b}`);
      }
      if (!specific) errors.push(`${kat}: every expectation matches generic output; add one specific to this check`);
    }
    for (const m of c.manual ?? []) {
      const mat = `${at} manual ${m.id}`;
      if (unitIds.has(m.id)) errors.push(`${mat}: duplicate id`);
      unitIds.add(m.id);
      if (!(m.share > 0)) errors.push(`${mat}: share must be > 0`);
      shares += m.share;
      if (!m.item?.trim()) errors.push(`${mat}: no item text`);
      if (!Array.isArray(m.evidence) || m.evidence.length === 0) errors.push(`${mat}: no evidence paths`);
    }
    if (Math.abs(shares - 1) > 1e-6) errors.push(`${at}: shares sum to ${shares.toFixed(3)}, must be 1`);
    if (c.threshold > automated + 1e-6) errors.push(`${at}: threshold ${c.threshold} needs a human or a live URL (automated share ${automated.toFixed(2)})`);
    maxAutomated += c.weight * automated;
  }
  if (weight !== 100) errors.push(`weights sum to ${weight}, must be 100`);
  if (maxAutomated + 1e-6 < (r.passBar?.total ?? 90)) errors.push(`automated checks can reach only ${maxAutomated.toFixed(1)}, below the pass bar`);
  return { errors, maxAutomated };
}

export function loadBriefs(): Record<string, string> {
  const read = (p: string) => (existsSync(path.join(REPO, p)) ? readFileSync(path.join(REPO, p), "utf8") : "");
  return { brief: read("docs/TASK_BRIEF.md"), overnight: read("docs/OVERNIGHT_BRIEF.md"), apps: read("docs/APPS.md") };
}

export function loadRubric(file = path.join(REPO, "docs/grading/rubric.json")): Rubric {
  return JSON.parse(readFileSync(file, "utf8"));
}

// ---------- grading ----------

export type GradeOptions = {
  fast?: boolean;
  only?: string[];
  app?: AppId;
  timeout?: number;
  env?: Record<string, string | undefined>;
  confirmations?: Record<string, Confirmation>;
  log?: (line: string) => void;
  runner?: (cmd: string, timeoutSec: number) => Promise<RunResult>;
};

export type CriterionResult = {
  c: Criterion;
  units: Unit[];
  score: number; // overall (or the selected app's) points
  appScores: Partial<Record<AppId, number>>;
  status: "PASS" | "FAIL" | "PENDING";
  note: string;
};

export type GradeResult = {
  criteria: CriterionResult[];
  total: number;
  possible: number;
  appTotals: Partial<Record<AppId, number>>;
  pass: boolean;
};

export async function grade(r: Rubric, opts: GradeOptions = {}): Promise<GradeResult> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? runCommand;
  const confirmations = opts.confirmations ?? loadConfirmations();
  const log = opts.log ?? (() => {});
  const cache = new Map<string, Promise<RunResult[]>>();
  const results: CriterionResult[] = [];

  const runRepeated = (cmd: string, timeout: number, repeat: number) => {
    const key = `${repeat}\u0000${cmd}`;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const runs: RunResult[] = [];
        for (let i = 0; i < repeat; i++) {
          const res = await runner(cmd, timeout);
          runs.push(res);
          if (res.timedOut || res.code !== 0) break;
        }
        return runs;
      })();
      cache.set(key, p);
    }
    return p;
  };

  for (const c of r.criteria) {
    if (opts.only?.length && !opts.only.includes(c.id)) continue;
    if (opts.app && !c.appliesTo.includes(opts.app)) continue;
    const apps = opts.app ? [opts.app] : c.appliesTo;
    const units: Unit[] = [];

    for (const k of c.checks) {
      const targets: (AppId | null)[] = checkIsPerApp(k) ? apps : [null];
      for (const app of targets) {
        const n = app ? c.appliesTo.length : 1;
        const unit: Unit = { criterion: c.id, id: k.id, app, kind: k.kind, share: k.share / n, appShare: k.share, status: "PENDING", reason: "", matched: [] };
        units.push(unit);
        const miss = missingRequirement(k.requires, app, env);
        if (miss) {
          unit.reason = miss;
        } else if (opts.fast && !FAST_KINDS.has(k.kind)) {
          unit.status = "SKIP";
          unit.reason = `skipped by --fast (${k.kind})`;
        } else {
          const cmd = expand(k.run, app);
          const runs = await runRepeated(cmd, k.timeout ?? opts.timeout ?? r.defaults?.timeout ?? 300, k.repeat ?? 1);
          const expects = expandExpects(k.expect, app);
          unit.status = "PASS";
          unit.reason = "ok";
          for (let i = 0; i < (k.repeat ?? 1); i++) {
            const run = runs[i];
            const j = run ? judgeRun(run, expects) : { ok: false, reason: "stopped after an earlier failed run", matched: [] };
            unit.matched = j.matched;
            if (!j.ok) {
              unit.status = "FAIL";
              unit.reason = (k.repeat ?? 1) > 1 ? `run ${i + 1}/${k.repeat}: ${j.reason}` : j.reason;
              break;
            }
          }
          if (unit.status === "PASS" && (k.repeat ?? 1) > 1) unit.reason = `${k.repeat} consecutive runs passed`;
        }
        log(`  CHECK ${c.id}/${k.id}${app ? "@" + app : ""} ${unit.status} ${unit.reason}`);
      }
    }

    for (const m of c.manual) {
      const targets: (AppId | null)[] = manualIsPerApp(m) ? apps : [null];
      for (const app of targets) {
        const n = app ? c.appliesTo.length : 1;
        const key = `${c.id}/${m.id}${app ? "@" + app : ""}`;
        const ev = m.evidence.map((p) => expand(p, app));
        const j = judgeManual(key, ev, confirmations);
        units.push({ criterion: c.id, id: m.id, app, kind: "manual", share: m.share / n, appShare: m.share, status: j.status, reason: j.reason, matched: [] });
        log(`  MANUAL ${key} ${j.status} ${j.reason}`);
      }
    }

    const appScores: Partial<Record<AppId, number>> = {};
    for (const a of c.appliesTo) {
      if (opts.app && a !== opts.app) continue;
      const mine = units.filter((u) => u.app === null || u.app === a);
      const earned = mine.filter((u) => u.status === "PASS").reduce((s, u) => s + u.appShare, 0);
      appScores[a] = c.weight * earned;
    }
    const score = opts.app ? appScores[opts.app] ?? 0 : c.weight * units.filter((u) => u.status === "PASS").reduce((s, u) => s + u.share, 0);
    const met = score + EPS >= c.threshold * c.weight;
    const firstFail = units.find((u) => u.status === "FAIL");
    const firstOpen = units.find((u) => u.status === "PENDING" || u.status === "SKIP");
    const status: CriterionResult["status"] = met ? "PASS" : firstFail ? "FAIL" : "PENDING";
    const label = (u: Unit) => `${u.id}${u.app ? "@" + u.app : ""}: ${u.reason}`;
    const note = met
      ? evidenceNote(c, units)
      : firstFail
        ? label(firstFail)
        : firstOpen
          ? label(firstOpen)
          : "below threshold";
    results.push({ c, units, score, appScores, status, note });
  }

  const total = results.reduce((s, x) => s + x.score, 0);
  const possible = results.reduce((s, x) => s + x.c.weight, 0);
  const appTotals: Partial<Record<AppId, number>> = {};
  for (const a of opts.app ? [opts.app] : APPS) {
    const rel = results.filter((x) => x.c.appliesTo.includes(a));
    const w = rel.reduce((s, x) => s + x.c.weight, 0);
    appTotals[a] = w ? (100 * rel.reduce((s, x) => s + (x.appScores[a] ?? 0), 0)) / w : 0;
  }
  const normTotal = possible ? (100 * total) / possible : 0;
  const pass = results.every((x) => x.status === "PASS") && normTotal + EPS >= (r.passBar?.total ?? 90) && results.length > 0;
  return { criteria: results, total: normTotal, possible, appTotals, pass };
}

function evidenceNote(c: Criterion, units: Unit[]): string {
  const m = units.find((u) => u.status === "PASS" && u.matched.length);
  if (m) return `${m.id}${m.app ? "@" + m.app : ""}: ${m.matched[0]}`;
  const man = c.manual.find((x) => x.evidence.length);
  return man ? man.evidence[0] : "all checks passed";
}

// ---------- report ----------

const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

export function gradeLine(x: CriterionResult): string {
  return `GRADE ${x.c.id} ${fmt(x.score)}/${x.c.weight} ${x.status} ${x.note}`;
}

function gitHead(): string {
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO });
    const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO }).stdout.toString().trim() ? "+dirty" : "";
    return p.stdout.toString().trim() + dirty;
  } catch {
    return "unknown";
  }
}

export function renderReport(g: GradeResult, mode: string): string {
  const L: string[] = [];
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  L.push("# Grading report", "");
  L.push(`Generated by \`bun run grade\` (${mode}) at ${new Date().toISOString()} on commit ${gitHead()}. Rubric: \`docs/grading/rubric.json\`; criteria explained in \`docs/grading/rubric.md\`.`, "");
  L.push(`**Total ${fmt(g.total)} / 100. Result: ${g.pass ? "PASS" : "FAIL"}** (pass bar: every criterion at its threshold and a total of at least 90).`, "");
  L.push("| App | Score |", "|---|---|");
  for (const [a, v] of Object.entries(g.appTotals)) L.push(`| ${a} | ${fmt(v!)} / 100 |`);
  L.push("");
  const counts = { PASS: 0, FAIL: 0, PENDING: 0 };
  for (const x of g.criteria) counts[x.status]++;
  L.push(`Criteria: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.PENDING} pending.`, "");
  L.push("| Criterion | Score | Threshold | Status | carp | lionfish | python | Evidence or reason |", "|---|---|---|---|---|---|---|---|");
  for (const x of g.criteria) {
    const app = (a: AppId) => (x.appScores[a] === undefined ? "-" : `${fmt(x.appScores[a]!)}`);
    L.push(`| ${x.c.id} | ${fmt(x.score)}/${x.c.weight} | ${fmt(x.c.threshold * x.c.weight)} | ${x.status} | ${app("carp")} | ${app("lionfish")} | ${app("python")} | ${cell(x.note)} |`);
  }
  L.push("", "## Checks", "");
  for (const x of g.criteria) {
    L.push(`### ${x.c.id}: ${x.c.title}`, "", `Brief: "${x.c.brief}"`, "");
    for (const u of x.units) {
      const head = `- ${u.status} \`${u.id}${u.app ? "@" + u.app : ""}\` (${u.kind}, ${fmt(u.share * x.c.weight)} pts): ${u.reason}`;
      L.push(head);
      for (const m of u.matched) L.push(`  - \`${m.replace(/`/g, "'")}\``);
    }
    L.push("");
  }
  const open = g.criteria.flatMap((x) => x.units.filter((u) => u.status !== "PASS").map((u) => ({ x, u })));
  if (open.length) {
    L.push("## Open items", "");
    for (const { x, u } of open) L.push(`- ${u.status} ${x.c.id}/${u.id}${u.app ? "@" + u.app : ""}: ${u.reason}`);
    L.push("");
  }
  return L.join("\n");
}

// ---------- probes (the rubric calls these) ----------

function probeConfig(app: string): number {
  const file = path.join(REPO, "spec/apps", `${app}.json`);
  if (!existsSync(file)) {
    console.log(`CONFIG app=${app} missing`);
    return 1;
  }
  let cfg: any;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`CONFIG app=${app} invalid ${err}`);
    return 1;
  }
  const feeds = Array.isArray(cfg.feeds) ? cfg.feeds : [];
  const sources = new Set(feeds.map((f: any) => f?.source).filter((s: unknown) => typeof s === "string" && s));
  const question = typeof cfg.question === "string" && cfg.question.trim().length > 10 ? 1 : 0;
  const helpers = Array.isArray(cfg.helperQuestions) ? cfg.helperQuestions.length : 0;
  console.log(`CONFIG app=${cfg.id ?? "?"} question=${question} feeds=${feeds.length} sources=${sources.size} helpers=${helpers}`);
  return 0;
}

function sectionOf(text: string, pattern: string): string | null {
  const lines = text.split("\n");
  const re = new RegExp(pattern, "i");
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && re.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function probeDoc(args: string[]): number {
  const file = args[0];
  const opt = (name: string) => {
    const out: string[] = [];
    args.forEach((a, i) => a === name && args[i + 1] !== undefined && out.push(args[i + 1]));
    return out;
  };
  const abs = path.resolve(REPO, file ?? "");
  if (!file || !existsSync(abs)) {
    console.log(`DOC path=${file} missing`);
    return 1;
  }
  let text = readFileSync(abs, "utf8");
  const section = opt("--section")[0];
  let label = "";
  if (section) {
    const s = sectionOf(text, section);
    if (s === null) {
      console.log(`DOC path=${file} section=${section} missing`);
      return 1;
    }
    text = s;
    label = ` section=${section}`;
  }
  const words = (text.match(/[A-Za-z0-9][\w'’-]*/g) ?? []).length;
  const needs = opt("--need").map(parseRegexArg);
  const met = needs.filter((r) => r.test(text)).length;
  let line = `DOC path=${file}${label} words=${words} needs=${met}/${needs.length}`;
  const eachHead = opt("--each-section")[0];
  if (eachHead) {
    const headRe = new RegExp(eachHead, "m");
    const eachNeeds = opt("--each-need").map(parseRegexArg);
    const chunks: string[] = [];
    let cur: string[] | null = null;
    for (const l of text.split("\n")) {
      if (headRe.test(l)) {
        if (cur) chunks.push(cur.join("\n"));
        cur = [l];
      } else if (cur) cur.push(l);
    }
    if (cur) chunks.push(cur.join("\n"));
    const complete = eachNeeds.length ? chunks.filter((ch) => eachNeeds.every((r) => r.test(ch))).length : 0;
    line += ` sections=${chunks.length} complete=${complete}`;
  }
  console.log(line);
  return 0;
}

function probeIngest(app: string): number {
  const file = path.join(REPO, "docs/ingest-modes.md");
  if (!existsSync(file)) {
    console.log(`INGEST app=${app} missing`);
    return 1;
  }
  const appRe = new RegExp(`\\b${app}\\b`, "i");
  const mechRe = /^(push|webhook|poll)\b/i;
  const whyNoPush = /no (push|webhook|stream|subscription|notification)|not offer|does ?n[o']t (offer|provide|support|have)|without (a )?(push|webhook)|none (found|exists?|available)|only (email|sms)|needs? an? (emailed )?application/i;
  // A row may justify itself, or point at another row ("same as L1", "same push search as C4") that does.
  type Row = { id: string; line: string; mech: string; app: boolean; url: boolean; own: boolean; refs: string[] };
  const all: Row[] = [];
  // Only tables whose header has an "App" column count; the app is read from that column.
  let header: string[] | null = null;
  let inTable = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.replace(/[`*_]/g, "").trim());
    if (!inTable) {
      inTable = true;
      header = cells;
      continue;
    }
    if (/^\|\s*:?-{3,}/.test(t)) continue;
    const appCol = header?.findIndex((h) => /^apps?$/i.test(h)) ?? -1;
    if (appCol < 0) continue;
    const mechCol = header!.findIndex((h) => /mechanism|mode/i.test(h));
    const mechCell = mechCol >= 0 ? cells[mechCol] : cells.find((c) => mechRe.test(c));
    const mech = mechCell?.match(mechRe)?.[1].toLowerCase();
    if (!mech) continue;
    const refs = [...line.matchAll(/\b(?:same|as)\b[^|]{0,40}?\b([A-Z]{1,2}\d{1,2})\b/g)].map((m) => m[1]);
    all.push({ id: cells[0], line, mech, app: appRe.test(cells[appCol] ?? ""), url: /https?:\/\/\S+/.test(line), own: whyNoPush.test(line), refs });
  }
  const byId = new Map(all.map((r) => [r.id, r]));
  const justifiedRow = (r: Row, seen = new Set<string>()): boolean => {
    if (r.own) return true;
    seen.add(r.id);
    return r.refs.some((id) => !seen.has(id) && byId.has(id) && justifiedRow(byId.get(id)!, seen));
  };
  const mine = all.filter((r) => r.app);
  const polls = mine.filter((r) => r.mech === "poll");
  const bad = polls.filter((r) => !(r.url && justifiedRow(r)));
  console.log(`INGEST app=${app} rows=${mine.length} push=${mine.length - polls.length} poll=${polls.length} poll_justified=${polls.length - bad.length} urls=${mine.filter((r) => r.url).length}`);
  for (const r of bad) console.log(`INGEST-UNJUSTIFIED ${r.id} url=${r.url ? 1 : 0} reason=${r.own ? 1 : 0}`);
  for (const r of mine.filter((x) => !x.url)) console.log(`INGEST-NO-URL ${r.id}`);
  return 0;
}

// ---------- CLI ----------

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function confirm(argv: string[]): Promise<number> {
  const key = argValue(argv, "--confirm");
  const by = argValue(argv, "--by");
  if (!key || !by?.trim()) {
    console.error("usage: bun scripts/grade.ts --confirm <criterion>/<manual>[@app] --by <name>");
    return 2;
  }
  if (!process.stdin.isTTY) {
    console.error("refused: sign-off needs a human at a terminal (stdin is not a TTY)");
    return 2;
  }
  const [cid, rest] = key.split("/");
  const [mid, app] = (rest ?? "").split("@");
  const r = loadRubric();
  const m = r.criteria.find((c) => c.id === cid)?.manual.find((x) => x.id === mid);
  if (!m) {
    console.error(`unknown manual item ${key}`);
    return 2;
  }
  const ev = m.evidence.map((p) => expand(p, (app as AppId) || null));
  const hash = evidenceHash(ev);
  if (!hash) {
    console.error(`evidence missing or empty: ${ev.join(", ")}`);
    return 2;
  }
  console.log(`${m.item}\nEvidence: ${ev.join(", ")}\nType "yes" to confirm you checked this yourself:`);
  const answer = (await new Promise<string>((res) => process.stdin.once("data", (d) => res(String(d))))).trim();
  process.stdin.pause();
  if (answer !== "yes") {
    console.error("not confirmed");
    return 1;
  }
  const all = loadConfirmations();
  all[key] = { by: by.trim(), at: new Date().toISOString().slice(0, 10), sha256: hash };
  writeFileSync(CONFIRMATIONS, JSON.stringify(all, null, 2) + "\n");
  console.log(`CONFIRMED ${key} by ${by.trim()}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--probe")) {
    const [what, ...rest] = argv.slice(argv.indexOf("--probe") + 1);
    if (what === "config") return probeConfig(rest[0] ?? "");
    if (what === "doc") return probeDoc(rest);
    if (what === "ingest") return probeIngest(rest[0] ?? "");
    console.error(`unknown probe ${what}`);
    return 2;
  }
  if (argv.includes("--confirm")) return confirm(argv);

  const rubric = loadRubric();
  const { errors, maxAutomated } = validateRubric(rubric, loadBriefs());
  const weight = rubric.criteria.reduce((s, c) => s + c.weight, 0);
  if (errors.length || argv.includes("--validate")) {
    for (const e of errors) console.log(`RUBRIC-ERROR ${e}`);
    console.log(`RUBRIC max_without_human=${fmt(maxAutomated)} checks=${rubric.criteria.reduce((s, c) => s + c.checks.length, 0)} manual=${rubric.criteria.reduce((s, c) => s + c.manual.length, 0)}`);
    console.log(`RUBRIC criteria=${rubric.criteria.length} weight=${weight} ${errors.length ? `invalid errors=${errors.length}` : "ok"}`);
    return errors.length ? 1 : 0;
  }

  const app = argValue(argv, "--app") as AppId | undefined;
  if (app && !APPS.includes(app)) {
    console.error(`unknown app ${app}; one of ${APPS.join(", ")}`);
    return 2;
  }
  const only = argValue(argv, "--only")?.split(",").filter(Boolean);
  const unknown = only?.filter((id) => !rubric.criteria.some((c) => c.id === id));
  if (unknown?.length) {
    console.error(`unknown criteria: ${unknown.join(", ")}`);
    return 2;
  }
  const timeout = Number(argValue(argv, "--timeout")) || undefined;
  const fast = argv.includes("--fast");
  const verbose = !argv.includes("--quiet");
  const g = await grade(rubric, { fast, only, app, timeout, log: verbose ? (l) => console.log(l) : undefined });
  for (const x of g.criteria) console.log(gradeLine(x));
  const counts = { PASS: 0, FAIL: 0, PENDING: 0 };
  for (const x of g.criteria) counts[x.status]++;
  const apps = Object.entries(g.appTotals).map(([a, v]) => `${a}=${fmt(v!)}`).join(" ");
  console.log(`TOTAL ${fmt(g.total)}/100 ${apps} pass=${counts.PASS} fail=${counts.FAIL} pending=${counts.PENDING}`);
  const mode = [fast ? "--fast" : "full", app ? `--app ${app}` : "", only ? `--only ${only.join(",")}` : ""].filter(Boolean).join(" ");
  if (!argv.includes("--no-write")) {
    const out = path.join(REPO, "docs/grading/report.md");
    writeFileSync(out, renderReport(g, mode) + "\n");
    console.log(`REPORT ${path.relative(REPO, out)}`);
  }
  console.log(`GRADE-RESULT ${g.pass ? "PASS" : "FAIL"}`);
  return g.pass ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
