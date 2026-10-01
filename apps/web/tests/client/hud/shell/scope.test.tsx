import { describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { get, set } from "@calvinjs/active-state";

import { decodeShareLink, encodeShareLink } from "client/hud/share-link";
import { applyShareState, readShareState } from "client/hud/share-link-store";
import { GUTTER_PX, stageDiameter } from "client/hud/shell/geometry";
import { opaqueWindow, ROUNDED_CORNER_SHARE, scopeClipCss, scopeMaskCss, scopeMaskSvg, scopeWindow, WIDE_ASPECT } from "client/hud/shell/scope";
import { LookChoices } from "client/hud/look/LookBar";
import {
  DEFAULT_SCOPE_SHAPE,
  DEFAULT_SCOPE_SIZE,
  isScopeShape,
  MAX_SCOPE_SIZE,
  MIN_SCOPE_SIZE,
  SCOPE_FEATHER,
  SCOPE_ON,
  SCOPE_SHAPE,
  SCOPE_SHAPES,
  SCOPE_SIZE,
  shapeOf,
  sizeOf,
  type ScopeShape,
} from "client/state/look";
import { emotionTheme } from "client/themes/theme";

selectPython();

const VW = 1440;
const VH = 900;
const D = stageDiameter(VW, VH);
const area = (w: { width: number; height: number; shape: ScopeShape; corner: number }) =>
  w.shape === "circle" || w.shape === "oval" ? (Math.PI / 4) * w.width * w.height : w.width * w.height - (4 - Math.PI) * w.corner * w.corner;
const noop = () => {};
const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);
const reset = () => {
  set(SCOPE_ON, SCOPE_ON.defaults);
  set(SCOPE_SHAPE, SCOPE_SHAPE.defaults);
  set(SCOPE_SIZE, SCOPE_SIZE.defaults);
  set(SCOPE_FEATHER, SCOPE_FEATHER.defaults);
};

