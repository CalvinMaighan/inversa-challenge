/**
 * Transcript-level intents that must not wait for the model (from deedee `eager-spawn.ts`,
 * minus the Jev classifier, which Inversa does not ship).
 */

import { decide, type GlideOptions } from "@/server/fastino/glide";

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

/**
 * The same question for what a transcript's wording does not settle ("okay that's enough thanks", "hold on"): ask Fastino GLiDE
 * whether a short utterance tells the voice to stop talking or cancel. Null when there is no decision (no key, slow, down), so
 * the regexes above stay the floor.
 */
export async function decidesStop(text: string, options: GlideOptions = {}): Promise<boolean | null> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return null;
  const result = await decide(
    { utterance: text.slice(0, 200), context: "The user is talking to a voice assistant that may be speaking or running an analysis." },
    { stop: { type: "noul", instructions: "Is the user telling the assistant to stop talking, be quiet, cancel what it is doing, or that it has said enough?", criteria: { true: "Stop or cancel", false: "Something else" } } },
    { timeoutMs: 2_500, ...options },
  );
  if (!result) return null;
  const p = result.answers.stop.noul;
  return p >= 0.9 ? true : p <= 0.5 ? false : null;
}
