/**
 * Per-app feed health for the selector's dots, from the global `GET /health` (PLAN.md C-A2: "lists apps with
 * per-app feed health"). The contract does not fix the shape, so this reads the plausible ones and calls the rest
 * unknown: `{apps: [{id, state}]}`, `{apps: {carp: {state}}}`, and either with `feeds: [{state}]` instead of a
 * state (worst feed wins). States are the C3 words in any case; `ok`/`healthy` read as nominal.
 */
import { APP_IDS, isAppId, type AppId } from "shared/apps";
import type { FeedHealth } from "shared/feed-state";

export type AppHealth = FeedHealth | "unknown";

const RANK: Record<FeedHealth, number> = { nominal: 0, lagging: 1, stale: 2, down: 3 };
const ALIASES: Record<string, FeedHealth> = { ok: "nominal", healthy: "nominal", up: "nominal", degraded: "lagging" };

function healthWord(v: unknown): FeedHealth | null {
  if (typeof v !== "string") return null;
  const w = v.trim().toLowerCase();
  return w in RANK ? (w as FeedHealth) : (ALIASES[w] ?? null);
}

function entryHealth(entry: unknown): AppHealth {
  if (!entry || typeof entry !== "object") return healthWord(entry) ?? "unknown";
  const e = entry as Record<string, unknown>;
  const direct = healthWord(e.state) ?? healthWord(e.health) ?? healthWord(e.status);
  if (direct) return direct;
  if (Array.isArray(e.feeds)) {
    const states = e.feeds.map((f) => healthWord((f as { state?: unknown } | null)?.state)).filter((s): s is FeedHealth => s !== null);
    if (states.length > 0) return states.reduce((worst, s) => (RANK[s] > RANK[worst] ? s : worst), "nominal" as FeedHealth);
  }
  return "unknown";
}

/** Health per app; every app is present, `unknown` when the body does not say. */
export function parseAppHealth(body: unknown): Record<AppId, AppHealth> {
  const out = Object.fromEntries(APP_IDS.map((id) => [id, "unknown"])) as Record<AppId, AppHealth>;
  const apps = body && typeof body === "object" ? (body as { apps?: unknown }).apps : undefined;
  if (Array.isArray(apps)) {
    for (const a of apps) {
      const id = (a as { id?: unknown } | null)?.id;
      if (isAppId(id)) out[id] = entryHealth(a);
    }
  } else if (apps && typeof apps === "object") {
    for (const [id, a] of Object.entries(apps)) if (isAppId(id)) out[id] = entryHealth(a);
  }
  return out;
}

/** Words for the dot's label. */
export function healthLabel(h: AppHealth): string {
  return h === "unknown" ? "feed health unknown" : h === "nominal" ? "feeds running normally" : `feeds ${h}`;
}

/** `GET /health`, parsed; every app `unknown` when it fails or is not JSON (an API that predates C-A2 answers "ok"). */
export async function fetchAppHealth(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Record<AppId, AppHealth>> {
  try {
    const res = await fetchImpl("/health", { headers: { accept: "application/json" }, signal });
    return parseAppHealth(res.ok ? await res.json() : null);
  } catch {
    return parseAppHealth(null);
  }
}
