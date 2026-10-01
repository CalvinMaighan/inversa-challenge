/**
 * `GET /api/health` (R19): what the web tier can reach, for the deploy smoke test, an uptime monitor and a person
 * reading it. Axum's own `/health` says how each app's feeds are; this adds what only the web process knows:
 *
 * - `api`: Axum answers `/health` (3 s timeout);
 * - `apps[]`: each app's databases open (Axum computed its feed state, which reads `observations.db`), and every
 *   feed that is `down` with its reason (a missing credential says which one);
 * - `signal`: the board's signal Worker answers (`SIGNAL_WORKER_URL`);
 * - `agent`, `voice`: the provider key is set and no daily cap is used up.
 *
 * `status` is `ok`, `degraded` (an optional dependency is down: a feed, the Worker, a provider key, a cap) or
 * `down` (Axum is unreachable or an app's database failed: the map's data path is broken). HTTP 503 only for
 * `down`. Results are cached for 5 s, so the endpoint cannot be used to hammer Axum or the Worker.
 */

import { dailyUsdLimits, spendRefusal, spendToday } from "@/server/agent/budget";
import { apiOrigin } from "@/server/agent/config";
import { MISSING_KEY_MESSAGE, openRouterApiKey } from "@/server/agent/runtime/model";
import { APP_IDS } from "@/shared/apps";

export type Dependency = { state: "up" | "down"; reason?: string };

export type AppEntry = {
  id: string;
  db: "ok" | "down";
  reason?: string;
  /** Feeds by state, from Axum's `/health`. */
  feeds: Record<"nominal" | "lagging" | "stale" | "down", number>;
  /** Every `down` feed and why, verbatim from Axum's feed note. */
  downFeeds: { source: string; reason: string }[];
};

export type WebHealth = {
  status: "ok" | "degraded" | "down";
  checkedAt: string;
  api: Dependency & { latencyMs?: number };
  apps: AppEntry[];
  signal: Dependency;
  agent: Dependency & { spentUsd: number; capUsd: number };
  voice: Dependency;
};

const TIMEOUT_MS = 3_000;
const CACHE_MS = 5_000;

type ApiFeed = { source?: unknown; state?: unknown; note?: unknown };
type ApiApp = { id?: unknown; feeds?: unknown };

function message(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} s` : error.message;
  return String(error);
}

async function probeApi(): Promise<{ dep: WebHealth["api"]; apps: ApiApp[] }> {
  const started = performance.now();
  try {
    const res = await fetch(`${apiOrigin()}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    const latencyMs = Math.round(performance.now() - started);
    const body = (await res.json().catch(() => null)) as { apps?: unknown } | null;
    if (!body || !Array.isArray(body.apps)) return { dep: { state: "down", reason: `API /health answered ${res.status} without an app list`, latencyMs }, apps: [] };
    // 503 from Axum means an app's feed state failed; it is still up, and the app entry says which.
    return { dep: { state: "up", latencyMs }, apps: body.apps as ApiApp[] };
  } catch (error) {
    return { dep: { state: "down", reason: `API unreachable: ${message(error)}` }, apps: [] };
  }
}

function appEntry(id: string, api: WebHealth["api"], apps: ApiApp[]): AppEntry {
  const feeds = { nominal: 0, lagging: 0, stale: 0, down: 0 };
  if (api.state === "down") return { id, db: "down", reason: "API unreachable", feeds, downFeeds: [] };
  const found = apps.find((a) => a.id === id);
  if (!found) return { id, db: "down", reason: "the API does not serve this app (INVERSA_APPS)", feeds, downFeeds: [] };
  if (!Array.isArray(found.feeds)) {
    const error = (found.feeds as { error?: unknown } | undefined)?.error;
    return { id, db: "down", reason: typeof error === "string" ? error : "feed state could not be computed", feeds, downFeeds: [] };
  }
  const downFeeds: AppEntry["downFeeds"] = [];
  for (const feed of found.feeds as ApiFeed[]) {
    const state = feed.state;
    if (state === "nominal" || state === "lagging" || state === "stale" || state === "down") feeds[state] += 1;
    if (state === "down") downFeeds.push({ source: String(feed.source), reason: typeof feed.note === "string" && feed.note ? feed.note : "down (no reason given)" });
  }
  return { id, db: "ok", feeds, downFeeds };
}

/** The Worker's own origin (not the browser's `/signal` path): Next calls it directly. */
export function signalWorkerUrl(): string | undefined {
  return process.env.SIGNAL_WORKER_URL?.trim().replace(/\/+$/, "") || undefined;
}

async function probeSignal(): Promise<Dependency> {
  const base = signalWorkerUrl();
  if (!base) return { state: "down", reason: "SIGNAL_WORKER_URL is not set; peers cannot meet over WebRTC, board edits still sync through the API" };
  try {
    // A room listing: one R2 read, no write, no TURN call. A request with no Origin is served (Worker README).
    const res = await fetch(`${base}/rooms/health-probe/peers`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    return res.ok ? { state: "up" } : { state: "down", reason: `signal Worker answered ${res.status}` };
  } catch (error) {
    return { state: "down", reason: `signal Worker unreachable: ${message(error)}` };
  }
}

function agentDependency(): WebHealth["agent"] {
  const spentUsd = Math.round(spendToday().usd * 100) / 100;
  const capUsd = dailyUsdLimits().global;
  if (!openRouterApiKey()) return { state: "down", reason: MISSING_KEY_MESSAGE, spentUsd, capUsd };
  const capped = APP_IDS.map((id) => spendRefusal(id)).find((r) => r && r.cap !== "app_usd");
  if (capped) return { state: "down", reason: capped.message, spentUsd, capUsd };
  return { state: "up", spentUsd, capUsd };
}

function voiceDependency(): Dependency {
  return process.env.XAI_API_KEY?.trim() ? { state: "up" } : { state: "down", reason: "voice unavailable: XAI_API_KEY not set" };
}

export async function computeHealth(now = new Date()): Promise<WebHealth> {
  const [{ dep: api, apps }, signal] = await Promise.all([probeApi(), probeSignal()]);
  const entries = APP_IDS.map((id) => appEntry(id, api, apps));
  const agent = agentDependency();
  const voice = voiceDependency();
  const broken = api.state === "down" || entries.some((e) => e.db === "down");
  const optionalDown = signal.state === "down" || agent.state === "down" || voice.state === "down" || entries.some((e) => e.downFeeds.length > 0);
  return {
    status: broken ? "down" : optionalDown ? "degraded" : "ok",
    checkedAt: now.toISOString(),
    api,
    apps: entries,
    signal,
    agent,
    voice,
  };
}

let cached: { at: number; value: Promise<WebHealth> } | undefined;

/** `computeHealth`, shared by every caller within 5 s. */
export function health(nowMs = Date.now()): Promise<WebHealth> {
  if (cached && nowMs - cached.at < CACHE_MS) return cached.value;
  const value = computeHealth(new Date(nowMs));
  cached = { at: nowMs, value };
  return value;
}

/** Test-only. */
export function clearHealthCache(): void {
  cached = undefined;
}
