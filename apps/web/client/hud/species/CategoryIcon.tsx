import { CATEGORY_COLORS, type CategoryId } from "shared/species-categories";
import { CATEGORY_ICONS, ICON_STROKE, ICON_VIEWBOX } from "shared/species-icons";

/**
 * A category's icon (T44) as inline SVG: strokes in `color` (the category's label colour by default) over a dark
 * outline, the same drawing the globe's markers use. `size` is the box in px.
 */
export default function CategoryIcon({ category, color, size = 16, outline = true, title }: { category: CategoryId; color?: string; size?: number; outline?: boolean; title?: string }) {
  const shape = CATEGORY_ICONS[category];
  const tint = color ?? CATEGORY_COLORS[category];
  const strokes = (stroke: string, width: number, key: string) => (
    <g key={key} stroke={stroke} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round">
      {shape.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {(shape.circles ?? []).map(([cx, cy, r], i) => (
        <circle key={`c${i}`} cx={cx} cy={cy} r={r} />
      ))}
      {(shape.dots ?? []).map(([cx, cy], i) => (
        <circle key={`d${i}`} cx={cx} cy={cy} r={0.9 + (width - ICON_STROKE) / 2} fill={stroke} stroke="none" />
      ))}
    </g>
  );
  return (
    <svg viewBox={`-2 -2 ${ICON_VIEWBOX + 4} ${ICON_VIEWBOX + 4}`} width={size} height={size} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} data-category-icon={category} style={{ flex: "none" }}>
      {title ? <title>{title}</title> : null}
      {outline ? strokes("#0b0d12", ICON_STROKE + 3, "outline") : null}
      {strokes(tint, ICON_STROKE, "tint")}
    </svg>
  );
}
