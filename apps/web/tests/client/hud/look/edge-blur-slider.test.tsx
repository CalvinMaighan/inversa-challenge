import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LookChoices } from "client/hud/look/LookBar";
import { blurOf, DEFAULT_SCOPE_BLUR, MAX_SCOPE_BLUR } from "client/state/look";

const noop = () => {};
const base = { look: "normal", shape: "circle", size: 65, feather: 35, onLook: noop, onShape: noop, onSize: noop, onFeather: noop } as const;

describe("edge blur control", () => {
  test("the Look popover shows an Edge blur slider when it can change it", () => {
    const html = renderToStaticMarkup(<LookChoices {...base} blur={20} onBlur={noop} />);
    expect(html).toContain('data-testid="scope-blur"');
    expect(html).toContain('max="40"');
    expect(html).toContain('aria-valuetext="20 pixels at the rim"');
    expect(renderToStaticMarkup(<LookChoices {...base} blur={0} onBlur={noop} />)).toContain('aria-valuetext="0, no blur"');
  });

  test("without a handler there is no slider", () => {
    expect(renderToStaticMarkup(<LookChoices {...base} />)).not.toContain("scope-blur");
  });

  test("blurOf keeps a whole number 0..40 and falls back to the default", () => {
    expect(DEFAULT_SCOPE_BLUR).toBe(14);
    expect(blurOf(20)).toBe(20);
    expect(blurOf("8")).toBe(8);
    expect(blurOf(99)).toBe(MAX_SCOPE_BLUR);
    expect(blurOf(-3)).toBe(0);
    expect(blurOf("x")).toBe(DEFAULT_SCOPE_BLUR);
    expect(blurOf(undefined)).toBe(DEFAULT_SCOPE_BLUR);
  });
});
