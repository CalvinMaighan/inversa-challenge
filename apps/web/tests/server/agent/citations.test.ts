import { describe, expect, test } from "bun:test";

import { CitationFilter, citedIds, filterCitations } from "@/server/agent/cordis/citations";
import { createThinkingPartition, partitionThinking } from "@/server/agent/cordis/thinking";

const known = new Set(["sighting:1", "reading:11:water_c:1768417200000:measured", "alert:5002"]);

function stream(chunks: string[]) {
  const verified: string[] = [];
  const unverified: string[] = [];
  const filter = new CitationFilter({
    isVerified: (id) => known.has(id),
    onVerified: (id) => verified.push(id),
    onUnverified: (id) => unverified.push(id),
  });
  const out = chunks.map((chunk) => filter.push(chunk));
  out.push(filter.flush());
  return { out, text: out.join(""), verified, unverified };
}

describe("citation filter", () => {
  test("a marker split across chunks is held until it closes", () => {
    const { out, text, verified } = stream(["python [e:sigh", "ting:1] seen", "."]);
    expect(out[0]).toBe("python ");
    expect(out[1]).toBe("[e:sighting:1] seen");
    expect(text).toBe("python [e:sighting:1] seen.");
    expect(verified).toEqual(["sighting:1"]);
  });

  test("a lone [ at a chunk edge is held for one chunk only", () => {
    const { out, text } = stream(["depth [", "2 m]"]);
    expect(out[0]).toBe("depth ");
    expect(text).toBe("depth [2 m]");
  });

  test("unknown ids are removed with the space before them", () => {
    const { text, unverified } = stream(["Den here [e:sighting:99]. Water ", "[e:reading:11:water_c:1768417200000:measured] ok"]);
    expect(text).toBe("Den here. Water [e:reading:11:water_c:1768417200000:measured] ok");
    expect(unverified).toEqual(["sighting:99"]);
  });

  test("grouped ids are split, checked one by one and re-rendered", () => {
    const { text, verified, unverified } = stream(["Both [e:sighting:1, e:alert:5002; e:alert:1]."]);
    expect(text).toBe("Both [e:sighting:1][e:alert:5002].");
    expect(verified).toEqual(["sighting:1", "alert:5002"]);
    expect(unverified).toEqual(["alert:1"]);
  });

  test("an unterminated marker at a newline is plain text, not a citation", () => {
    const { text, verified, unverified } = stream(["see [e:sighting:1\nnext line"]);
    expect(text).toBe("see [e:sighting:1\nnext line");
    expect(verified).toEqual([]);
    expect(unverified).toEqual([]);
  });

  test("an unclosed marker at end of stream flushes as text", () => {
    expect(stream(["trailing [e:sighting"]).text).toBe("trailing [e:sighting");
  });

  test("one-shot filter and id extraction", () => {
    const result = filterCitations("a [e:sighting:1] b [e:x:1] c", (id) => known.has(id));
    expect(result).toEqual({ text: "a [e:sighting:1] b c", verified: ["sighting:1"], unverified: ["x:1"] });
    expect(citedIds("a [e:sighting:1] [e:alert:5002, e:alert:1]")).toEqual(["sighting:1", "alert:5002", "alert:1"]);
  });
});

describe("think-tag partition", () => {
  test("splits reasoning from content across chunks", () => {
    const state = createThinkingPartition();
    const a = partitionThinking(state, "<thi");
    const b = partitionThinking(state, "nk>plan</think>Answer");
    expect(a).toEqual({ reasoningDelta: "", contentDelta: "" });
    expect(b).toEqual({ reasoningDelta: "plan", contentDelta: "Answer" });
  });

  test("a comparison sign is not held back", () => {
    const state = createThinkingPartition();
    expect(partitionThinking(state, "wave < 1.2 m").contentDelta).toBe("wave < 1.2 m");
  });
});
