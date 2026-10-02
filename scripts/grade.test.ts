import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  grade,
  judgeManual,
  judgeRun,
  loadBriefs,
  loadRubric,
  missingRequirement,
  runCommand,
  validateRubric,
  type Check,
  type Criterion,
  type Rubric,
} from "./grade";

const LINE = "SCRUB app=carp median=8.7 p95=14.2 requests=0 frames=96";
const scrubExpect = [{ re: "^SCRUB app=carp\\b.*\\bmedian=(?<m>[0-9.]+)", bounds: { m: { max: 15.99 } } }];

function rubricWith(check: Partial<Check>, extra: Partial<Criterion> = {}): Rubric {
  const c: Criterion = {
    id: "x",
    title: "x",
    group: "technical",
    source: "brief",
    brief: "the timeline scrubs smoothly",
    weight: 100,
    appliesTo: ["carp"],
    threshold: 1,
    checks: [{ id: "c", kind: "static", share: 1, run: "true", expect: scrubExpect, ...check } as Check],
    manual: [],
    ...extra,
  };
  return { version: 1, apps: ["carp", "lionfish", "python"], passBar: { total: 90, everyCriterionAtThreshold: true }, defaults: { timeout: 5 }, criteria: [c] };
}

describe("judgeRun: no fake pass", () => {
  test("a passing run earns", () => {
    expect(judgeRun({ code: 0, out: LINE, timedOut: false, ms: 1 }, scrubExpect).ok).toBe(true);
  });
  test("non-zero exit never earns, even with the right line", () => {
    const j = judgeRun({ code: 1, out: LINE, timedOut: false, ms: 1 }, scrubExpect);
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("exit 1");
  });
  test("timeout never earns, even with the right line", () => {
    expect(judgeRun({ code: null, out: LINE, timedOut: true, ms: 5000 }, scrubExpect).ok).toBe(false);
  });
  test("empty output never earns", () => {
    expect(judgeRun({ code: 0, out: "  \n", timedOut: false, ms: 1 }, scrubExpect).ok).toBe(false);
  });
  test("a number outside its bound fails", () => {
    const j = judgeRun({ code: 0, out: LINE.replace("8.7", "16.0"), timedOut: false, ms: 1 }, scrubExpect);
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("above 15.99");
  });
  test("eq groups must be equal (P/T)", () => {
    const e = [{ re: "^EVAL passed (?<p>\\d+)/(?<t>\\d+)$", eq: [["p", "t"]] as [string, string][] }];
    expect(judgeRun({ code: 0, out: "EVAL passed 47/48", timedOut: false, ms: 1 }, e).ok).toBe(false);
    expect(judgeRun({ code: 0, out: "EVAL passed 48/48", timedOut: false, ms: 1 }, e).ok).toBe(true);
  });
  test("minCount and absent are enforced", () => {
    const e = [
      { re: "^test \\S+ \\.\\.\\. ok$", minCount: 2 },
      { re: "^test result: FAILED", absent: true },
    ];
    expect(judgeRun({ code: 0, out: "test a ... ok", timedOut: false, ms: 1 }, e).ok).toBe(false);
    expect(judgeRun({ code: 0, out: "test a ... ok\ntest b ... ok\ntest result: FAILED", timedOut: false, ms: 1 }, e).ok).toBe(false);
    expect(judgeRun({ code: 0, out: "test a ... ok\ntest b ... ok", timedOut: false, ms: 1 }, e).ok).toBe(true);
  });
  test("a check with only negative expectations cannot pass", () => {
    expect(judgeRun({ code: 0, out: "anything", timedOut: false, ms: 1 }, [{ re: "FAILED", absent: true }]).ok).toBe(false);
  });
});

describe("runCommand", () => {
  test("kills a command that outlives its timeout", async () => {
    const r = await runCommand(`echo "${LINE}"; sleep 30`, 1);
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(5000);
  });
  test("captures stdout, stderr and the exit code", async () => {
    const r = await runCommand("echo out; echo err 1>&2; exit 3", 5);
    expect(r.code).toBe(3);
    expect(r.out).toContain("out");
    expect(r.out).toContain("err");
  });
});

