/**
 * Per-app feed health for the selector's dots, from the global `GET /health` (PLAN.md C-A2). The body is exactly
 * what `api/src/app/mod.rs` `health` writes, 200 when every app's feed state could be computed, 503 (same body,
 * `status: "degraded"`) when one could not:
 *
 *   {status: "ok" | "degraded", defaultApp, apps: [{id, name, kind, provisional, regions, taxa, feeds}]}
 *
 * `feeds` is the app's C3 feed-state list (`api/src/feed_state.rs` `FeedState`, times as Unix ms), or
 * `{error}` when it could not be computed. A body of any other shape reads as unknown for every app.
 */
import { z } from "zod";

import { APP_IDS, type AppId } from "shared/apps";
import type { FeedHealth } from "shared/feed-state";

export type AppHealth = FeedHealth | "unknown";

const RANK: Record<FeedHealth, number> = { nominal: 0, lagging: 1, stale: 2, down: 3 };

const ms = z.number().int().nullable();
const feedState = z.strictObject({
  source: z.string(),
  mode: z.enum(["push", "poll"]),
  state: z.enum(["nominal", "lagging", "stale", "down"]),
  newestObservedAt: ms,
  lastFetchAt: ms,
  lastFetchRunId: z.string().nullable(),
  lagSeconds: z.number().nullable(),
  note: z.string().nullable(),
});

const appHealth = z.strictObject({
  id: z.enum(APP_IDS),
  name: z.string(),
  kind: z.enum(["species", "conditions"]),
  provisional: z.boolean(),
  regions: z.array(z.string()),
  taxa: z.array(z.string()),
  feeds: z.union([z.array(feedState), z.strictObject({ error: z.string() })]),
});

export const healthBodySchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  defaultApp: z.enum(APP_IDS),
  apps: z.array(appHealth),
});
export type HealthBody = z.output<typeof healthBodySchema>;

function entryHealth(feeds: HealthBody["apps"][number]["feeds"]): AppHealth {
  // The API could not compute this app's feed state: its data is not reachable.
  if (!Array.isArray(feeds)) return "down";
  if (feeds.length === 0) return "unknown";
  return feeds.reduce<FeedHealth>((worst, f) => (RANK[f.state] > RANK[worst] ? f.state : worst), "nominal");
}

/** Health per app; every app is present, `unknown` when the body does not list it or is not a `/health` body. */
export function parseAppHealth(body: unknown): Record<AppId, AppHealth> {
  const out = Object.fromEntries(APP_IDS.map((id) => [id, "unknown"])) as Record<AppId, AppHealth>;
  const parsed = healthBodySchema.safeParse(body);
  if (parsed.success) for (const app of parsed.data.apps) out[app.id] = entryHealth(app.feeds);
  return out;
}

/** Words for the dot's label. */
export function healthLabel(h: AppHealth): string {
  return h === "unknown" ? "feed health unknown" : h === "nominal" ? "feeds running normally" : `feeds ${h}`;
}

/** `GET /health`, parsed (a 503 carries the same body); every app `unknown` when it fails or is not that body. */
export async function fetchAppHealth(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Record<AppId, AppHealth>> {
  try {
    const res = await fetchImpl("/health", { headers: { accept: "application/json" }, signal });
    return parseAppHealth(res.ok || res.status === 503 ? await res.json() : null);
  } catch {
    return parseAppHealth(null);
  }
}
