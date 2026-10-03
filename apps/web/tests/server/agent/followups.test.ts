import { beforeEach, describe, expect, test } from "bun:test";

import { candidateQuestions, suggestFollowUps } from "@/server/agent/followups";
import { decidesStop } from "@/server/voice/stop-intent";
import { resetGlideBreaker } from "@/server/fastino/glide";
import { APP_IDS, getApp } from "@/shared/apps";

const CARP = getApp(APP_IDS[0]);
beforeEach(() => resetGlideBreaker());

const reply = (answers: unknown) => (async () => new Response(JSON.stringify({ answers }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("follow-up suggestions", () => {
  test("candidates are the app's own topic questions, without the map and voice ones", () => {
    const all = candidateQuestions(CARP);
    expect(all.length).toBeGreaterThan(8);
    expect(all.some((q) => /Zoom into|Open the layers/.test(q))).toBe(false);
  });

  test("the three best-scoring options come back as their question text, never the one just asked", async () => {
    const pool = candidateQuestions(CARP);
    let sent: { schema: { classifications: { labels: string[] }[] } } | null = null;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      const labels = sent!.schema.classifications[0]!.labels;
      const scores = labels.map((label, i) => ({ label, confidence: [0.01, 0.5, 0.3, 0.12, 0.05][i] ?? 0.02 }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pick: scores }) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await suggestFollowUps({ app: CARP, question: pool[0]!, answer: "Five reports.", classify: { apiKey: "k", fetchImpl } });
    // The asked question is not an option, so the labels start at pool[1]: scores 0.5, 0.3, 0.12 are pool[2], pool[3], pool[4].
    expect(sent!.schema.classifications[0]!.labels).not.toContain(pool[0]);
    expect(out).toEqual([pool[2], pool[3], pool[4]]);
  });

  test("options the model barely scores are not offered", async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const labels = (JSON.parse(init.body as string) as { schema: { classifications: { labels: string[] }[] } }).schema.classifications[0]!.labels;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pick: labels.map((label) => ({ label, confidence: 0.04 })) }) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await suggestFollowUps({ app: CARP, question: "q", answer: "a", classify: { apiKey: "k", fetchImpl } })).toEqual([]);
  });

  test("nothing without a key", async () => {
    const saved = process.env.FASTINO_API_KEY;
    delete process.env.FASTINO_API_KEY;
    expect(await suggestFollowUps({ app: CARP, question: "q", answer: "a" })).toEqual([]);
    if (saved !== undefined) process.env.FASTINO_API_KEY = saved;
  });
});

describe("decidesStop", () => {
  test("a confident yes stops, a clear no does not, in between and long utterances are left to the regexes", async () => {
    expect(await decidesStop("okay that's enough thanks", { apiKey: "k", fetchImpl: reply({ stop: { type: "noul", noul: 0.97, confidence: 0.94 } }) })).toBe(true);
    expect(await decidesStop("how many carp", { apiKey: "k", fetchImpl: reply({ stop: { type: "noul", noul: 0.02, confidence: 0.96 } }) })).toBe(false);
    expect(await decidesStop("hmm", { apiKey: "k", fetchImpl: reply({ stop: { type: "noul", noul: 0.7, confidence: 0.4 } }) })).toBeNull();
    expect(await decidesStop("one two three four five six seven eight nine ten", { apiKey: "k", fetchImpl: reply({ stop: { type: "noul", noul: 1, confidence: 1 } }) })).toBeNull();
  });
});
