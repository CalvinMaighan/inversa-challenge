import { key } from "@calvinjs/active-state";

/**
 * The look of the globe (docs/GODS_EYE.md GC2, GE9): one of seven visual presets, drawn as Cesium post-process
 * stages by `client/globe/look`, and the map window (the scope), drawn once as the stage shell's CSS mask
 * (`client/hud/shell/StageShell.tsx`, maths in `client/hud/shell/scope.ts`). The window has three independent
 * controls: its shape, its size and its soft edge. The share link carries them as `look`, `scope`, `shape`, `size`
 * and `feather`.
 */
import { LOOK_IDS, type LookId } from "shared/look";

export { LOOK_IDS, type LookId };

export const DEFAULT_LOOK: LookId = "normal";
export const DEFAULT_SCOPE_ON = true;
/** Edge feather as a percentage of half the window's shorter side, 0 (hard crop) to 100. */
export const DEFAULT_SCOPE_FEATHER = 11;
export const MAX_SCOPE_FEATHER = 100;

/** The window's shape: a circle, a wide oval, a wide rounded rectangle, or the whole page with only the soft edge. */
export const SCOPE_SHAPES = ["circle", "oval", "rounded", "frame"] as const;
export type ScopeShape = (typeof SCOPE_SHAPES)[number];
export const DEFAULT_SCOPE_SHAPE: ScopeShape = "circle";
/** Window size as a percentage of the room its shape may take, scaled about the stage centre. */
export const MIN_SCOPE_SIZE = 30;
export const MAX_SCOPE_SIZE = 100;
export const DEFAULT_SCOPE_SIZE = 100;

export const LOOK = key<"LOOK", LookId>("LOOK", DEFAULT_LOOK);
export const SCOPE_ON = key<"SCOPE_ON", boolean>("SCOPE_ON", DEFAULT_SCOPE_ON);
export const SCOPE_FEATHER = key<"SCOPE_FEATHER", number>("SCOPE_FEATHER", DEFAULT_SCOPE_FEATHER);
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

export function scopeOnOf(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SCOPE_ON;
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
