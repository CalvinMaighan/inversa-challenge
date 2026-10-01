import { describe, expect, test } from "bun:test";

import { answerProblems, revisionRequest } from "@/server/agent/answer-check";
import { supportedQuestions } from "@/shared/apps/questions";

const question = (id: string) => supportedQuestions("carp").find((q) => q.id === id)!;
const feedOf = (id: string) => ({ "status:MCGL1": "nwps", "reading:usgs:1": "usgs", "alert:1": "nws-alerts" })[id];

describe("agent carp answer check", () => {
  test("a complete answer has no problems", () => {
    const problems = answerProblems(question("carp-lookup-review-today"), {
      content: "MCGL1 needs operational review because a Flood Advisory is active [e:status:MCGL1] [e:reading:usgs:1] [e:alert:1]; data updated 2 h ago.",
      tools: ["site_status", "set_view"],
      cited: ["status:MCGL1", "reading:usgs:1", "alert:1"],
      feedOf,
    });
    expect(problems).toEqual([]);
  });

  test("missing wording, tool and feed citation each become one instruction", () => {
    const problems = answerProblems(question("carp-lookup-review-today"), {
      content: "MCGL1 is flagged [e:status:MCGL1]. Data updated 2 h ago.",
      tools: ["site_status"],
      cited: ["status:MCGL1"],
      feedOf,
    });
    expect(problems).toContain("call the set_view tool (it was not called) and use its result");
    expect(problems).toContain("use the wording 'needs operational review' (in those words)");
    expect(problems).toContain("use the wording 'because' (in those words)");
    expect(problems).toContain("cite a record or check marker from the usgs feed");
    expect(problems).toContain("cite a record or check marker from the nws feed");
    expect(problems.some((p) => p.includes("nwps"))).toBe(false);
  });

  test("forbidden wording is quoted back; a refusal that called tools is told so; curly quotes count as plain", () => {
    const why = answerProblems(question("carp-relevance-why-these-sites"), {
      content: "These are Inversa's operating areas in the Atchafalaya with USGS, NWPS and NWS coverage, a demonstration set [e:status:MCGL1] [e:reading:usgs:1] [e:alert:1], updated 2 h ago.",
      tools: ["site_status", "source_info"],
      cited: ["status:MCGL1", "reading:usgs:1", "alert:1"],
      feedOf,
    });
    expect(why).toEqual([`remove the wording "Inversa's operating areas" (and say nothing like it)`]);
    const refusal = question("carp-boundary-abundance");
    expect(answerProblems(refusal, { content: "It can’t estimate abundance or how many carp there are: the feeds hold river conditions only.", tools: ["site_status"], cited: [], feedOf })).toEqual([
      "this question is refused from the boundary alone: answer without tool results",
    ]);
  });

  test("the revision request lists every problem and asks for the whole answer", () => {
    const text = revisionRequest(["use the wording 'because' (in those words)"]);
    expect(text).toContain("complete corrected answer");
    expect(text).toContain("- use the wording 'because' (in those words)");
  });
});
