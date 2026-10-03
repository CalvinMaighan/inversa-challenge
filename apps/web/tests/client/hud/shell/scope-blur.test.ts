import { describe, expect, test } from "bun:test";

import { scopeBlurMaskCss, scopeBlurMaskSvg, scopeWindow } from "client/hud/shell/scope";

describe("progressive edge blur mask", () => {
  test("is the inverse of the visibility mask: white page, then the floor, the blurred grown shape and the sharp shape in black, drawn through a mask", () => {
    const svg = scopeBlurMaskSvg(scopeWindow(1600, 900, { feather: 40 }), 1600, 900);
    expect(svg).toContain("<mask");
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain("feGaussianBlur");
    expect(svg).toMatch(/<ellipse[^>]*fill="#000"\/>/);
    expect(svg.endsWith('mask="url(#m)"/></svg>')).toBe(true);
  });

  test("the sharp shape is the window's own size, so the safe zone gets no blur whatever the feather", () => {
    for (const feather of [0, 35, 80]) {
      const win = scopeWindow(1600, 900, { shape: "circle", size: 100, feather });
      const svg = scopeBlurMaskSvg(win, 1600, 900);
      const sharp = svg.match(/<ellipse cx="[\d.]+" cy="[\d.]+" rx="([\d.]+)" ry="([\d.]+)" fill="#000"\/>/);
      expect(Number(sharp![1])).toBeCloseTo(win.width / 2, 0);
    }
  });

  test("a hard edge has no blurred ramp, and feather 100 (no vignette) has no blur at all", () => {
    expect(scopeBlurMaskSvg(scopeWindow(1600, 900, { feather: 0 }), 1600, 900)).not.toContain("feGaussianBlur");
    const off = scopeBlurMaskSvg(scopeWindow(1600, 900, { feather: 100 }), 1600, 900);
    expect(off).not.toContain("<mask");
    expect(off).not.toContain("<rect");
  });

  test("as a CSS mask-image value", () => {
    expect(scopeBlurMaskCss(scopeWindow(1600, 900), 1600, 900)).toMatch(/^url\("data:image\/svg\+xml,/);
  });
});
