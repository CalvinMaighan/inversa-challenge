/**
 * gql worker (PRD §12 "New tech 1"): GraphQL over HTTP and graphql-transport-ws for the whole tab. Main
 * calls it through `GqlRpcClient`; the db worker gets its own port (`gql:link-db`) for revalidation and the
 * outbox. It also relays `framesUpdated` to the db worker. State keys are the HUD's to write (C16: the HUD
 * owns FEEDS); the thread link here only mirrors the catalog for reads.
 */
import { connectThread } from "@calvinjs/active-state/threads";

import { state } from "client/state";

import { GRAPHQL_HTTP_PATH, postGraphql, resolveWsUrl, SubscriptionClient } from "./gql/client";
import { serveGqlRpc, type FromGql, type GqlHandlers } from "./gql/protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Before the first await, so the host handshake is not missed.
connectThread(scope, state);

const HTTP_URL = new URL(GRAPHQL_HTTP_PATH, scope.location.origin).href;
const WS_URL = resolveWsUrl({
  explicit: process.env.NEXT_PUBLIC_INVERSA_WS_URL,
  dev: process.env.NODE_ENV !== "production",
  location: scope.location,
});

export const FRAMES_UPDATED_SUBSCRIPTION = "subscription { framesUpdated { from to } }";

let dbPort: MessagePort | null = null;

const ws = new SubscriptionClient({
  url: WS_URL,
  onStatus: (socket) => scope.postMessage({ t: "gql:status", socket } satisfies FromGql),
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

ws.subscribe(FRAMES_UPDATED_SUBSCRIPTION, {}, {
  next: (data) => {
    const r = (data as { framesUpdated?: { from: string; to: string } }).framesUpdated;
    if (r) dbPort?.postMessage({ t: "gql:frames-updated", from: r.from, to: r.to } satisfies FromGql);
  },
  error: (err) => console.warn("[threads/gql] framesUpdated subscription", err.message),
});
