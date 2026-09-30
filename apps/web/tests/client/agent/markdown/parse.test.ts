import { describe, expect, test } from "bun:test";

import { parseInlines, parseStreamMarkdown, type StreamMdBlock, type StreamMdInline } from "client/agent/markdown/parse";

const verified = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

/** Cite ids in document order, through nested inlines and blocks. */
function cites(nodes: StreamMdInline[]): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === "cite") return [node.id];
    if ("children" in node) return cites(node.children);
    return [];
  });
}

function blockCites(blocks: StreamMdBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.kind === "p" || block.kind === "h" || block.kind === "quote") return cites(block.children);
    if (block.kind === "ul" || block.kind === "ol") return block.items.flatMap((item) => cites(item.inlines));
    if (block.kind === "table") return [...block.headers, ...block.rows.flat()].flatMap(cites);
    return [];
  });
}

function text(nodes: StreamMdInline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text" || node.kind === "code") return node.text;
      if (node.kind === "cite") return `{${node.id}}`;
      return text(node.children);
    })
    .join("");
}

describe("citation chips", () => {
  test("verified [e:<id>] markers become cite nodes with the full C14 id", () => {
    const nodes = parseInlines(
      "Stage 1.12 m [e:reading:NP205:stage_m:1768446000000:usgs] and cell [e:hotspot:python:243:145:1768446000000].",
      verified("reading:NP205:stage_m:1768446000000:usgs", "hotspot:python:243:145:1768446000000"),
    );
    expect(cites(nodes)).toEqual(["reading:NP205:stage_m:1768446000000:usgs", "hotspot:python:243:145:1768446000000"]);
    expect(text(nodes)).toBe("Stage 1.12 m {reading:NP205:stage_m:1768446000000:usgs} and cell {hotspot:python:243:145:1768446000000}.");
  });

  test("unverified ids are not chips and leave no marker text behind", () => {
    const nodes = parseInlines("One on Big Pine [e:sighting:9999]. Confirmed [e:sighting:2001]; and [e:alert:x], too.", verified("sighting:2001"));
    expect(cites(nodes)).toEqual(["sighting:2001"]);
    expect(text(nodes)).toBe("One on Big Pine. Confirmed {sighting:2001}; and, too.");
    expect(text(nodes)).not.toContain("[e:");
  });

  test("nothing verified yet: no chips at all", () => {
    expect(cites(parseInlines("research [e:sighting:2001] and [e:sighting:2002]", verified()))).toEqual([]);
  });

  test("a marker still streaming in is hidden until it closes", () => {
    const partial = parseInlines("research (inat) [e:sighting:20", verified("sighting:2001"));
    expect(text(partial)).toBe("research (inat) ");
    expect(cites(partial)).toEqual([]);
    const closed = parseInlines("research (inat) [e:sighting:2001]", verified("sighting:2001"));
    expect(cites(closed)).toEqual(["sighting:2001"]);
  });

  test("chips work inside emphasis, lists and tables", () => {
    const blocks = parseStreamMarkdown(
      [
        "**Top cell** [e:hotspot:python:243:145:1]",
        "",
        "- stage [e:reading:a:b:1:usgs]",
        "- air *[e:reading:c:d:1:openmeteo]*",
        "",
        "| feed | state |",
        "| --- | --- |",
        "| ndbc | stale [e:fetch:88] |",
      ].join("\n"),
      verified("hotspot:python:243:145:1", "reading:a:b:1:usgs", "reading:c:d:1:openmeteo", "fetch:88"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["p", "ul", "table"]);
    expect(blockCites(blocks)).toEqual(["hotspot:python:243:145:1", "reading:a:b:1:usgs", "reading:c:d:1:openmeteo", "fetch:88"]);
  });

  test("an ordinary markdown link is still a link, not a citation", () => {
    const nodes = parseInlines("see [NWS](https://www.weather.gov) [e:alert:1]", verified("alert:1"));
    expect(nodes[1]).toEqual({ kind: "a", href: "https://www.weather.gov", children: [{ kind: "text", text: "NWS" }] });
    expect(cites(nodes)).toEqual(["alert:1"]);
  });
});

describe("stream markdown", () => {
  test("snake_case ids are words, not emphasis", () => {
    expect(parseInlines("needs_id and feed_state", verified())).toEqual([{ kind: "text", text: "needs_id and feed_state" }]);
  });

  test("an unclosed ** mid-stream renders as text, not raw markers", () => {
    expect(text(parseInlines("the **top cel", verified()))).toBe("the top cel");
  });

  test("unsafe link targets fall back to their label", () => {
    expect(parseInlines("[click](javascript:alert(1))", verified())).toEqual([{ kind: "text", text: "click" }]);
  });

  test("blocks: heading, fenced code, quote, rule", () => {
    const blocks = parseStreamMarkdown("## Why\n```\nscore = 0.82\n```\n> heuristic\n\n---\ntail", verified());
    expect(blocks.map((b) => b.kind)).toEqual(["h", "pre", "quote", "hr", "p"]);
    expect(blocks[1]).toEqual({ kind: "pre", lang: "", text: "score = 0.82" });
  });
});
