import { describe, expect, test } from "bun:test";

import { matchSupportedQuestion, questionTerms, supportedQuestions } from "@/shared/apps/questions";

describe("supported questions", () => {
  test("every app has its documented questions: carp 69, lionfish 65, python 68", () => {
    expect(supportedQuestions("carp")).toHaveLength(69);
    expect(supportedQuestions("lionfish")).toHaveLength(65);
    expect(supportedQuestions("python")).toHaveLength(68);
  });

  test("a question matches its documented form exactly, a paraphrase closely, an unrelated one not at all", () => {
    expect([...questionTerms("Which locations need operational review today?")].sort()).toEqual(["location", "need", "operational", "review"]);
    expect(matchSupportedQuestion("carp", "Which locations need operational review today?")).toMatchObject({ score: 1, question: { id: "carp-lookup-review-today" } });
    expect(matchSupportedQuestion("carp", "which locations need review today")?.question.id).toBe("carp-lookup-review-today");
    expect(matchSupportedQuestion("carp", "Why do USGS and NWPS stage differ at Krotz Springs?")?.question.id).toBe("carp-quality-krotz-datum");
    expect(matchSupportedQuestion("carp", "Tell me a joke about rivers")).toBeNull();
    expect(matchSupportedQuestion("python", "Where should python crews go tonight?")?.question.id).toBe("py-legacy-python-crews-tonight");
  });
});
