/** GraphQL client for Axum `/v1/graphql` (PLAN.md C2). One POST per call. */

import { apiOrigin } from "@/server/agent/config";
import type { FeedHealth, FeedState } from "@/shared/feed-state";

const REQUEST_TIMEOUT_MS = 15_000;

export class GraphqlError extends Error {}

export async function gql<T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}/v1/graphql`, {
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
  signal?: AbortSignal,
): Promise<T> {
  const withRunIds = feedRunIds;
  try {
    return await gql<T>(operationName, `${query}\n${feedFragment()}`, variables, signal);
  } catch (error) {
    if (!withRunIds || !(error instanceof GraphqlError) || !error.message.includes("lastFetchRunId")) throw error;
    feedRunIds = false;
    return gql<T>(operationName, `${query}\n${feedFragment()}`, variables, signal);
  }
}

/** Test-only: assume the API has `lastFetchRunId` again. */
export function resetFeedFieldProbe(): void {
  feedRunIds = true;
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

export async function fetchFeeds(signal?: AbortSignal): Promise<FeedState[]> {
  const data = await gqlWithFeeds<{ feeds: GqlFeedState[] }>(
    "AgentFeeds",
    "query AgentFeeds { feeds { ...FeedFields } }",
    {},
    signal,
  );
  return data.feeds.map(toFeedState);
}
