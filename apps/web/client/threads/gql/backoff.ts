/** Reconnect delay for the graphql-transport-ws socket: 500 ms doubling to 30 s. Pure. */

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

/** `attempt` counts failures so far: 1 -> 1 s, 2 -> 2 s, ... capped. */
export function backoffMs(attempt: number, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS): number {
  if (attempt <= 0) return 0;
  return Math.min(max, base * 2 ** attempt);
}
