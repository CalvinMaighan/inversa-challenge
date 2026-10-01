import { describe, expect, test } from "bun:test";

import { hintFromPattern, matchSupportedQuestion, questionLine, questionTerms, supportedQuestions } from "@/shared/apps/questions";

describe("supported questions", () => {
  test("every app has its documented questions: carp 69, lionfish 65, python 68", () => {
    expect(supportedQuestions("carp")).toHaveLength(69);
    expect(supportedQuestions("lionfish")).toHaveLength(65);
    expect(supportedQuestions("python")).toHaveLength(68);
  });

  test("pass regexes become wording hints", () => {
    expect(hintFromPattern("needs? (operational )?review")).toBe("needs operational review");
    expect(hintFromPattern("\\bft\\b|feet")).toBe("ft");
    expect(hintFromPattern("(24 ?h|24 hours|last day|past day)")).toBe("24 h");
    expect(hintFromPattern("(because|reason|due to)")).toBe("because");
    expect(hintFromPattern("(\\d+(\\.\\d+)? ?(h|hours?|min|minutes?|days?) (old|ago)|as of|updated|fetched)")).toBe("h old");
    expect(hintFromPattern("(\\u00B0F|degrees|\\bF\\b)")).toBe("°F");
    expect(hintFromPattern("low[- ]water|low threshold")).toBe("low-water");
    const weather = questionLine(supportedQuestions("carp").find((q) => q.id === "carp-lookup-weather-morgan-city")!);
    expect(weather).toContain("wording: '°F', 'wind', 'updat'");
    const start = questionLine(supportedQuestions("carp").find((q) => q.id === "carp-explain-start-review")!);
    expect(start).not.toContain("': am'");
    expect(hintFromPattern("(cannot|can't|can ?not|unable to|do not|don't|does not|doesn't|is not|isn't|no data|not something)(?:[^.]|\\.\\d){0,80}(abundance|how many|number of carp|carp (numbers|population|counts))")).toBe("cannot abundance");
  });

  test("a question matches its documented form exactly, a paraphrase closely, an unrelated one not at all", () => {
    expect([...questionTerms("Which locations need operational review today?")].sort()).toEqual(["location", "need", "operational", "review"]);
    expect(matchSupportedQuestion("carp", "Which locations need operational review today?")).toMatchObject({ score: 1, question: { id: "carp-lookup-review-today" } });
    expect(matchSupportedQuestion("carp", "which locations need review today")?.question.id).toBe("carp-lookup-review-today");
    expect(matchSupportedQuestion("carp", "Why do USGS and NWPS stage differ at Krotz Springs?")?.question.id).toBe("carp-quality-krotz-datum");
    expect(matchSupportedQuestion("carp", "Tell me a joke about rivers")).toBeNull();
    expect(matchSupportedQuestion("python", "Where should python crews go tonight?")?.question.id).toBe("py-legacy-python-crews-tonight");
  });

  test("a question line names the tools, the mode, the wording and the citations", () => {
    const line = questionLine(supportedQuestions("carp").find((q) => q.id === "carp-lookup-review-today")!);
    expect(line).toBe('- "Which locations need operational review today?": call site_status, then set_view; wording: \'needs operational review\', \'because\'; cite feed usgs, feed nwps, feed nws.');
    const refusal = questionLine(supportedQuestions("carp").find((q) => q.id === "carp-boundary-abundance")!);
    expect(refusal).toContain("call no tool; refuse with the boundary");
    const caveat = questionLine(supportedQuestions("carp").find((q) => q.id === "carp-boundary-safety")!);
    expect(caveat).toContain("end with the sentence 'This is conditions only: it cannot judge safety or access.'");
    const selected = questionLine(supportedQuestions("carp").find((q) => q.id === "carp-explain-start-review")!);
    expect(selected).toContain('(the selected site, MCGL1, is "this location")');
  });
});
