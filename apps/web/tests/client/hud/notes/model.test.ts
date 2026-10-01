import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { anchorOf } from "client/globe/hover";
import { pinIcon } from "client/globe/layers/notes";
import { createFieldNoteOps, toFieldNote, type FieldNote } from "client/hud/missions/board";
import { canEditNote, NOTE_RATE_LIMIT, noteEvidenceId, parseNoteId, pinsOf, placeName, preview, RateLimiter } from "client/hud/notes/model";
import { tooltipLine, tooltipText } from "client/hud/tooltip/model";
import { colorOfNode } from "client/state/me";
import { Clock } from "client/threads/crdt/hlc";
import { applyOps, createState, viewBoard } from "client/threads/crdt/merge";

import { installDom } from "../../globe/fakes";

let restore: () => void;
beforeAll(() => {
  restore = installDom();
});
afterAll(() => restore());

const note = (over: Partial<FieldNote> = {}): FieldNote => ({
  id: "n1",
  text: "Two pythons by the canal",
  lat: 25.4687,
  lon: -80.4776,
  species: "python",
  sightingId: null,
  createdBy: "a1b2c3d4-e5f6-7000-8000-00000000a0a0",
  callsign: "Ranger-A1B2",
  createdAt: "2026-09-30T12:00:00Z",
  ...over,
});

describe("field note helpers", () => {
  test("evidence ids round-trip and never match other kinds", () => {
    expect(noteEvidenceId("abc")).toBe("note:abc");
    expect(parseNoteId("note:abc")).toBe("abc");
    expect(parseNoteId("sighting:abc")).toBeNull();
    expect(parseNoteId("note:")).toBeNull();
  });

  test("only the author edits or deletes (client-side rule, documented limitation)", () => {
    expect(canEditNote(note(), "a1b2c3d4-e5f6-7000-8000-00000000a0a0")).toBe(true);
    expect(canEditNote(note(), "someone-else")).toBe(false);
    expect(canEditNote(note({ createdBy: "" }), "")).toBe(false);
  });

  test("preview cuts at 80 characters on a word boundary with an ellipsis, and flattens whitespace", () => {
    expect(preview("short  note\nhere")).toBe("short note here");
    const long = "word ".repeat(40).trim();
    const p = preview(long);
    expect(p.length).toBeLessThanOrEqual(81);
    expect(p.endsWith("…")).toBe(true);
    expect(p).not.toMatch(/wor…$/);
    expect(preview("x".repeat(100), 10)).toBe("xxxxxxxxxx…");
  });

  test("rate cap: 20 notes a minute per node, sliding window", () => {
    const r = new RateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < NOTE_RATE_LIMIT; i++) expect(r.allow(t0 + i * 100)).toBe(true);
    expect(r.allow(t0 + 5_000)).toBe(false);
    expect(r.retryInMs(t0 + 5_000)).toBe(55_000);
    expect(r.allow(t0 + 59_999)).toBe(false);
    expect(r.allow(t0 + 60_000)).toBe(true);
    expect(r.retryInMs(t0 + 60_000)).toBeGreaterThan(0);
    const small = new RateLimiter(2, 1_000);
    expect([small.allow(0), small.allow(1), small.allow(2), small.allow(1_000)]).toEqual([true, true, false, true]);
  });

  test("place names: the spot itself inside 2 km, else distance and compass point to the nearest town or unit", () => {
    expect(placeName(-80.4776, 25.4687)).toBe("Homestead");
    expect(placeName(-80.4776, 25.5137)).toBe("5 km N of Homestead");
    expect(placeName(-80.43, 25.4687)).toBe("5 km E of Homestead");
    expect(placeName(-80.9237, 25.1417)).toBe("Flamingo");
    // Regional entries (the whole park, Florida Bay, the Keys) never name a spot; the nearest town or unit does.
    expect(placeName(-80.75, 25.05)).toBe("19 km NW of Islamorada");
    expect(placeName(-80.85, 25.3)).toMatch(/^\d+ km [NSEW]{1,2} of (Flamingo|Royal Palm|Long Pine Key)$/);
  });

  test("pins carry the author's colour, derived from the node id", () => {
    const [p] = pinsOf([note()]);
    expect(p!.color).toBe(colorOfNode("a1b2c3d4-e5f6-7000-8000-00000000a0a0"));
    expect(p).toMatchObject({ id: "n1", text: "Two pythons by the canal", callsign: "Ranger-A1B2" });
  });

  test("the pin icon is a canvas per colour, drawn tip-down at a fixed size", () => {
    const icon = pinIcon("#4fb3ff");
    expect(icon.width).toBe(22);
    expect(icon.height).toBe(30);
  });

  test("tooltip: callsign, then the first 80 characters of the text, anchored to the pin", () => {
    const facts = { kind: "note" as const, id: "n1", callsign: "Ranger-A1B2", text: "Two pythons by the canal", lon: -80.4776, lat: 25.4687 };
    expect(tooltipLine(tooltipText(facts, Date.now()))).toBe("Ranger-A1B2 · Two pythons by the canal");
    expect(anchorOf(facts)).toEqual({ lon: -80.4776, lat: 25.4687 });
    const long = tooltipText({ ...facts, text: "y".repeat(200) }, 0);
    expect(long.parts[0]!.length).toBe(81);
    expect(tooltipText({ ...facts, callsign: "" }, 0).title).toBe("Note");
  });
});

/** Minimal React views over a note's text, rendered the way the panel, card and tooltip render it: as text nodes. */
function TextNode({ text }: { text: string }) {
  return createElement("p", { "data-testid": "note-body" }, text);
}

describe("note xss", () => {
  const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>[link](javascript:alert(1)) **bold**`;

  test("note xss: text with <img onerror> and markdown renders as escaped plain text, never as elements", () => {
    const html = renderToStaticMarkup(createElement(TextNode, { text: payload }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<strong");
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("**bold**");
  });

  test("note xss: the text survives the CRDT untouched, and the view keeps it a string (no parsing anywhere)", () => {
    const f = { clock: new Clock("a"), boardId: "everglades", nodeId: "a", now: () => 1_700_000_000_000 };
    const { ops } = createFieldNoteOps(f, { text: payload, lat: 25.4, lon: -80.5, createdBy: "a", callsign: "A", createdAt: "2026-09-30T12:00:00Z" });
    const view = viewBoard(applyOps(createState("everglades"), ops));
    const n = toFieldNote(view.notes[0]!)!;
    expect(n.text).toBe(payload);
    expect(typeof n.text).toBe("string");
    expect(tooltipText({ kind: "note", id: n.id, callsign: "A", text: n.text, lon: n.lon, lat: n.lat }, 0).parts[0]).toBe(payload.slice(0, 80) + "…");
  });

  test("note xss: no note view uses innerHTML or dangerouslySetInnerHTML", () => {
    const dir = join(import.meta.dir, "../../../../client/hud/notes");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const f of sources) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML/);
    }
  });
});