describe("scope shape", () => {
  test("scope shape: keys, defaults and validators", () => {
    expect(SCOPE_SHAPES).toEqual(["circle", "oval", "rounded", "frame"]);
    expect(SCOPE_SHAPE.defaults).toBe("circle");
    expect(DEFAULT_SCOPE_SHAPE).toBe("circle");
    expect(SCOPE_SIZE.defaults).toBe(100);
    expect(DEFAULT_SCOPE_SIZE).toBe(100);
    expect([MIN_SCOPE_SIZE, MAX_SCOPE_SIZE]).toEqual([30, 100]);
    for (const s of SCOPE_SHAPES) expect(shapeOf(s)).toBe(s);
    for (const bad of ["square", "", null, undefined, 3, "CIRCLE"]) {
      expect(isScopeShape(bad)).toBe(false);
      expect(shapeOf(bad)).toBe("circle");
    }
    expect(sizeOf(55)).toBe(55);
    expect(sizeOf("70")).toBe(70);
    expect(sizeOf(10)).toBe(30);
    expect(sizeOf(250)).toBe(100);
    expect(sizeOf(64.6)).toBe(65);
    for (const bad of [Number.NaN, "big", "", null, undefined, {}]) expect(sizeOf(bad)).toBe(100);
  });

  test("scope shape: each shape's box at size 100 (1440×900)", () => {
    const circle = scopeWindow(VW, VH, { shape: "circle" });
    expect([circle.width, circle.height, circle.corner]).toEqual([D, D, D / 2]);
    const oval = scopeWindow(VW, VH, { shape: "oval" });
    expect([oval.width, oval.height]).toEqual([D * WIDE_ASPECT, D]);
    const rounded = scopeWindow(VW, VH, { shape: "rounded" });
    expect([rounded.width, rounded.height]).toEqual([D * WIDE_ASPECT, D]);
    expect(rounded.corner).toBeCloseTo(D * ROUNDED_CORNER_SHARE, 6);
    const frame = scopeWindow(VW, VH, { shape: "frame" });
    expect([frame.width, frame.height, frame.corner]).toEqual([VW - 2 * GUTTER_PX, VH - 2 * GUTTER_PX, 0]);
    // The wide shapes never pass the page's gutters.
    const narrow = scopeWindow(800, 900, { shape: "oval" });
    expect(narrow.width).toBe(800 - 2 * GUTTER_PX);
    // Four distinct visible areas.
    const areas = [circle, oval, rounded, frame].map(area);
    expect(new Set(areas.map((a) => Math.round(a))).size).toBe(4);
    expect(areas[0]! < areas[1]! && areas[1]! < areas[2]! && areas[2]! < areas[3]!).toBe(true);
  });

  test("scope shape: size scales the box about the stage centre, area with its square", () => {
    for (const shape of SCOPE_SHAPES) {
      const full = scopeWindow(VW, VH, { shape, size: 100 });
      const half = scopeWindow(VW, VH, { shape, size: 50 });
      expect(half.width).toBeCloseTo(full.width / 2, 9);
      expect(half.height).toBeCloseTo(full.height / 2, 9);
      expect([half.cx, half.cy]).toEqual([VW / 2, VH / 2]);
      expect(area(half) / area(full)).toBeCloseTo(0.25, 9);
    }
    expect(scopeWindow(VW, VH, { size: 5 }).width).toBeCloseTo(D * 0.3, 9);
  });

  test("scope shape: feather softens the edge only, as a share of half the shorter side", () => {
    for (const shape of SCOPE_SHAPES) {
      const hard = scopeWindow(VW, VH, { shape, feather: 0 });
      const soft = scopeWindow(VW, VH, { shape, feather: 60 });
      expect([soft.width, soft.height, soft.cx, soft.cy, soft.corner]).toEqual([hard.width, hard.height, hard.cx, hard.cy, hard.corner]);
      expect(hard.feather).toBe(0);
      expect(soft.feather).toBeCloseTo(0.6 * (Math.min(soft.width, soft.height) / 2), 9);
    }
    // Defaults: circle, size 100, feather 11.
    const d = scopeWindow(VW, VH);
    expect(d.shape).toBe("circle");
    expect(d.feather).toBeCloseTo(0.11 * (D / 2), 9);
  });

  test("scope shape: the opaque part (framings) is the box less the feather", () => {
    const circle = opaqueWindow(scopeWindow(VW, VH, { shape: "circle", feather: 20 }));
    expect(circle).toEqual({ kind: "ellipse", cx: 720, cy: 450, rx: D / 2 - 0.2 * (D / 2), ry: D / 2 - 0.2 * (D / 2) });
    const oval = opaqueWindow(scopeWindow(VW, VH, { shape: "oval", feather: 0 }));
    expect(oval).toEqual({ kind: "ellipse", cx: 720, cy: 450, rx: (D * WIDE_ASPECT) / 2, ry: D / 2 });
    const frame = opaqueWindow(scopeWindow(VW, VH, { shape: "frame", feather: 10 }));
    const f = 0.1 * ((VH - 2 * GUTTER_PX) / 2);
    expect(frame.kind).toBe("rect");
    if (frame.kind === "rect") {
      expect(frame.width).toBeCloseTo(VW - 2 * GUTTER_PX - 2 * f, 9);
      expect(frame.height).toBeCloseTo(VH - 2 * GUTTER_PX - 2 * f, 9);
    }
  });

  test("scope shape: the CSS mask is the shape inset by half the feather and blurred over the rest", () => {
    const circle = scopeMaskSvg(scopeWindow(VW, VH, { shape: "circle", feather: 0 }), VW, VH);
    expect(circle).toContain(`<ellipse cx="720" cy="450" rx="${D / 2}" ry="${D / 2}"/>`);
    expect(circle).not.toContain("<filter");
    expect(circle).toContain(`width="${VW}" height="${VH}"`);
    const oval = scopeMaskSvg(scopeWindow(VW, VH, { shape: "oval", feather: 50 }), VW, VH);
    const f = 0.5 * (D / 2);
    expect(oval).toContain(`rx="${(D * WIDE_ASPECT) / 2 - f / 2}" ry="${D / 2 - f / 2}"`);
    expect(oval).toContain(`stdDeviation="${Math.round((f / 4.66) * 10) / 10}"`);
    const rounded = scopeMaskSvg(scopeWindow(VW, VH, { shape: "rounded", feather: 0, size: 70 }), VW, VH);
    expect(rounded).toMatch(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" rx="[1-9][\d.]*"\/>/);
    const frame = scopeMaskSvg(scopeWindow(VW, VH, { shape: "frame", feather: 0 }), VW, VH);
    expect(frame).toContain(`<rect x="${GUTTER_PX}" y="${GUTTER_PX}" width="${VW - 2 * GUTTER_PX}" height="${VH - 2 * GUTTER_PX}" rx="0"/>`);
    expect(scopeMaskCss(scopeWindow(VW, VH), VW, VH).startsWith('url("data:image/svg+xml,%3Csvg')).toBe(true);
  });

  test("scope shape: the pointer clip follows the box", () => {
    expect(scopeClipCss(scopeWindow(VW, VH, { shape: "circle" }))).toBe(`ellipse(${D / 2}px ${D / 2}px at 720px 450px)`);
    expect(scopeClipCss(scopeWindow(VW, VH, { shape: "oval", size: 50 }))).toBe(`ellipse(${(D * WIDE_ASPECT) / 4}px ${D / 4}px at 720px 450px)`);
    expect(scopeClipCss(scopeWindow(VW, VH, { shape: "frame" }))).toBe(`inset(${GUTTER_PX}px ${GUTTER_PX}px ${GUTTER_PX}px ${GUTTER_PX}px round 0px)`);
  });

  test("scope shape: the share link carries shape, size and feather and restores them", () => {
    reset();
    expect(encodeShareLink({ app: "python", shape: "circle", size: 100, feather: 11 })).toBe("v=2&app=python");
    const hash = encodeShareLink({ app: "python", shape: "rounded", size: 70, feather: 40 });
    expect(hash).toContain("shape=rounded");
    expect(hash).toContain("size=70");
    expect(hash).toContain("feather=40");
    const back = decodeShareLink(hash);
    expect([back.shape, back.size, back.feather]).toEqual(["rounded", 70, 40]);
    for (const bad of ["shape=square", "size=10", "size=101", "size=abc", "size=-50"]) {
      const d = decodeShareLink(`v=2&app=python&${bad}`);
      expect([d.shape, d.size]).toEqual([undefined, undefined]);
    }
    applyShareState(back);
    expect([get(SCOPE_SHAPE), get(SCOPE_SIZE), get(SCOPE_FEATHER)]).toEqual(["rounded", 70, 40]);
    const read = readShareState();
    expect([read.shape, read.size, read.feather]).toEqual(["rounded", 70, 40]);
    reset();
  });

  test("scope shape: the Look popover shows Shape, Size and Soft edge in plain words, the switch and seven looks", () => {
    const markup = html(<LookChoices look="normal" scopeOn shape="oval" size={70} feather={11} onLook={noop} onScope={noop} onShape={noop} onSize={noop} onFeather={noop} />);
    expect([...markup.matchAll(/data-look="/g)]).toHaveLength(7);
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('role="radiogroup" aria-label="Window shape"');
    const radios = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>([^<]*)</g)];
    expect(radios.map((r) => r[1])).toEqual(["Circle", "Oval", "Rounded", "Frame"]);
    expect(radios.filter((r) => r[0].includes('aria-checked="true"')).map((r) => r[1])).toEqual(["Oval"]);
    expect(markup).toMatch(/<input[^>]*type="range"[^>]*min="30"[^>]*max="100"[^>]*aria-label="Window size"[^>]*data-testid="scope-size"/);
    expect(markup).toMatch(/<input[^>]*aria-label="Window edge softness"[^>]*data-testid="scope-feather"/);
    expect(markup).toContain(">Size<");
    expect(markup).toContain(">Soft edge<");
    // The window off: its three controls are disabled, the switch is not.
    const off = html(<LookChoices look="normal" scopeOn={false} shape="circle" size={100} feather={11} onLook={noop} onScope={noop} onShape={noop} onSize={noop} onFeather={noop} />);
    expect([...off.matchAll(/<(button|input)[^>]*disabled=""/g)]).toHaveLength(6);
  });
});
