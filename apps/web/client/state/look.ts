import { key } from "@calvinjs/active-state";

/**
 * The look of the globe (docs/GODS_EYE.md GC2, GE9, GE11): one of seven visual presets, drawn as Cesium post-process
 * stages by `client/globe/look`, and the map window (the scope), drawn once as the stage shell's CSS mask
 * (`client/hud/shell/StageShell.tsx`, maths in `client/hud/shell/scope.ts`). The window is always there, with three
 * independent controls: its shape and its size (the part that is always fully visible) and its soft edge, which
 * fades the map out gradually OUTSIDE that shape (0 = a hard edge, black beyond it; 100 = no vignette at all). The
 * share link carries them as `look`, `shape`, `size` and `feather`.
 */
import { LOOK_IDS, type LookId } from "shared/look";

export { LOOK_IDS, type LookId };

export const DEFAULT_LOOK: LookId = "normal";
/** Soft edge, 0 (hard edge, black outside the shape) to 100 (no vignette); the default is a gentle visible fade. */
export const DEFAULT_SCOPE_FEATHER = 50;
export const MAX_SCOPE_FEATHER = 100;
/** Edge blur, in px of backdrop blur at the window's outer rim: 0 (none) to 40; the blur grows from nothing inside the window to this along the soft edge. */
export const DEFAULT_SCOPE_BLUR = 6;
export const MAX_SCOPE_BLUR = 40;

/** The window's shape: a circle, a wide oval, a wide rounded rectangle, or the whole page with only the soft edge. */
export const SCOPE_SHAPES = ["circle", "oval", "rounded", "frame"] as const;
export type ScopeShape = (typeof SCOPE_SHAPES)[number];
export const DEFAULT_SCOPE_SHAPE: ScopeShape = "circle";
/** Window size as a percentage of the room its shape may take, scaled about the stage centre. */
export const MIN_SCOPE_SIZE = 30;
export const MAX_SCOPE_SIZE = 100;
export const DEFAULT_SCOPE_SIZE = 65;

export const LOOK = key<"LOOK", LookId>("LOOK", DEFAULT_LOOK);
export const SCOPE_FEATHER = key<"SCOPE_FEATHER", number>("SCOPE_FEATHER", DEFAULT_SCOPE_FEATHER);
export const SCOPE_BLUR = key<"SCOPE_BLUR", number>("SCOPE_BLUR", DEFAULT_SCOPE_BLUR);
export const SCOPE_SHAPE = key<"SCOPE_SHAPE", ScopeShape>("SCOPE_SHAPE", DEFAULT_SCOPE_SHAPE);
export const SCOPE_SIZE = key<"SCOPE_SIZE", number>("SCOPE_SIZE", DEFAULT_SCOPE_SIZE);

export function isLookId(value: unknown): value is LookId {
  return typeof value === "string" && (LOOK_IDS as readonly string[]).includes(value);
}

/** A stored or decoded look, with anything unknown reading as the default. */
export function lookOf(value: unknown): LookId {
  return isLookId(value) ? value : DEFAULT_LOOK;
}

/** A whole number within [lo, hi] from a stored or decoded value (number or numeric string); anything else `fallback`. */
function wholeIn(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** A stored or decoded feather: a whole number 0..100, anything else the default. */
export function featherOf(value: unknown): number {
  return wholeIn(value, 0, MAX_SCOPE_FEATHER, DEFAULT_SCOPE_FEATHER);
}

/** A stored or decoded edge blur: a whole number 0..40 px, anything else the default. */
export function blurOf(value: unknown): number {
  return wholeIn(value, 0, MAX_SCOPE_BLUR, DEFAULT_SCOPE_BLUR);
}

export function isScopeShape(value: unknown): value is ScopeShape {
  return typeof value === "string" && (SCOPE_SHAPES as readonly string[]).includes(value);
}

/** A stored or decoded shape, anything unknown reading as the circle. */
export function shapeOf(value: unknown): ScopeShape {
  return isScopeShape(value) ? value : DEFAULT_SCOPE_SHAPE;
}

/** A stored or decoded size: a whole number 30..100, anything else the default (100). */
export function sizeOf(value: unknown): number {
  return wholeIn(value, MIN_SCOPE_SIZE, MAX_SCOPE_SIZE, DEFAULT_SCOPE_SIZE);
}
