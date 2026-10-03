import { describe, expect, test } from "bun:test";

import { INTENTS } from "@/server/agent/decisions";
import { agentSystemPrompt } from "@/server/agent/prompt";
import { speciesInfo } from "@/server/agent/tools/species-info";
import { getApp } from "@/shared/apps";
import { questionGroups } from "@/shared/apps/question-catalog";

const ctx = (id: "carp" | "lionfish" | "python") => ({ app: getApp(id), now: new Date("2026-10-03T12:00:00Z"), emit: () => {} }) as never;
const data = (out: unknown) => (out as { output: { data: Record<string, unknown> } }).output?.data ?? (out as { data: Record<string, unknown> }).data;

describe("species_info", () => {
  test("every app's agent has it, and it returns facts, sources and a note that this is general reference", async () => {
    for (const id of ["carp", "lionfish", "python"] as const) {
      expect(getApp(id).agent.tools).toContain("species_info");
      const out = (await speciesInfo.execute({}, ctx(id))) as unknown as { data: Record<string, unknown> };
      const d = data(out);
      expect(String(d.kind)).toMatch(/general reference/);
      expect((d.species as unknown[]).length).toBeGreaterThan(0);
      expect((d.sources as { url: string }[]).every((s) => s.url.startsWith("https://"))).toBe(true);
      expect(String(d.note)).toMatch(/general information/);
    }
  });

  test("a topic and a species narrow it", async () => {
    const out = await speciesInfo.execute({ topic: "diet", species: "black" }, ctx("carp"));
    const species = data(out).species as { name: string; facts: { topic: string; text: string }[] }[];
    expect(species.map((s) => s.name)).toEqual(["Black carp"]);
    expect(species[0]!.facts[0]!.text).toMatch(/snails and mussels/);
  });

  test("the prompt puts general species questions in scope and sends them to the tool", () => {
    for (const id of ["carp", "lionfish", "python"] as const) {
      const prompt = agentSystemPrompt(getApp(id));
      expect(prompt).toMatch(/General questions about this app's species are in scope/);
      expect(prompt).toContain("species_info");
    }
  });

  test("the router knows the intent, and the Questions tab lists the general questions for each app", () => {
    expect(INTENTS).toContain("species_info");
    for (const id of ["carp", "lionfish", "python"] as const) {
      const about = questionGroups(getApp(id)).find((g) => g.id === "about");
      expect(about?.questions.length).toBeGreaterThanOrEqual(8);
      expect(about?.questions.some((q) => /look like/i.test(q))).toBe(true);
      expect(about?.questions.some((q) => /hunt/i.test(q))).toBe(true);
      expect(about?.questions.some((q) => /rules/i.test(q))).toBe(true);
    }
  });
});
