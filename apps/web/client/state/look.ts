import { key } from "@calvinjs/active-state";

/**
 * The look of the globe (docs/GODS_EYE.md GC2): one of seven visual presets, drawn as Cesium post-process
 * stages by `client/globe/look`, and the circular scope mask with its feathered edge, drawn once by the stage
 * shell's CSS circle (`client/hud/shell/StageShell.tsx`). The share link carries all three as `look`, `scope` and `feather`.
 */
import { LOOK_IDS, type LookId } from "shared/look";

export { LOOK_IDS, type LookId };

export const DEFAULT_LOOK: LookId = "normal";
export const DEFAULT_SCOPE_ON = true;
/** Edge feather as a percentage of the scope radius, 0 (hard crop) to 100. */
export const DEFAULT_SCOPE_FEATHER = 11;
export const MAX_SCOPE_FEATHER = 100;

export const LOOK = key<"LOOK", LookId>("LOOK", DEFAULT_LOOK);
export const SCOPE_ON = key<"SCOPE_ON", boolean>("SCOPE_ON", DEFAULT_SCOPE_ON);
export const SCOPE_FEATHER = key<"SCOPE_FEATHER", number>("SCOPE_FEATHER", DEFAULT_SCOPE_FEATHER);

export function isLookId(value: unknown): value is LookId {
  return typeof value === "string" && (LOOK_IDS as readonly string[]).includes(value);
}

/** A stored or decoded look, with anything unknown reading as the default. */
export function lookOf(value: unknown): LookId {
  return isLookId(value) ? value : DEFAULT_LOOK;
}

/** A stored or decoded feather: a whole number 0..100, anything else the default. */
export function featherOf(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SCOPE_FEATHER;
  return Math.min(MAX_SCOPE_FEATHER, Math.max(0, Math.round(n)));
}

export function scopeOnOf(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SCOPE_ON;
}
