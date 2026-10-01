import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { agentSystemPrompt, viewContext } from "@/server/agent/prompt";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { APP_IDS, getApp } from "@/shared/apps";
import type { QuestionFile } from "@/shared/apps/questions";

/**
 * gates/leaf-AGB.md G2: the benchmark measures the agent, not the agent being handed the answers. Nothing the
 * model can see (system prompt, turn context, tool names, descriptions and input schemas) may carry a golden
 * or held-out question's id, its text (whole, or any run of five words), or one of its `mustSay` statements (the
 * whole statement, normalised). The question files are read from disk so a new file is covered without a code change.
 */

const QUESTIONS_DIR = join(import.meta.dir, "../../../../../spec/apps/questions");

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'°\s]/g, " ").replace(/\s+/g, " ").trim();

type Needle = { what: string; from: string; text: string };

/** Everything that would hand the model an answer: ids, question text and five-word runs of it, mustSay statements. */
function needles(): Needle[] {
  const out: Needle[] = [];
  for (const name of readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith(".json"))) {
    const file = JSON.parse(readFileSync(join(QUESTIONS_DIR, name), "utf8")) as QuestionFile;
    for (const q of file.questions) {
      out.push({ what: "id", from: q.id, text: q.id.toLowerCase() });
      const words = norm(q.question).split(" ");
      out.push({ what: "question", from: q.id, text: words.join(" ") });
      for (let i = 0; i + 5 <= words.length; i++) out.push({ what: "five words of the question", from: q.id, text: words.slice(i, i + 5).join(" ") });
      for (const statement of q.pass.mustSay ?? []) out.push({ what: "mustSay statement", from: q.id, text: norm(statement) });
    }
  }
  return out;
}

/** The text the model sees for an app, as the runtime builds it. */
function visible(appId: (typeof APP_IDS)[number]): { label: string; text: string }[] {
  const app = getApp(appId);
  const now = new Date("2026-10-01T07:00:00Z");
  const view = { bbox: { west: -94, south: 28.9, east: -88.8, north: 32.9 }, time: now.toISOString(), layers: ["stations"], selection: null, site: "MCGL1", asOf: now.getTime(), replay: true };
  const out = [
    { label: `${appId} system prompt`, text: agentSystemPrompt(app) },
    { label: `${appId} view context`, text: `${viewContext(undefined, now, app)}\n${viewContext(view, now, app)}` },
  ];
  for (const cap of buildAgentRegistry(app).list()) {
    const schema = JSON.stringify(z.toJSONSchema(cap.inputSchema, { io: "input", unrepresentable: "any" }));
    out.push({ label: `${appId} tool ${cap.name}`, text: `${cap.name}\n${cap.description}\n${schema}` });
  }
  return out;
}

describe("no answer key", () => {
  test("no answer key: no prompt, context, tool description or input schema carries a golden or held-out question id, question text or mustSay statement", () => {
    const all = needles();
    expect(all.length).toBeGreaterThan(500);
    const hits: string[] = [];
    for (const appId of APP_IDS) {
      for (const piece of visible(appId)) {
        const text = norm(piece.text);
        const raw = piece.text.toLowerCase();
        for (const needle of all) {
          const found = needle.what === "id" ? raw.includes(needle.text) : ` ${text} `.includes(` ${needle.text} `);
          if (found) hits.push(`${piece.label}: ${needle.what} "${needle.text}" (${needle.from})`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
