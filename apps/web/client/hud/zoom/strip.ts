import { STAGE_MEDIA } from "../shell/geometry";

/**
 * Where the zoom strip sits (GE10): in the timeline's row, at its right end, `--gap-m` from the timeline, the right edge and the
 * bottom. The timeline narrows to make room, by this width plus one gap. Both measure against the HUD's size container
 * (`globe`), so the numbers agree without either measuring the other.
 *
 * The strip is inline from 768 px up (the stage layout) while the HUD has room for it (`STRIP_INLINE_QUERY`); a narrower
 * HUD puts it just above the timeline, still at the right, and a phone gets the + and - pair only.
 */
export const STRIP_WIDTH_CSS = "clamp(212px, 34cqw, 320px)";
/** The strip's height: two rows (the scale and the buttons), no taller than the timeline's bar on any app. */
export const STRIP_HEIGHT_PX = 82;
export const STRIP_INLINE_QUERY = "@container globe (min-width: 560px)";

/** The timeline's right edge when the strip sits beside it: its own gutter plus the strip and one more gutter. */
export const TIMELINE_RIGHT_WITH_STRIP_CSS = `calc(max(var(--gap-m), env(safe-area-inset-right)) + ${STRIP_WIDTH_CSS} + var(--gap-m))`;

/** CSS for a timeline root: leave room for the strip where the strip is inline. */
export const TIMELINE_STRIP_ROOM = `
  ${STAGE_MEDIA} {
    ${STRIP_INLINE_QUERY} {
      right: ${TIMELINE_RIGHT_WITH_STRIP_CSS};
    }
  }
`;
