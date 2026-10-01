/**
 * One stroke icon per species category (T44), as SVG path data in a 24 × 24 box, drawn with round caps and a
 * 2 px stroke. The same data feeds the React `<CategoryIcon>` (chips, popover, card, legend) and the globe's
 * marker atlas (canvas, `client/globe/species-icons.ts`), so a lizard is the same lizard everywhere.
 *
 * Sources (docs/icons.md):
 * - Lucide v0.544.0 (ISC): bird, bug, fish, turtle, snail, leaf, paw-print, circle-dot.
 * - Drawn for this project (MIT, with the repo): snake, lizard, crocodile, frog, spider.
 */
import type { CategoryId } from "./species-categories";

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

export const CATEGORY_ICONS: Record<CategoryId, IconShape> = {
  // Lucide "bird".
  birds: {
    paths: ["M16 7h.01", "M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20", "m20 7 2 .5-2 .5", "M10 18v3", "M14 17.75V21", "M7 18a6 6 0 0 0 3.84-10.61"],
    source: "lucide",
  },
  // Lucide "bug".
  insects: {
    paths: [
      "M12 20v-9",
      "M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z",
      "M14.12 3.88 16 2",
      "M21 21a4 4 0 0 0-3.81-4",
      "M21 5a4 4 0 0 1-3.55 3.97",
      "M22 13h-4",
      "M3 21a4 4 0 0 1 3.81-4",
      "M3 5a4 4 0 0 0 3.55 3.97",
      "M6 13H2",
      "m8 2 1.88 1.88",
      "M9 7.13V6a3 3 0 1 1 6 0v1.13",
    ],
    source: "lucide",
  },
  // Lucide "fish".
  fish: {
    paths: [
      "M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z",
      "M18 12v.5",
      "M16 17.93a9.77 9.77 0 0 1 0-11.86",
      "M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33",
      "M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4",
      "m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98",
    ],
    source: "lucide",
  },
  // Lucide "turtle".
  turtles: {
    paths: ["m12 10 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a8 8 0 1 0-16 0v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3l2-4h4Z", "M4.82 7.9 8 10", "M15.18 7.9 12 10", "M16.93 10H20a2 2 0 0 1 0 4H2"],
    source: "lucide",
  },
  // Lucide "snail".
  snails: {
    paths: ["M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0", "M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6", "M18 3 19.1 5.2", "M22 3 20.9 5.2"],
    circles: [[10, 13, 8]],
    source: "lucide",
  },
  // Lucide "leaf".
  plants: {
    paths: ["M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z", "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"],
    source: "lucide",
  },
  // Lucide "paw-print".
  mammals: {
    paths: ["M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"],
    circles: [
      [11, 4, 2],
      [18, 8, 2],
      [20, 16, 2],
    ],
    source: "lucide",
  },
  // Lucide "circle-dot".
  other: {
    paths: [],
    circles: [
      [12, 12, 10],
      [12, 12, 1],
    ],
    source: "lucide",
  },
  // Custom: an S-shaped body ending in a head with a forked tongue.
  snakes: {
    paths: ["M4 19c0-3 2.5-4.5 5.5-4.5h5c2.5 0 4-1 4-3s-1.5-3-4-3h-6C6 8.5 5 7 5 5.5S6.5 3 9 3h7.5a2.5 2.5 0 0 1 0 5H15", "M17 6h3l1.5-1M20 6l1.5 1"],
    dots: [[17, 5]],
    source: "custom",
  },
  // Custom: a lizard seen from above, four splayed legs and a long tail.
  lizards: {
    paths: ["M7 12c0-2.5 2-4.5 5-4.5s5 2 5 4.5-2 4.5-5 4.5-5-2-5-4.5Z", "M12 7.5c-1-3 0-5 2-5.5", "M17 12c2.5 0 4 1.5 4.5 5", "M8 9.5 4.5 7", "M8 14.5 4.5 17", "M16 9.5 19.5 7", "M16 14.5l3 3.5"],
    dots: [[13.2, 3.4]],
    source: "custom",
  },
  // Custom: a crocodile in profile, open jaw, ridged back, two legs.
  crocodilians: {
    paths: ["M2 13.5 7 11l2-3h7l6 3.5-6 4H9l-7-2Z", "M9 8l1.5 2.5M12 8l1.5 2.5", "M9 15.5v3M15 15.5v3", "M7 11l-2 2.5"],
    dots: [[14, 10.5]],
    source: "custom",
  },
  // Custom: a frog facing you, two eye bulges, splayed hind legs.
  frogs: {
    paths: ["M6 14.5a6 4.5 0 1 0 12 0 6 4.5 0 1 0-12 0Z", "M6.5 15 3 19", "M17.5 15 21 19", "M9.5 19h5"],
    circles: [
      [9, 9.5, 2.2],
      [15, 9.5, 2.2],
    ],
    dots: [
      [9.4, 9.7],
      [14.6, 9.7],
    ],
    source: "custom",
  },
  // Custom: a spider, round abdomen, small head, eight legs.
  spiders: {
    paths: ["M9.2 11.5 4 8.5", "M9 13.5H3.5", "M9.6 15.5 5 19", "M14.8 11.5 20 8.5", "M15 13.5h5.5", "M14.4 15.5 19 19", "M11 10.5 9.5 5.5", "M13 10.5l1.5-5"],
    circles: [
      [12, 14, 3.2],
      [12, 9.5, 1.6],
    ],
    source: "custom",
  },
};