describe("grade: end to end on synthetic rubrics", () => {
  test("a missing prerequisite is PENDING and scores 0", async () => {
    const g = await grade(rubricWith({ run: `echo "${LINE}"`, requires: { files: ["does/not/exist.txt"] } }), { confirmations: {} });
    expect(g.criteria[0].status).toBe("PENDING");
    expect(g.criteria[0].score).toBe(0);
    expect(g.criteria[0].note).toContain("missing does/not/exist.txt");
  });
  test("an emitter that does not print the line yet is PENDING", async () => {
    const g = await grade(rubricWith({ run: `echo "${LINE}"`, requires: { contains: [{ path: "scripts/grade.test.ts", text: "NO-SUCH-EMITTER" + "-LINE" }] } }), { confirmations: {} });
    expect(g.criteria[0].status).toBe("PENDING");
    expect(g.criteria[0].score).toBe(0);
  });
  test("failing, timed-out and silent commands score 0 and FAIL", async () => {
    for (const run of [`echo "${LINE}"; exit 1`, `echo "${LINE}"; sleep 10`, "true"]) {
      const g = await grade(rubricWith({ run, timeout: 1 }), { confirmations: {} });
      expect(g.criteria[0].score).toBe(0);
      expect(g.criteria[0].status).toBe("FAIL");
      expect(g.pass).toBe(false);
    }
  });
  test("a real pass scores the full weight and passes the bar", async () => {
    const g = await grade(rubricWith({ run: `echo "${LINE}"` }), { confirmations: {} });
    expect(g.criteria[0].status).toBe("PASS");
    expect(g.total).toBe(100);
    expect(g.pass).toBe(true);
  });
  test("repeat: one bad run out of three earns nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grade-"));
    const counter = path.join(dir, "n");
    writeFileSync(counter, "0");
    const run = `n=$(cat ${counter}); n=$((n+1)); echo $n > ${counter}; if [ $n -eq 2 ]; then echo "${LINE.replace("8.7", "40")}"; else echo "${LINE}"; fi`;
    const g = await grade(rubricWith({ run, repeat: 3 }), { confirmations: {} });
    expect(g.criteria[0].score).toBe(0);
    expect(g.criteria[0].note).toContain("run 2/3");
  });
  test("--fast skips e2e and live checks and they score 0", async () => {
    const g = await grade(rubricWith({ run: `echo "${LINE}"`, kind: "e2e" }), { fast: true, confirmations: {} });
    expect(g.criteria[0].status).toBe("PENDING");
    expect(g.criteria[0].score).toBe(0);
  });
  test("per-app checks split the share across apps", async () => {
    const r = rubricWith({ run: `[ {app} = carp ] && echo "SCRUB app={app} median=8"` , expect: [{ re: "^SCRUB app={app} median=(?<m>\\d+)", bounds: { m: { max: 15 } } }] }, { appliesTo: ["carp", "lionfish"] });
    const g = await grade(r, { confirmations: {} });
    expect(g.criteria[0].score).toBe(50);
    expect(g.appTotals.carp).toBe(100);
    expect(g.appTotals.lionfish).toBe(0);
  });
  test("an env-gated check is PENDING without the env", async () => {
    const g = await grade(rubricWith({ run: `echo "${LINE}"`, requires: { env: ["GRADE_TEST_UNSET_VAR"] } }), { env: {}, confirmations: {} });
    expect(g.criteria[0].status).toBe("PENDING");
    expect(g.criteria[0].score).toBe(0);
  });
});

describe("manual items", () => {
  test("no sign-off, or a sign-off on changed evidence, earns nothing", () => {
    expect(judgeManual("x/y", ["docs/TASK_BRIEF.md"], {}).status).toBe("PENDING");
    expect(judgeManual("x/y", ["docs/TASK_BRIEF.md"], { "x/y": { by: "someone", at: "2026-10-01", sha256: "stale" } }).status).toBe("PENDING");
    expect(judgeManual("x/y", ["docs/missing-evidence.png"], {}).reason).toContain("missing");
  });
});

describe("rubric validation", () => {
  const briefs = loadBriefs();
  test("the real rubric is valid, sums to 100 and can reach the bar without humans", () => {
    const { errors, maxAutomated } = validateRubric(loadRubric(), briefs);
    expect(errors).toEqual([]);
    expect(maxAutomated).toBeGreaterThanOrEqual(90);
  });
  test("rejects vacuous regexes, wrong weights and invented brief quotes", () => {
    const bad = rubricWith({ expect: [{ re: ".*" }] }, { weight: 99, brief: "the brief never said this" });
    const { errors } = validateRubric(bad, briefs);
    expect(errors.some((e) => e.includes("matches empty output"))).toBe(true);
    expect(errors.some((e) => e.includes("weights sum to 99"))).toBe(true);
    expect(errors.some((e) => e.includes("brief quote not found"))).toBe(true);
  });
  test("rejects a check whose expectations a stub could satisfy", () => {
    const { errors } = validateRubric(rubricWith({ expect: [{ re: "^\\s*0 fail$" }] }), briefs);
    expect(errors.some((e) => e.includes("generic output"))).toBe(true);
  });
  test("rejects a threshold only a human could reach", () => {
    const r = rubricWith({ share: 0.5 }, { manual: [{ id: "m", share: 0.5, item: "look", evidence: ["docs/TASK_BRIEF.md"] }] });
    const { errors } = validateRubric(r, briefs);
    expect(errors.some((e) => e.includes("needs a human"))).toBe(true);
  });
});

describe("requirements", () => {
  test("detects missing package scripts and present ones", () => {
    expect(missingRequirement({ scripts: ["apps/web:e2e:no-such-script"] }, null)).toContain("missing script");
    expect(missingRequirement({ scripts: ["root:eval"] }, null)).toBeNull();
    expect(missingRequirement({ files: ["docs/TASK_BRIEF.md"] }, null)).toBeNull();
  });
});
