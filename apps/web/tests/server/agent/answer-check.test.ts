import { describe, expect, test } from "bun:test";

import { answerProblems, boundaryCategory, capturing, revisionRequest, type ToolCapture } from "@/server/agent/answer-check";
import { CapabilityRegistry, type CapabilityContext } from "@/server/agent/runtime/registry";
import { getApp } from "@/shared/apps";
import { z } from "zod";

const CARP = getApp("carp");
const nominal = { source: "usgs", mode: "poll", state: "nominal", newestObservedAt: "2026-10-01T06:30:00Z", lastFetchAt: "2026-10-01T06:46:00Z", lagSeconds: 1800, note: null } as const;
const capture = (text: string, feeds: ToolCapture["feeds"] = [nominal as unknown as ToolCapture["feeds"][number]]): ToolCapture => ({ name: "river_readings", text, feeds });

/**
 * The runtime answer check is generic: it never reads the question files. It holds every answer to the
 * grounding rules (numbers from tools, freshness said, degraded feeds named, boundary limits stated) and
 * asks for one revision with instructions the model can act on.
 */
describe("agent answer check", () => {
  test("a grounded, fresh answer has no problems", () => {
    const problems = answerProblems({
      app: CARP,
      question: "What is the river stage at Krotz Springs right now?",
      content: "USGS reads 1.65 ft at Krotz Springs [e:reading:07381500:stage_m:1790834400000:measured], 1 hour old.",
      captures: [capture('{"rows":[{"site":"KRZL1","latest":{"value":1.65},"ageHours":1}]}')],
    });
    expect(problems).toEqual([]);
  });

  test("a number no tool returned, a missing freshness line and a degraded feed left unnamed each become one instruction", () => {
    const stale = { ...nominal, source: "nwps", state: "stale" } as unknown as ToolCapture["feeds"][number];
    const problems = answerProblems({
      app: CARP,
      question: "What is the river stage at Krotz Springs right now?",
      content: "USGS reads 1.72 ft at Krotz Springs [e:reading:07381500:stage_m:1790834400000:measured].",
      captures: [capture('{"rows":[{"site":"KRZL1","latest":{"value":1.65}}]}', [stale])],
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/these numbers appear in no tool result: 1\.72/);
    expect(problems[1]).toMatch(/does not say how fresh/);
    expect(problems[2]).toMatch(/feed nwps is stale .* never says "stale"/);
  });

  test("an answer with no tool results (a refusal) is not asked for freshness", () => {
    const problems = answerProblems({ app: CARP, question: "Tell me about the Atchafalaya.", content: "The feeds hold river conditions at eight demonstration locations.", captures: [] });
    expect(problems).toEqual([]);
  });

  test("boundary questions are recognised by category from the app's own boundary note, and a reply without a stated limit is sent back", () => {
    expect(boundaryCategory(CARP, "How many carp are in the Atchafalaya right now?")).toBe("abundance or catch");
    expect(boundaryCategory(CARP, "Expected catch at Simmesport tomorrow, ballpark?")).toBe("abundance or catch");
    expect(boundaryCategory(CARP, "is fishing permitted at butte la rose?")).toBe("legal access");
    expect(boundaryCategory(CARP, "Is it safe to take the boat out at Morgan City tomorrow?")).toBe("trip safety");
    expect(boundaryCategory(CARP, "Can we take the airboat out at Bogalusa tomorrow?")).toBe("trip safety");
    expect(boundaryCategory(CARP, "Does rising water make carp move into the Atchafalaya?")).toBe("causal claims about the fish");
    // Licence questions about the data are sources questions; river questions are not boundary questions.
    expect(boundaryCategory(CARP, "Can we reuse the USGS and NWS data in our own reports? What licence is it under?")).toBeNull();
    expect(boundaryCategory(CARP, "What is the river stage at Krotz Springs right now?")).toBeNull();
    expect(boundaryCategory(getApp("python"), "How many pythons are in the Everglades?")).toBeNull();

    const verdict = answerProblems({ app: CARP, question: "Is it safe to take the boat out at Morgan City tomorrow?", content: "The forecast stage is 4 ft, issued 2026-09-30 10:32 CDT [e:forecast:MCGL1:1790782320000].", captures: [capture('{"peak":4}')] });
    expect(verdict).toEqual(["this question asks about trip safety, which the data cannot judge: say so in words (for example 'cannot'), keep the conditions you can show, and give no verdict or estimate"]);
    const limited = answerProblems({ app: CARP, question: "Is it safe to take the boat out at Morgan City tomorrow?", content: "The forecast stage is 4 ft, issued 2026-09-30 10:32 CDT [e:forecast:MCGL1:1790782320000]. It cannot say whether that is safe.", captures: [capture('{"peak":4}')] });
    expect(limited).toEqual([]);
  });

  test("provenance is complete: every feed source_info returned is cited, and a record fetched through evidence carries its licence as written", () => {
    const sources: ToolCapture = { name: "source_info", text: JSON.stringify({ rows: [{ feed: "usgs", cite: "[e:source:usgs]" }, { feed: "iem", cite: "[e:source:iem]" }] }), feeds: [] };
    const record: ToolCapture = { name: "evidence", text: JSON.stringify({ id: "reading:07381490:stage_m:1:measured", licence: "U.S. Government work, public domain (no licence needed); provisional" }), feeds: [] };
    const partial = answerProblems({ app: CARP, question: "Where does the stage number for Simmesport come from?", content: "USGS station 07381490, fetched 2026-10-01 01:50 CDT [e:source:usgs].", captures: [sources, record] });
    expect(partial).toEqual([
      "source_info returned feeds the answer does not cite: iem [e:source:iem]. Name each feed and paste its marker",
      "the record reading:07381490:stage_m:1:measured was fetched for its provenance: say its licence as written, 'U.S. Government work, public domain'",
    ]);
    const full = answerProblems({ app: CARP, question: "Where does the stage number for Simmesport come from?", content: "USGS station 07381490 (U.S. Government work, public domain), fetched 2026-10-01 01:50 CDT [e:source:usgs]; the IEM archive [e:source:iem].", captures: [sources, record] });
    expect(full).toEqual([]);
  });

  test("the revision request lists every problem and asks for the whole answer", () => {
    const text = revisionRequest(["these numbers appear in no tool result: 1.72"]);
    expect(text).toContain("complete corrected answer");
    expect(text).toContain("- these numbers appear in no tool result: 1.72");
  });

  test("capturing keeps every successful output's model-facing JSON and feeds, in call order", async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      name: "probe",
      description: "test",
      inputSchema: z.object({ n: z.number() }),
      async execute(input: { n: number }) {
        if (input.n < 0) throw new Error("negative");
        return { data: { n: input.n }, evidence: [], feeds: [nominal as unknown as ToolCapture["feeds"][number]], count: 1 };
      },
    });
    const into: ToolCapture[] = [];
    const wrapped = capturing(registry, into);
    const ctx = { app: CARP, now: new Date(), emit: () => {} } as unknown as CapabilityContext;
    await wrapped.execute("probe", { n: 1 }, ctx);
    await wrapped.execute("probe", { n: -1 }, ctx);
    await wrapped.execute("probe", { n: 2 }, ctx);
    expect(into.map((c) => c.text)).toEqual(['{"n":1}', '{"n":2}']);
    expect(into[0]!.feeds[0]!.source).toBe("usgs");
  });
});
