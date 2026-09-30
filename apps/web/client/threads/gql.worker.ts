/**
 * gql worker (PRD §12 "New tech 1"): GraphQL over HTTP and graphql-transport-ws for the whole tab. Main
 * calls it through `GqlRpcClient`; the db worker gets its own port (`gql:link-db`) for revalidation and the
 * outbox. It also keeps `FEEDS` current through the thread link and relays `framesUpdated` to the db worker.
 */
import { set } from "@calvinjs/active-state";
import { connectThread } from "@calvinjs/active-state/threads";

import { state } from "client/state";
import { FEEDS, mergeFeedState } from "client/state/feeds";
import type { FeedState } from "shared/feed-state";

import { GRAPHQL_HTTP_PATH, postGraphql, resolveWsUrl, SubscriptionClient } from "./gql/client";
import { FEEDS_QUERY, FEEDS_SUBSCRIPTION, FRAMES_UPDATED_SUBSCRIPTION, normalizeFeed, type WireFeed } from "./gql/feeds";
import { serveGqlRpc, type FromGql, type GqlHandlers, type GqlResult } from "./gql/protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Before the first await, so the host handshake is not missed.
connectThread(scope, state);

const HTTP_URL = new URL(GRAPHQL_HTTP_PATH, scope.location.origin).href;
const WS_URL = resolveWsUrl({
  explicit: process.env.NEXT_PUBLIC_INVERSA_WS_URL,
  dev: process.env.NODE_ENV !== "production",
  location: scope.location,
});

let dbPort: MessagePort | null = null;
let everOpen = false;

const ws = new SubscriptionClient({
  url: WS_URL,
  onStatus: (socket) => {
    scope.postMessage({ t: "gql:status", socket } satisfies FromGql);
    // After a reconnect the feed snapshot may be behind; the subscription only carries changes from now on.
    if (socket === "open" && everOpen) void loadFeeds();
    if (socket === "open") everOpen = true;
  },
});

const handlers: GqlHandlers = {
  request: (query, variables, signal) => postGraphql(HTTP_URL, query, variables, fetch, signal),
  subscribe: (query, variables, sink) => ws.subscribe(query, variables, sink),
};

serveGqlRpc(scope, handlers, (m) => {
  if (m.t !== "gql:link-db") return;
  dbPort = m.port;
  serveGqlRpc(m.port, handlers);
});

async function loadFeeds(): Promise<void> {
  const res = (await handlers.request(FEEDS_QUERY, {}, new AbortController().signal)) as GqlResult<{ feeds: WireFeed[] }>;
  const feeds = res.data?.feeds;
  if (!feeds) return;
  set<FeedState[]>(FEEDS, (prev = []) => feeds.map(normalizeFeed).reduce((list, f) => mergeFeedState(list, f), prev));
}

void loadFeeds();

ws.subscribe(FEEDS_SUBSCRIPTION, {}, {
  next: (data) => {
    const f = (data as { feeds?: WireFeed }).feeds;
    if (f) set<FeedState[]>(FEEDS, (prev = []) => mergeFeedState(prev, normalizeFeed(f)));
  },
  error: (err) => console.warn("[threads/gql] feeds subscription", err.message),
});

ws.subscribe(FRAMES_UPDATED_SUBSCRIPTION, {}, {
  next: (data) => {
    const r = (data as { framesUpdated?: { from: string; to: string } }).framesUpdated;
    if (r) dbPort?.postMessage({ t: "gql:frames-updated", from: r.from, to: r.to } satisfies FromGql);
  },
  error: (err) => console.warn("[threads/gql] framesUpdated subscription", err.message),
});
