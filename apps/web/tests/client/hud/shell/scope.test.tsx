import { describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { get, set } from "@calvinjs/active-state";

import { decodeShareLink, encodeShareLink } from "client/hud/share-link";
import { applyShareState, readShareState } from "client/hud/share-link-store";
import { GUTTER_PX, stageDiameter } from "client/hud/shell/geometry";
import { fadeOf, opaqueWindow, ROUNDED_CORNER_SHARE, scopeClipCss, scopeMaskCss, scopeMaskSvg, scopeWindow, WIDE_ASPECT } from "client/hud/shell/scope";
import { LookChoices } from "client/hud/look/LookBar";
import {
  DEFAULT_SCOPE_FEATHER,
  DEFAULT_SCOPE_SHAPE,
  DEFAULT_SCOPE_SIZE,
  isScopeShape,
  MAX_SCOPE_SIZE,
  MIN_SCOPE_SIZE,
  SCOPE_FEATHER,
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
  set(SCOPE_SHAPE, SCOPE_SHAPE.defaults);
  set(SCOPE_SIZE, SCOPE_SIZE.defaults);
  set(SCOPE_FEATHER, SCOPE_FEATHER.defaults);
};

describe("scope shape", () => {
  test("scope shape: keys, defaults and validators", () => {
    expect(SCOPE_SHAPES).toEqual(["circle", "oval", "rounded", "frame"]);
    expect(SCOPE_SHAPE.defaults).toBe("circle");
    expect(DEFAULT_SCOPE_SHAPE).toBe("circle");
    expect(SCOPE_SIZE.defaults).toBe(65);
    expect(DEFAULT_SCOPE_SIZE).toBe(65);
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
    for (const bad of [Number.NaN, "big", "", null, undefined, {}]) expect(sizeOf(bad)).toBe(65);
  });

  test("scope shape: each shape's box at size 100 (1440×900)", () => {
    const circle = scopeWindow(VW, VH, { shape: "circle", size: 100 });
    expect([circle.width, circle.height, circle.corner]).toEqual([D, D, D / 2]);
    const oval = scopeWindow(VW, VH, { shape: "oval", size: 100 });
    expect([oval.width, oval.height]).toEqual([D * WIDE_ASPECT, D]);
    const rounded = scopeWindow(VW, VH, { shape: "rounded", size: 100 });
    expect([rounded.width, rounded.height]).toEqual([D * WIDE_ASPECT, D]);
    expect(rounded.corner).toBeCloseTo(D * ROUNDED_CORNER_SHARE, 6);
    const frame = scopeWindow(VW, VH, { shape: "frame", size: 100 });
    expect([frame.width, frame.height, frame.corner]).toEqual([VW - 2 * GUTTER_PX, VH - 2 * GUTTER_PX, 0]);
    // The wide shapes never pass the page's gutters.
    const narrow = scopeWindow(800, 900, { shape: "oval", size: 100 });
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

  test("scope shape: the share link carries shape, size and feather and restores them", () => {
    reset();
    expect(encodeShareLink({ app: "python", shape: "circle", size: DEFAULT_SCOPE_SIZE, feather: DEFAULT_SCOPE_FEATHER })).toBe("v=2&app=python");
    const hash = encodeShareLink({ app: "python", shape: "rounded", size: 70, feather: 60 });
    expect(hash).toContain("shape=rounded");
    expect(hash).toContain("size=70");
    expect(hash).toContain("feather=60");
    const back = decodeShareLink(hash);
    expect([back.shape, back.size, back.feather]).toEqual(["rounded", 70, 60]);
    for (const bad of ["shape=square", "size=10", "size=101", "size=abc", "size=-50"]) {
      const d = decodeShareLink(`v=2&app=python&${bad}`);
      expect([d.shape, d.size]).toEqual([undefined, undefined]);
    }
    applyShareState(back);
    expect([get(SCOPE_SHAPE), get(SCOPE_SIZE), get(SCOPE_FEATHER)]).toEqual(["rounded", 70, 60]);
    const read = readShareState();
    expect([read.shape, read.size, read.feather]).toEqual(["rounded", 70, 60]);
    reset();
  });
});

describe("scope feather", () => {
  test("scope feather: the soft edge never moves or dims the window: box, centre and corner stay, only the fade grows", () => {
    for (const shape of SCOPE_SHAPES) {
      const hard = scopeWindow(VW, VH, { shape, feather: 0 });
      const soft = scopeWindow(VW, VH, { shape, feather: 60 });
      expect([soft.width, soft.height, soft.cx, soft.cy, soft.corner]).toEqual([hard.width, hard.height, hard.cx, hard.cy, hard.corner]);
      expect(hard.feather).toBe(0);
      expect(hard.floor).toBe(0);
      expect(soft.feather).toBeCloseTo(0.6 * (Math.min(soft.width, soft.height) / 2), 9);
      // The window is fully visible whatever the soft edge: the framings' opaque part is the box itself.
      expect(opaqueWindow(soft)).toEqual(opaqueWindow(hard));
    }
    const d = scopeWindow(VW, VH, { size: 100 });
    expect(d.shape).toBe("circle");
    expect(d.feather).toBeCloseTo((DEFAULT_SCOPE_FEATHER / 100) * (D / 2), 9);
  });

  test("scope feather: default is a visible fade (30..50); the fade distance and the floor never shrink as the soft edge grows; 100 is no vignette", () => {
    expect(DEFAULT_SCOPE_FEATHER).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_SCOPE_FEATHER).toBeLessThanOrEqual(50);
    let prev = fadeOf(0);
    expect(prev).toEqual({ share: 0, floor: 0 });
    for (let f = 1; f <= 100; f += 1) {
      const now = fadeOf(f);
      expect(now.share).toBeGreaterThanOrEqual(prev.share);
      expect(now.floor).toBeGreaterThanOrEqual(prev.floor);
      prev = now;
    }
    expect(fadeOf(100)).toEqual({ share: 1, floor: 1 });
    expect(fadeOf(250)).toEqual({ share: 1, floor: 1 });
    expect(fadeOf(-5)).toEqual({ share: 0, floor: 0 });
    const def = fadeOf(DEFAULT_SCOPE_FEATHER);
    expect(def.floor).toBeGreaterThan(0);
    expect(def.floor).toBeLessThan(0.5);
  });

  test("scope feather: the mask is a floor, the shape grown by half the fade and blurred, then the sharp shape on top (every shape)", () => {
    for (const shape of SCOPE_SHAPES) {
      const win = scopeWindow(VW, VH, { shape, feather: 50 });
      const svg = scopeMaskSvg(win, VW, VH);
      // Floor over the page, with its opacity.
      expect(svg).toMatch(new RegExp(`<rect width="${VW}" height="${VH}" fill-opacity="${win.floor}"/>`));
      // The blurred copy: the box grown by half the fade, blur spending the whole fade.
      const grown = win.width / 2 + win.feather / 2;
      expect(svg).toContain('filter="url(#f)"');
      expect(svg).toContain(`stdDeviation="${Math.round((win.feather / 4.66) * 10) / 10}"`);
      if (shape === "circle" || shape === "oval") expect(svg).toContain(`rx="${Math.round(grown * 10) / 10}"`);
      // The sharp shape is the LAST element and carries no filter: the inside is exactly opaque.
      const last = svg.slice(svg.lastIndexOf("<", svg.length - 7));
      expect(last).not.toContain("filter");
      expect(last.startsWith(shape === "circle" || shape === "oval" ? "<ellipse" : "<rect")).toBe(true);
      // ...and it is the window's own box, not grown.
      const r1 = (n: number) => Math.round(n * 10) / 10;
      expect(last).toContain(shape === "circle" || shape === "oval" ? `rx="${r1(win.width / 2)}"` : `width="${r1(win.width)}"`);
    }
  });

  test("scope feather: feather 0 is a hard edge (only the sharp shape, nothing outside) and 100 is no vignette (one opaque page)", () => {
    const hard = scopeMaskSvg(scopeWindow(VW, VH, { shape: "circle", feather: 0, size: 100 }), VW, VH);
    expect(hard).toContain(`<ellipse cx="720" cy="450" rx="${D / 2}" ry="${D / 2}"/>`);
    expect(hard).not.toContain("<filter");
    expect(hard).not.toContain("fill-opacity");
    expect(hard.match(/<(ellipse|rect)/g)).toHaveLength(1);
    const rounded = scopeMaskSvg(scopeWindow(VW, VH, { shape: "rounded", feather: 0, size: 70 }), VW, VH);
    expect(rounded).toMatch(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" rx="[1-9][\d.]*"\/>/);
    const frame = scopeMaskSvg(scopeWindow(VW, VH, { shape: "frame", feather: 0, size: 100 }), VW, VH);
    expect(frame).toContain(`<rect x="${GUTTER_PX}" y="${GUTTER_PX}" width="${VW - 2 * GUTTER_PX}" height="${VH - 2 * GUTTER_PX}" rx="0"/>`);
    const none = scopeMaskSvg(scopeWindow(VW, VH, { shape: "circle", feather: 100 }), VW, VH);
    expect(none.match(/<(ellipse|rect)/g)).toHaveLength(1);
    expect(none).toContain(`<rect width="${VW}" height="${VH}"/>`);
    expect(none).not.toContain("<filter");
    expect(scopeMaskCss(scopeWindow(VW, VH), VW, VH).startsWith('url("data:image/svg+xml,%3Csvg')).toBe(true);
  });

  test("scope feather: the pointer is clipped to the window only with a hard edge; with a soft edge the visible map outside takes clicks", () => {
    expect(scopeClipCss(scopeWindow(VW, VH, { shape: "circle", feather: 0, size: 100 }))).toBe(`ellipse(${D / 2}px ${D / 2}px at 720px 450px)`);
    expect(scopeClipCss(scopeWindow(VW, VH, { shape: "oval", size: 50, feather: 0 }))).toBe(`ellipse(${(D * WIDE_ASPECT) / 4}px ${D / 4}px at 720px 450px)`);
    expect(scopeClipCss(scopeWindow(VW, VH, { shape: "frame", feather: 0, size: 100 }))).toBe(`inset(${GUTTER_PX}px ${GUTTER_PX}px ${GUTTER_PX}px ${GUTTER_PX}px round 0px)`);
    for (const shape of SCOPE_SHAPES) {
      expect(scopeClipCss(scopeWindow(VW, VH, { shape, feather: 1 }))).toBe("none");
      expect(scopeClipCss(scopeWindow(VW, VH, { shape }))).toBe("none");
    }
  });

  test("scope feather: the Look popover has no window switch: seven looks, Shape, Size and Soft edge in plain words", () => {
    const markup = html(<LookChoices look="normal" shape="oval" size={70} feather={40} onLook={noop} onShape={noop} onSize={noop} onFeather={noop} />);
    expect([...markup.matchAll(/data-look="/g)]).toHaveLength(7);
    expect(markup).not.toContain('role="switch"');
    expect(markup).not.toContain("scope-switch");
    expect(markup).not.toContain("through a window");
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('role="radiogroup" aria-label="Window shape"');
    const radios = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>([^<]*)</g)];
    expect(radios.map((r) => r[1])).toEqual(["Circle", "Oval", "Rounded", "Frame"]);
    expect(radios.filter((r) => r[0].includes('aria-checked="true"')).map((r) => r[1])).toEqual(["Oval"]);
    expect(markup).toMatch(/<input[^>]*type="range"[^>]*min="30"[^>]*max="100"[^>]*aria-label="Window size"[^>]*data-testid="scope-size"/);
    expect(markup).toMatch(/<input[^>]*aria-label="Window soft edge"[^>]*aria-valuetext="40, fades out past the window"[^>]*data-testid="scope-feather"/);
    expect(markup).toContain(">Size<");
    expect(markup).toContain(">Soft edge<");
    expect(markup).toContain("sharp at 0, no vignette at 100");
    // The soft edge reads as words at both ends.
    expect(html(<LookChoices look="normal" shape="circle" size={100} feather={0} onLook={noop} onShape={noop} onSize={noop} onFeather={noop} />)).toContain('aria-valuetext="0, sharp edge"');
    expect(html(<LookChoices look="normal" shape="circle" size={100} feather={100} onLook={noop} onShape={noop} onSize={noop} onFeather={noop} />)).toContain('aria-valuetext="100, no vignette"');
  });
});
