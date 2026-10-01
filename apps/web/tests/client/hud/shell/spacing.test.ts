import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CARD_MAX_WIDTH_CSS, GUTTER_PX, SIDE_ROOM_PX, STAGE_DIAMETER_CSS } from "client/hud/shell/geometry";
import { TOPBAR_WIDTH_CSS } from "client/hud/topbar/TopBar";
import { GAP_M_PX, SHARED_TOKENS } from "client/themes/palette";

/**
 * GE9 (gates/leaf-GE9.md G1): the stage chrome has one spacing unit, `--gap-m` (12 px). Outer margins, gaps and
 * offsets in these files come from the token (CSS) or from `GUTTER_PX` (maths), never from a hand-written 8, 10, 14,
 * 16, 18 or 20 px, and no outer position uses the smaller `--gap-s`/`--gap-xs` steps.
 */
const CLIENT = path.resolve(import.meta.dir, "../../../../client");

/** The stage chrome: shell, bars, cards, timelines, the chat card, and the carp and lionfish panels. */
const FILES = [
  "hud/shell/geometry.ts",
  "hud/shell/StageShell.tsx",
  "hud/shell/BottomBar.tsx",
  "hud/shell/use-hud-bottom.ts",
  "hud/topbar/TopBar.tsx",
  "hud/index.tsx",
  "hud/Panel.tsx",
  "hud/timeline/Timeline.tsx",
  "hud/drawer/EvidenceDrawer.tsx",
  "agent/column.styled.ts",
  "carp/CarpTimeline.tsx",
  "lionfish/LionfishHud.tsx",
];

/** GE8's zoom controls, when merged: every file under client/hud/zoom. */
function zoomFiles(): string[] {
  const dir = path.join(CLIENT, "hud/zoom");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => `hud/zoom/${f}`);
}

/** Properties that set an element's outer spacing: its position, the gap between its children, its margins. */
const OUTER = /^\s*(top|right|bottom|left|inset|gap|row-gap|column-gap|margin(?:-[a-z]+)?)\s*:\s*([^;]*);/;
const STRAY_PX = /(?<![\d.])(8|10|14|16|18|20)px\b/;
const POSITION = /^\s*(top|right|bottom|left|inset)\s*:/;
const SMALL_STEP = /var\(--gap-(s|xs)\)/;

/** Source with comments blanked (line numbers kept). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function strays(file: string): string[] {
  const lines = stripComments(readFileSync(path.join(CLIENT, file), "utf8")).split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = OUTER.exec(line);
    if (!m) return;
    if (STRAY_PX.test(m[2]!)) out.push(`${file}:${i + 1} ${line.trim()}`);
    if (POSITION.test(line) && SMALL_STEP.test(m[2]!)) out.push(`${file}:${i + 1} ${line.trim()} (outer position on a small step)`);
  });
  return out;
}

describe("stage spacing", () => {
  test("stage spacing: GUTTER_PX is the --gap-m token, 12 px", () => {
    expect(GUTTER_PX).toBe(12);
    expect(GUTTER_PX).toBe(GAP_M_PX);
    expect(SHARED_TOKENS["--gap-m"]).toBe(`${GAP_M_PX}px`);
  });

  test("stage spacing: the layout maths derive from the gutter", () => {
    expect(SIDE_ROOM_PX).toBe(360 + 2 * GUTTER_PX);
    expect(STAGE_DIAMETER_CSS).toContain(`100vw - ${2 * GUTTER_PX}px`);
    expect(CARD_MAX_WIDTH_CSS).toContain(`${GUTTER_PX + 48}px`);
    // The top row keeps the cluster's width: four 36 px buttons, three gutters between them.
    expect(TOPBAR_WIDTH_CSS).toBe("calc(144px + 3 * var(--gap-m))");
  });

  test("stage spacing: no hand-written 8, 10, 14, 16, 18 or 20 px outer margin or gap on the stage chrome", () => {
    const files = [...FILES, ...zoomFiles()];
    for (const f of files) expect(existsSync(path.join(CLIENT, f))).toBe(true);
    expect(files.flatMap(strays)).toEqual([]);
  });

  test("stage spacing: every chrome file takes its spacing from the token", () => {
    for (const f of [...FILES, ...zoomFiles()]) {
      const source = readFileSync(path.join(CLIENT, f), "utf8");
      expect(`${f}: ${/var\(--gap-m\)|GUTTER_PX|GAP_M_PX/.test(source)}`).toBe(`${f}: true`);
    }
  });

  test("stage spacing: the scan catches what it is meant to catch", () => {
    const probe = ["  gap: 6px;", "  margin-top: 16px;", "  bottom: calc(var(--hud-bottom) + 8px);", "  top: var(--gap-s);", "  padding: 8px;", "  /* gap: 10px; */"].join("\n");
    const caught = stripComments(probe)
      .split("\n")
      .filter((line) => {
        const m = OUTER.exec(line);
        return !!m && (STRAY_PX.test(m[2]!) || (POSITION.test(line) && SMALL_STEP.test(m[2]!)));
      });
    expect(caught.map((l) => l.trim())).toEqual(["margin-top: 16px;", "bottom: calc(var(--hud-bottom) + 8px);", "top: var(--gap-s);"]);
  });
});
