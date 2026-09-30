import { afterEach, describe, expect, test } from "bun:test";
import { init, reset, get } from "../src/core";
import {
  moveIdToArray,
  parseCommand,
  runCommand,
} from "../src/dom/command";
import { parsePath, readPath, writePath } from "../src/dom/path";
import { resolvePath } from "../src/dom/scope";

afterEach(() => {
  reset();
});

describe("path", () => {
  test("parsePath", () => {
    expect(parsePath("LAYOUT.nav")).toEqual({ key: "LAYOUT", fields: ["nav"] });
    expect(parsePath("USER")).toEqual({ key: "USER", fields: [] });
  });

  test("read/writePath", () => {
    const value = { nav: false, theme: "dark" };
    expect(readPath(value, ["nav"])).toBe(false);
    expect(writePath(value, ["nav"], true)).toEqual({ nav: true, theme: "dark" });
    expect(value.nav).toBe(false);
  });
});

describe("scope", () => {
  test("resolves each aliases from the inside out", () => {
    const scope = [
      { name: "col", key: "BOARD", fields: ["columns", "0"] },
      { name: "card", key: "BOARD", fields: ["columns", "0", "cards", "1"] },
    ];
    expect(resolvePath("card.title", scope)).toEqual({
      key: "BOARD",
      fields: ["columns", "0", "cards", "1", "title"],
    });
    expect(resolvePath("BOARD.columns", scope)).toEqual({
      key: "BOARD",
      fields: ["columns"],
    });
  });
});

describe("commands", () => {
  test("parseCommand", () => {
    expect(parseCommand("toggle:LAYOUT.nav")).toEqual({
      verb: "toggle",
      path: "LAYOUT.nav",
    });
    expect(parseCommand("set:THEME.mode:dark")).toEqual({
      verb: "set",
      path: "THEME.mode",
      payload: "dark",
    });
    expect(parseCommand('set:META.n:{"a":1}')).toEqual({
      verb: "set",
      path: "META.n",
      payload: { a: 1 },
    });
    expect(parseCommand("move→col.cards")).toEqual({
      verb: "move",
      path: "col.cards",
    });
    expect(parseCommand("push:col.cards")).toEqual({
      verb: "push",
      path: "col.cards",
      payload: undefined,
    });
  });

  test("runCommand toggle/set", () => {
    init({ LAYOUT: { nav: false }, THEME: { mode: "light" } });
    runCommand(parseCommand("toggle:LAYOUT.nav"), []);
    expect(get("LAYOUT")).toEqual({ nav: true });
    runCommand(parseCommand("set:THEME.mode:dark"), []);
    expect(get("THEME")).toEqual({ mode: "dark" });
  });

  test("moveIdToArray", () => {
    const untouched = {
      id: "doing",
      cards: [{ id: "c9", title: "Stay" }],
    };
    const board = {
      columns: [
        { id: "todo", cards: [{ id: "c1", title: "A" }, { id: "c2", title: "B" }] },
        untouched,
        { id: "done", cards: [] as { id: string; title: string }[] },
      ],
    };
    const next = moveIdToArray(board, "c1", ["columns", "2", "cards"]) as typeof board;
    expect(next.columns[0]!.cards).toEqual([{ id: "c2", title: "B" }]);
    expect(next.columns[2]!.cards).toEqual([{ id: "c1", title: "A" }]);
    // Structural sharing: untouched column + remaining card keep identity.
    expect(next.columns[1]).toBe(untouched);
    expect(next.columns[0]!.cards[0]).toBe(board.columns[0]!.cards[1]);
  });

  test("runCommand move with scope", () => {
    init({
      BOARD: {
        columns: [
          { id: "todo", cards: [{ id: "c1", title: "A" }] },
          { id: "done", cards: [] },
        ],
      },
    });
    const scope = [
      { name: "col", key: "BOARD", fields: ["columns", "1"] },
    ];
    runCommand(parseCommand("move→col.cards"), scope, { dragId: "c1" });
    expect(get<{ columns: { cards: { id: string; title: string }[] }[] }>("BOARD")!
      .columns[1]!.cards).toEqual([{ id: "c1", title: "A" }]);
  });
});

describe("ssr snapshot", () => {
  test("stores snapshot when ssr: true", async () => {
    const { getServerSnapshot, getSsr } = await import("../src/core");
    init({ LAYOUT: { nav: false } }, { ssr: true });
    expect(getSsr()).toBe(true);
    expect(getServerSnapshot("LAYOUT")).toEqual({ nav: false });
  });
});
