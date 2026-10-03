/** Constants shared by the server layout (the head script and stylesheet) and the client gate. No imports: the layout is a server module. */
export const INTRO_ATTR = "data-intro";
/**
 * The head script also sets this window flag: React strips attributes it does not render from `<html>` when it
 * hydrates, so the gate puts `data-intro` back from the flag in its first layout effect (before any paint).
 */
export const INTRO_FLAG = "__inversaIntro";
/** `?intro=0` skips the gate (tests, screenshots, deep links for developers). */
export const INTRO_SKIP_PARAM = "intro";
/** How long the gate takes to blur out; the app's chrome fades in over the same time. */
export const LEAVE_MS = 1100;
