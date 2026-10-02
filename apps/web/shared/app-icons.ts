/**
 * One stroke icon per app (config `icon`, spec/apps/*.json), as SVG path data in a 24 × 24 box, drawn with round
 * caps and a 2 px stroke. The same data feeds the React `<AppIcon>` (app selector, species chip, legend, card)
 * and the globe's marker canvas (`client/globe/marker-icons.ts`), so a python is the same snake everywhere.
 *
 * Sources (docs/icons.md):
 * - Lucide v0.544.0 (ISC): fish (carp, lionfish).
 * - Drawn for this project (MIT, with the repo): snake (python).
 */

export type IconShape = {
  /** `d` attributes, stroked. */
  paths: readonly string[];
  /** `[cx, cy, r]` circles, stroked. */
  circles?: readonly (readonly [number, number, number])[];
  /** `[cx, cy]` filled dots of radius 0.9 (eyes). */
  dots?: readonly (readonly [number, number])[];
  source: "lucide" | "custom";
};

export const ICON_VIEWBOX = 24;
export const ICON_STROKE = 2;

// Lucide "fish".
const FISH: IconShape = {
  paths: [
    "M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z",
    "M18 12v.5",
    "M16 17.93a9.77 9.77 0 0 1 0-11.86",
    "M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33",
    "M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4",
    "m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98",
  ],
  source: "lucide",
};

export const APP_ICONS = {
  carp: FISH,
  lionfish: FISH,
  // Custom: an S-shaped body ending in a head with a forked tongue.
  python: {
    paths: ["M4 19c0-3 2.5-4.5 5.5-4.5h5c2.5 0 4-1 4-3s-1.5-3-4-3h-6C6 8.5 5 7 5 5.5S6.5 3 9 3h7.5a2.5 2.5 0 0 1 0 5H15", "M17 6h3l1.5-1M20 6l1.5 1"],
    dots: [[17, 5]],
    source: "custom",
  },
} as const satisfies Record<string, IconShape>;

export type AppIconId = keyof typeof APP_ICONS;

export function isAppIconId(value: unknown): value is AppIconId {
  return typeof value === "string" && Object.hasOwn(APP_ICONS, value);
}

/** The shape of an app's `icon`; an unknown id draws the fish. */
export function appIconShape(icon: string): IconShape {
  return isAppIconId(icon) ? APP_ICONS[icon] : FISH;
}
