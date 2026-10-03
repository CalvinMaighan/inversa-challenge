import { describe, expect, test } from "bun:test";

import { APP_IDS, getApp } from "@/shared/apps";
import { questionGroups, quickActions } from "@/shared/apps/question-catalog";

describe("question catalog", () => {
  test("every app lists topics with questions, each question once", () => {
    for (const id of APP_IDS) {
      const groups = questionGroups(getApp(id));
      expect(groups.length).toBeGreaterThanOrEqual(5);
      const all = groups.flatMap((g) => g.questions);
      expect(new Set(all).size).toBe(all.length);
      for (const g of groups) {
        expect(g.label.length).toBeGreaterThan(2);
        expect(g.questions.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test("the empty chat offers one question per topic, never the map or voice ones", () => {
    for (const id of APP_IDS) {
      const quick = quickActions(getApp(id));
      expect(quick.length).toBe(4);
      expect(quick.every((q) => q.group.id !== "map" && q.group.id !== "voice")).toBe(true);
      expect(quick.every((q) => q.group.questions[0] === q.question)).toBe(true);
    }
  });

  test("questions stay on the app's species and places", () => {
    const text = (id: (typeof APP_IDS)[number]) => questionGroups(getApp(id)).flatMap((g) => g.questions).join(" ").toLowerCase();
    expect(text(APP_IDS[0])).toContain("carp");
    expect(text(APP_IDS[0])).not.toMatch(/python|lionfish/);
    expect(text(APP_IDS[1])).toContain("lionfish");
    expect(text(APP_IDS[2])).toContain("python");
  });
});
