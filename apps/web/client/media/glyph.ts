/**
 * The small "this has a photo" icon the hover popovers of sightings show, drawn once: a picture frame with a sun and a hill,
 * in a 16 px box, stroked in the text colour. `ImageGlyph` is the React form; `imageGlyphSvg` is the same drawing as markup for
 * the popovers that are built by hand (the carp dots' canvas layer).
 */
export const IMAGE_GLYPH_PATHS = ["M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z", "M1.8 11.2 5.4 7.6l2.6 2.6 2-2 4 4", "M10.6 6.3a.9.9 0 1 0 0-.01"] as const;

export function imageGlyphSvg(size = 12): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-glyph="image">${IMAGE_GLYPH_PATHS.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
}
