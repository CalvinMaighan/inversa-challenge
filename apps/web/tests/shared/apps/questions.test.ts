import { describe, expect, test } from "bun:test";

import { matchSupportedQuestion, questionTerms, supportedQuestions } from "@/shared/apps/questions";

describe("supported questions", () => {
  test("carp has the 69 documented questions; python's set lives in the eval golden file", () => {
    expect(supportedQuestions("carp")).toHaveLength(69);
    expect(supportedQuestions("python")).toEqual([]);
  });

  test("a question matches its documented form exactly, a paraphrase closely, an unrelated one not at all", () => {
    expect([...questionTerms("Which locations need operational review today?")].sort()).toEqual(["location", "need", "operational", "review"]);
    expect(matchSupportedQuestion("carp", "Which locations need operational review today?")).toMatchObject({ score: 1, question: { id: "carp-lookup-review-today" } });
    expect(matchSupportedQuestion("carp", "which locations need review today")?.question.id).toBe("carp-lookup-review-today");
    expect(matchSupportedQuestion("carp", "Why do USGS and NWPS stage differ at Krotz Springs?")?.question.id).toBe("carp-quality-krotz-datum");
    expect(matchSupportedQuestion("carp", "Tell me a joke about rivers")).toBeNull();
    expect(matchSupportedQuestion("python", "Where should python crews go tonight?")).toBeNull();
  });
});
