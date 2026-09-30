/**
 * Transcript-level intents that must not wait for the model (from deedee `eager-spawn.ts`,
 * minus the Jev classifier, which Inversa does not ship).
 */

function stem(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_LINE =
  /^(stop|stop talking|stop it|please stop|that'?s enough|shut up|be quiet|quiet|cancel that|never mind|nevermind)$/;

const HANG_UP_LINE = /^(end voice|end voice mode|hang up|stop listening|goodbye|bye|that'?s all)$/;

/** The whole utterance is a stop: cut playback and cancel running analysis. */
export function looksLikeStop(text: string): boolean {
  return STOP_LINE.test(stem(text));
}

/** The whole utterance ends the voice session. */
export function looksLikeHangUp(text: string): boolean {
  return HANG_UP_LINE.test(stem(text));
}

/**
 * One analysis task per voice turn. A second `spawn_thinking` in the same turn joins the task
 * already started, even when Grok rewrote the objective.
 */
export function claimTurn(existingTaskId: string | null): { action: "attach"; taskId: string } | { action: "start" } {
  if (existingTaskId) return { action: "attach", taskId: existingTaskId };
  return { action: "start" };
}
