/**
 * `/dev/*` scratch routes (fixture globe, HUD, agent, threads): on under `next dev`, 404 in a production
 * build unless the server runs with `INVERSA_DEV_ROUTES=1` (the e2e scripts do). Read per request, never at
 * build time, so one build serves both production (off) and e2e (on).
 */
export function devRoutesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" || env.INVERSA_DEV_ROUTES === "1";
}
