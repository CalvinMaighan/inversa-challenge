/** Sustained mic level while assistant audio is playing. Not armed when idle. */
export const BARGE_IN_SUSTAIN_MS = 250;
export const BARGE_IN_LEVEL = 0.12;

export function createBargeInDetector(
  sustainMs = BARGE_IN_SUSTAIN_MS,
  level = BARGE_IN_LEVEL,
): {
  push(input: { level: number; playing: boolean; now: number }): boolean;
} {
  let since: number | null = null;
  let fired = false;

  return {
    push(input) {
      if (!input.playing || input.level < level) {
        since = null;
        fired = false;
        return false;
      }
      if (since === null) since = input.now;
      if (fired) return false;
      if (input.now - since >= sustainMs) {
        fired = true;
        return true;
      }
      return false;
    },
  };
}
