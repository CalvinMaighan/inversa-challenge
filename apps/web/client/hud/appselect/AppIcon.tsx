import { SPECIES_IMAGE_URLS } from "client/species-images";
import { appIconShape, ICON_STROKE, ICON_VIEWBOX } from "shared/app-icons";

/**
 * An app's icon (config `icon`, `shared/app-icons.ts`) as inline SVG: strokes in `color` over a dark outline, the
 * same drawing the globe's markers use. `size` is the box in px.
 */
export default function AppIcon({ icon, color, size = 16, outline = true, title, emoji = true }: { icon: string; color: string; size?: number; outline?: boolean; title?: string; emoji?: boolean }) {
  // `emoji={false}`: the plain outline icon in `color` (the sighting card keeps its own).
  const image = emoji ? SPECIES_IMAGE_URLS[icon] : undefined;
  // Each app shows its species picture (a plain image, no tint or outline).
  // eslint-disable-next-line @next/next/no-img-element -- a small same-origin picture, no optimiser needed
  if (image) return <img src={image} width={size} height={size} alt={title ?? ""} aria-hidden={title ? undefined : true} data-app-icon={icon} style={{ flex: "none", objectFit: "contain" }} />;
  const shape = appIconShape(icon);
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
    <svg viewBox={`-2 -2 ${ICON_VIEWBOX + 4} ${ICON_VIEWBOX + 4}`} width={size} height={size} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} data-app-icon={icon} style={{ flex: "none" }}>
      {title ? <title>{title}</title> : null}
      {outline ? strokes("#0b0d12", ICON_STROKE + 3, "outline") : null}
      {strokes(color, ICON_STROKE, "tint")}
    </svg>
  );
}
