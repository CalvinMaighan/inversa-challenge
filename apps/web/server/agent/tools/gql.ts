/** GraphQL client for Axum `/v1/<app>/graphql` (PLAN.md C2, C-A2). One POST per call. */

import { apiOrigin } from "@/server/agent/config";
import type { AppConfig } from "@/shared/apps";
import { isDisabledFeed, type FeedHealth, type FeedState } from "@/shared/feed-state";

const REQUEST_TIMEOUT_MS = 15_000;

export class GraphqlError extends Error {}

/** Which app's API a call goes to, and the turn's abort signal. A `CapabilityContext` is one. */
export type GqlScope = { app: Pick<AppConfig, "id">; signal?: AbortSignal };

/** The app's GraphQL endpoint (C-A2). There is no unprefixed route. */
export function graphqlUrl(app: Pick<AppConfig, "id">): string {
  return `${apiOrigin()}/v1/${encodeURIComponent(app.id)}/graphql`;
}

export async function gql<T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  scope: GqlScope,
): Promise<T> {
  const { signal } = scope;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(graphqlUrl(scope.app), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ operationName, query, variables }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (timeout.aborted) throw new GraphqlError(`${operationName}: data API timed out after ${REQUEST_TIMEOUT_MS} ms`);
    throw new GraphqlError(
      `${operationName}: data API unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const text = await response.text();
  let body: { data?: T | null; errors?: { message?: string }[] } | undefined;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = undefined;
  }
  if (!response.ok && !body?.errors?.length) {
    throw new GraphqlError(`${operationName}: HTTP ${response.status}`);
  }
  if (body?.errors?.length) {
    throw new GraphqlError(`${operationName}: ${body.errors.map((error) => error.message ?? "error").join("; ")}`);
  }
  if (!body?.data) throw new GraphqlError(`${operationName}: empty response`);
  return body.data;
}

const FEED_BASE_FIELDS = "source mode state newestObservedAt lastFetchAt lagSeconds note";

/**
 * `FeedState.lastFetchRunId` (accepted into C3/C14 with T10) makes staleness
 * citable as `fetch:<id>`. An API that predates it rejects the field; the
 * first such rejection drops it for the rest of the process.
 */
let feedRunIds = true;

function feedFragment(): string {
  return `fragment FeedFields on FeedState { ${FEED_BASE_FIELDS}${feedRunIds ? " lastFetchRunId" : ""} }`;
}

/**
 * Query that selects `...FeedFields`; the fragment is appended here. Still one
 * POST per call, except the single retry when the API lacks `lastFetchRunId`.
 */
export async function gqlWithFeeds<T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  scope: GqlScope,
): Promise<T> {
  const withRunIds = feedRunIds;
  try {
    return await gql<T>(operationName, `${query}\n${feedFragment()}`, variables, scope);
  } catch (error) {
    if (!withRunIds || !(error instanceof GraphqlError) || !error.message.includes("lastFetchRunId")) throw error;
    feedRunIds = false;
    return gql<T>(operationName, `${query}\n${feedFragment()}`, variables, scope);
  }
}

/** Test-only: assume the API has `lastFetchRunId` again. */
export function resetFeedFieldProbe(): void {
  feedRunIds = true;
}

/** The API's longest `from`..`to` window for `sightings` and `readings` (api/src/graphql/query.rs `MAX_WINDOW_MS`). */
export const MAX_API_WINDOW_MS = 31 * 24 * 3_600_000;

/**
 * A windowed query (`from`, `to` in `variables`) that may span more than the API's 31-day cap: fetched as
 * consecutive pages of at most 31 days, newest first, with the row lists under `key` concatenated and the
 * feeds taken from the first page. One POST when the window fits.
 */
export async function gqlWindowed<T extends Record<string, unknown> & { feeds: GqlFeedState[] }, K extends keyof T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown> & { from: string; to: string },
  key: K,
  scope: GqlScope,
): Promise<T> {
  const from = Date.parse(variables.from);
  const to = Date.parse(variables.to);
  if (!(to - from > MAX_API_WINDOW_MS)) return gqlWithFeeds<T>(operationName, query, variables, scope);
  const pages: { from: string; to: string }[] = [];
  for (let end = to; end > from; end -= MAX_API_WINDOW_MS) pages.push({ from: new Date(Math.max(from, end - MAX_API_WINDOW_MS)).toISOString(), to: new Date(end).toISOString() });
  const results = await Promise.all(pages.map((page) => gqlWithFeeds<T>(operationName, query, { ...variables, ...page }, scope)));
  const rows = results.flatMap((r) => (Array.isArray(r[key]) ? (r[key] as unknown[]) : []));
  // A row on a page boundary (observed exactly at a page's `to`) appears on both pages: keep it once.
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const id = JSON.stringify(row);
    return !seen.has(id) && seen.add(id);
  });
  return { ...results[0]!, [key]: unique } as T;
}

export type GqlFeedState = {
  source: string;
  mode: string;
  state: string;
  newestObservedAt: string | null;
  lastFetchAt: string | null;
  lagSeconds: number | null;
  note: string | null;
  lastFetchRunId?: string | null;
};

const HEALTH = new Set<FeedHealth>(["nominal", "lagging", "stale", "down"]);

/** GraphQL enums are upper case; the C3 envelope is lower case. Unknown health reads as down. */
export function toFeedState(feed: GqlFeedState): FeedState {
  const state = feed.state.toLowerCase() as FeedHealth;
  return {
    source: feed.source,
    mode: feed.mode.toLowerCase() === "push" ? "push" : "poll",
    state: HEALTH.has(state) ? state : "down",
    newestObservedAt: feed.newestObservedAt ?? null,
    lastFetchAt: feed.lastFetchAt ?? null,
    lastFetchRunId: feed.lastFetchRunId ?? null,
    lagSeconds: feed.lagSeconds ?? null,
    note: feed.note ?? null,
  };
}

/** Data version for the answer cache: the newest `lastFetchAt` across feeds. */
export function dataVersion(feeds: readonly FeedState[]): string | null {
  let best: number | null = null;
  for (const feed of feeds) {
    const at = feed.lastFetchAt ? Date.parse(feed.lastFetchAt) : NaN;
    if (Number.isFinite(at) && (best === null || at > best)) best = at;
  }
  return best === null ? null : new Date(best).toISOString();
}

export async function fetchFeeds(scope: GqlScope): Promise<FeedState[]> {
  const data = await gqlWithFeeds<{ feeds: GqlFeedState[] }>("AgentFeeds", "query AgentFeeds { feeds { ...FeedFields } }", {}, scope);
  return data.feeds.filter((f) => !isDisabledFeed(f)).map(toFeedState);
}
