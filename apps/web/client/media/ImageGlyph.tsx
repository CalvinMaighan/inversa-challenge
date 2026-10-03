import { IMAGE_GLYPH_PATHS } from "./glyph";

/** The "this sighting has a photo" icon (see glyph.ts), inline with text, in the surrounding colour. */
export default function ImageGlyph({ size = 12, title = "Has a photo" }: { size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={title} data-glyph="image" style={{ display: "inline-block", verticalAlign: "-2px", marginLeft: 6, flex: "none" }}>
      <title>{title}</title>
      {IMAGE_GLYPH_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
