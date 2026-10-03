import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { tooltipLine, tooltipText } from "client/hud/tooltip/model";
import { imageGlyphSvg } from "client/media/glyph";
import ImageGlyph from "client/media/ImageGlyph";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const facts = { kind: "sighting" as const, taxon: 1, quality: 2, conflict: false, ageMs: 2 * 3_600_000, lon: -80, lat: 25, id: 4 };

describe("sighting popovers show whether there is a photo", () => {
  test("the tooltip text carries the image flag only when the record has a same-origin photo", () => {
    expect(tooltipText(facts as never, NOW, { mediaUrl: "/v1/python/media/abc" }).image).toBe(true);
    expect("image" in tooltipText(facts as never, NOW, { mediaUrl: null })).toBe(false);
    expect("image" in tooltipText(facts as never, NOW, { mediaUrl: "https://elsewhere/x.jpg" })).toBe(false);
    expect("image" in tooltipText(facts as never, NOW)).toBe(false);
  });

  test("the screen-reader line says so", () => {
    expect(tooltipLine(tooltipText(facts as never, NOW, { mediaUrl: "/v1/python/media/abc" }))).toMatch(/ · has a photo$/);
    expect(tooltipLine(tooltipText(facts as never, NOW))).not.toContain("photo");
  });

  test("one icon drawing, as React and as markup", () => {
    const react = renderToStaticMarkup(<ImageGlyph />);
    expect(react).toContain('data-glyph="image"');
    expect(react).toContain('aria-label="Has a photo"');
    const markup = imageGlyphSvg(14);
    expect(markup).toContain('width="14"');
    expect(markup).toContain('data-glyph="image"');
    expect(markup.match(/<path /g)).toHaveLength(3);
  });
});
