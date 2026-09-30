//! GraphQL at /v1/graphql (PLAN.md C2). Queries and mutations: `POST /v1/graphql`.
//! Subscriptions: `GET /v1/graphql` upgraded to a WebSocket speaking graphql-transport-ws
//! (the legacy graphql-ws subprotocol is accepted too).
//!
//! The wiring lives here; resolver bodies live in `query.rs`, `mutation.rs` and `subscription.rs`,
//! and the SDL types in `types.rs`. `api/schema.graphql` is the contract, enforced by
//! `tests::schema_matches_contract`.

mod mutation;
mod query;
#[cfg(test)]
mod resolver_tests;
mod subscription;
pub mod types;

use async_graphql::http::ALL_WEBSOCKET_PROTOCOLS;
use async_graphql::{Context, Data, Schema};
use async_graphql_axum::rejection::GraphQLRejection;
use async_graphql_axum::{GraphQLProtocol, GraphQLRequest, GraphQLResponse, GraphQLWebSocket};
use axum::extract::{FromRequest, FromRequestParts, Request, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};

use crate::state::AppState;
pub use mutation::MutationRoot;
pub use query::QueryRoot;
pub use subscription::SubscriptionRoot;

pub type AppSchema = Schema<QueryRoot, MutationRoot, SubscriptionRoot>;

/// The schema, without state. `AppState` is attached per request (HTTP) or per connection (WS).
pub fn schema() -> AppSchema {
    Schema::build(QueryRoot, MutationRoot, SubscriptionRoot).finish()
}

/// The `AppState` attached to every operation by the handlers below.
pub(crate) fn app_state<'a>(ctx: &Context<'a>) -> &'a AppState {
    ctx.data_unchecked::<AppState>()
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Largest accepted POST body. async-graphql-axum reads the body as an unbounded stream, so the
/// cap is applied here before it parses.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

async fn post_graphql(State(state): State<AppState>, Extension(schema): Extension<AppSchema>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return (StatusCode::PAYLOAD_TOO_LARGE, format!("GraphQL request body exceeds {MAX_BODY_BYTES} bytes"))
                .into_response()
        }
    };
    let req = Request::from_parts(parts, axum::body::Body::from(bytes));
    match GraphQLRequest::<GraphQLRejection>::from_request(req, &()).await {
        Ok(req) => GraphQLResponse::from(schema.execute(req.into_inner().data(state)).await).into_response(),
        Err(rejection) => rejection.into_response(),
    }
}

/// WebSocket upgrade for subscriptions. A plain GET gets a 400 pointing at POST.
async fn get_graphql(State(state): State<AppState>, Extension(schema): Extension<AppSchema>, req: Request) -> Response {
    let (mut parts, _) = req.into_parts();
    // axum 0.8 has no Option<WebSocketUpgrade> extractor; try both extractors by hand.
    let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &()).await;
    let protocol = GraphQLProtocol::from_request_parts(&mut parts, &()).await;
    match (upgrade, protocol) {
        (Ok(ws), Ok(protocol)) => ws.protocols(ALL_WEBSOCKET_PROTOCOLS).on_upgrade(move |socket| {
            let mut data = Data::default();
            data.insert(state);
            GraphQLWebSocket::new(socket, schema, protocol).with_data(data).serve()
        }),
        _ => (
            StatusCode::BAD_REQUEST,
            "GET /v1/graphql only accepts a graphql-transport-ws WebSocket upgrade; send queries with POST",
        )
            .into_response(),
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/graphql", get(get_graphql).post(post_graphql)).layer(Extension(schema()))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use async_graphql::parser::parse_schema;
    use async_graphql::parser::types::{TypeKind, TypeSystemDefinition};
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use futures_util::{SinkExt, StreamExt};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::{test_app, test_state};
    use crate::feed_state;
    use crate::realtime::Event;

    /// Canonical form of an SDL document: descriptions, comments, formatting and the order of
    /// definitions and fields are dropped; argument lists, enum value order, types, defaults and
    /// directives are kept. Built-in directive definitions and the `schema {}` block are skipped
    /// (root types are still compared by name).
    fn canonical(sdl: &str) -> BTreeMap<String, Vec<String>> {
        const BUILTIN_DIRECTIVES: [&str; 5] = ["include", "skip", "deprecated", "specifiedBy", "oneOf"];
        let doc = parse_schema(sdl).expect("valid SDL");
        let mut out = BTreeMap::new();
        for def in doc.definitions {
            let (key, mut lines) = match def {
                TypeSystemDefinition::Schema(_) => continue,
                TypeSystemDefinition::Directive(d) => {
                    if BUILTIN_DIRECTIVES.contains(&d.node.name.node.as_str()) {
                        continue;
                    }
                    (format!("directive @{}", d.node.name.node), vec![format!("{:?}", d.node.locations)])
                }
                TypeSystemDefinition::Type(t) => {
                    let t = t.node;
                    let directives = |ds: &[async_graphql::Positioned<async_graphql::parser::types::ConstDirective>]| {
                        ds.iter()
                            .map(|d| {
                                let args: Vec<String> =
                                    d.node.arguments.iter().map(|(n, v)| format!("{}: {}", n.node, v.node)).collect();
                                format!(" @{}({})", d.node.name.node, args.join(", "))
                            })
                            .collect::<String>()
                    };
                    let input_value = |v: &async_graphql::parser::types::InputValueDefinition| {
                        let default = v.default_value.as_ref().map(|d| format!(" = {}", d.node)).unwrap_or_default();
                        format!("{}: {}{default}{}", v.name.node, v.ty.node, directives(&v.directives))
                    };
                    let head = format!("{}{}", t.name.node, directives(&t.directives));
                    match t.kind {
                        TypeKind::Scalar => (format!("scalar {head}"), vec![]),
                        TypeKind::Object(o) => {
                            let mut implements: Vec<String> = o.implements.iter().map(|i| i.node.to_string()).collect();
                            implements.sort();
                            let fields = o
                                .fields
                                .iter()
                                .map(|f| {
                                    let args: Vec<String> = f.node.arguments.iter().map(|a| input_value(&a.node)).collect();
                                    format!(
                                        "{}({}): {}{}",
                                        f.node.name.node,
                                        args.join(", "),
                                        f.node.ty.node,
                                        directives(&f.node.directives)
                                    )
                                })
                                .collect();
                            (format!("type {head} implements [{}]", implements.join(" & ")), fields)
                        }
                        TypeKind::Interface(i) => {
                            let fields = i.fields.iter().map(|f| format!("{}: {}", f.node.name.node, f.node.ty.node)).collect();
                            (format!("interface {head}"), fields)
                        }
                        TypeKind::Union(u) => {
                            let mut members: Vec<String> = u.members.iter().map(|m| m.node.to_string()).collect();
                            members.sort();
                            (format!("union {head} = {}", members.join(" | ")), vec![])
                        }
                        TypeKind::Enum(e) => {
                            // Value order is kept on purpose: it is visible through introspection.
                            let values = e.values.iter().map(|v| format!("{}{}", v.node.value.node, directives(&v.node.directives))).collect::<Vec<_>>();
                            (format!("enum {head} {{{}}}", values.join(" ")), vec![])
                        }
                        TypeKind::InputObject(i) => {
                            (format!("input {head}"), i.fields.iter().map(|f| input_value(&f.node)).collect())
                        }
                    }
                }
            };
            lines.sort();
            assert!(out.insert(key.clone(), lines).is_none(), "duplicate definition {key}");
        }
        out
    }

    #[test]
    fn schema_matches_contract() {
        let contract = canonical(include_str!("../../schema.graphql"));
        let actual = canonical(&schema().sdl());
        let names = |m: &BTreeMap<String, Vec<String>>| m.keys().cloned().collect::<Vec<_>>();
        assert_eq!(names(&actual), names(&contract), "type definitions differ");
        for (key, fields) in &contract {
            assert_eq!(&actual[key], fields, "fields of {key} differ");
        }
        // Guard the guard: the comparison must actually see the contract's contents.
        assert!(contract.len() >= 30, "only {} definitions parsed", contract.len());
        assert!(contract["type Query implements []"].iter().any(|f| f.starts_with("sightings(bbox: BBox!, from: Time!")));
    }

    #[test]
    fn canonical_form_catches_drift() {
        let base = "type Query { a(x: Int = 1): String b: [ID!]! }\nenum E { A B }";
        let same = "# c\nenum E { A B }\n\"\"\"doc\"\"\"\ntype Query {\n  b: [ID!]!\n  \"d\" a(x: Int = 1): String\n}";
        assert_eq!(canonical(base), canonical(same));
        for drifted in [
            "type Query { a(x: Int = 2): String b: [ID!]! }\nenum E { A B }",
            "type Query { a(x: Int = 1): String! b: [ID!]! }\nenum E { A B }",
            "type Query { a(x: Int = 1): String b: [ID!] }\nenum E { A B }",
            "type Query { a(x: Int = 1): String b: [ID!]! c: Int }\nenum E { A B }",
            "type Query { a(x: Int = 1): String b: [ID!]! }\nenum E { B A }",
            "type Query { a(x: Int = 1): String b: [ID!]! }\nenum E { A B }\nscalar Time",
        ] {
            assert_ne!(canonical(base), canonical(drifted), "{drifted}");
        }
    }

    pub(super) async fn post(app: axum::Router, body: Value) -> (StatusCode, Value) {
        let res = app
            .oneshot(
                Request::post("/v1/graphql")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("non-JSON body ({e}): {bytes:?}")))
    }

    async fn seed_feed(state: &AppState, fetched_at: i64) {
        state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into sources (id, name, homepage, mode, cadence_s, max_latency_s)
                     values ('inat', 'iNaturalist', 'https://www.inaturalist.org', 'poll', 120, 1800)",
                    [],
                )?;
                tx.execute(
                    "insert into fetch_runs (source_id, fetched_at, received_at, status) values ('inat', ?1, ?1, 'ok')",
                    [fetched_at],
                )
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn graphql_http_smoke() {
        let (app, state) = test_app();

        let (status, body) = post(app.clone(), json!({"query": "{ feeds { source } }"})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"data": {"feeds": []}}));

        let fetched_at = now_ms() - 30_000;
        seed_feed(&state, fetched_at).await;
        let (status, body) = post(
            app.clone(),
            json!({"query": "{ feeds { source mode state newestObservedAt lastFetchAt lagSeconds note } }"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let feed = &body["data"]["feeds"][0];
        assert_eq!(feed["source"], "inat");
        assert_eq!(feed["mode"], "POLL");
        assert_eq!(feed["state"], "NOMINAL");
        assert_eq!(feed["newestObservedAt"], Value::Null);
        assert_eq!(feed["note"], "fetching; no observations stored yet");
        let last = feed["lastFetchAt"].as_str().expect("lastFetchAt is an RFC 3339 string");
        assert_eq!(chrono::DateTime::parse_from_rfc3339(last).unwrap().timestamp_millis(), fetched_at);

        // Argument validation reaches the client as a GraphQL error, not a transport error.
        let (status, body) = post(
            app.clone(),
            json!({"query": "{ sightings(bbox: {west: 1, south: 0, east: 0, north: 1}, from: \"2026-01-01T00:00:00Z\", to: \"2026-01-02T00:00:00Z\") { id } }"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["errors"][0]["message"].as_str().unwrap().contains("invalid bbox"), "{body}");

        let (_, body) = post(app.clone(), json!({"query": "{ frames(from: \"yesterday\", to: \"2026-01-02T00:00:00Z\", stepMinutes: 15) { frameCount } }"})).await;
        assert!(body["errors"][0]["message"].as_str().unwrap().contains("RFC 3339"), "{body}");

        let (status, body) = post(
            app,
            json!({"query": "mutation($ops: [OpInput!]!) { applyOps(boardId: \"b\", ops: $ops) { applied duplicates lastSeq } }",
                   "variables": {"ops": [{"id": "o1", "hlc": "1:0:n", "entity": "note", "entityId": "e", "field": "text", "value": {"k": 1}, "nodeId": "n"}]}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"]["applyOps"], json!({"applied": 1, "duplicates": 0, "lastSeq": 1}));
    }

    #[tokio::test]
    async fn plain_get_is_rejected_with_a_hint() {
        let (app, _) = test_app();
        let res = app.oneshot(Request::get("/v1/graphql").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn time_scalar_round_trips_rfc3339() {
        let (app, _) = test_app();
        let (_, body) = post(
            app,
            json!({"query": "{ frames(from: \"2026-09-30T12:00:00+02:00\", to: \"2026-09-30T10:15:00.250Z\", stepMinutes: 15) { from to } }"}),
        )
        .await;
        assert_eq!(body["data"]["frames"], json!({"from": "2026-09-30T10:00:00.000Z", "to": "2026-09-30T10:15:00.250Z"}));
    }

    fn insert_op(seq: i64, board: &'static str) -> impl FnOnce(&rusqlite::Transaction) -> rusqlite::Result<usize> {
        move |tx| {
            tx.execute(
                "insert into ops (seq, id, board_id, hlc, entity, entity_id, field, value, node_id, received_at)
                 values (?1, 'op' || ?1, ?2, ?1 || ':0:n', 'note', 'e1', 'text', '{\"v\":' || ?1 || '}', 'n', 0)",
                rusqlite::params![seq, board],
            )
        }
    }

    fn op_event(seq: i64, board: &str) -> Event {
        Event::Op {
            board_id: board.into(),
            seq,
            op: json!({"id": format!("op{seq}"), "hlc": format!("{seq}:0:n"), "boardId": board, "entity": "note",
                       "entityId": "e1", "field": "text", "value": {"v": seq}, "nodeId": "n"}),
        }
    }

    #[tokio::test]
    async fn ops_subscription_replays_backlog_then_streams_without_repeats() {
        let state = test_state();
        for seq in 1..=3 {
            state.team.write(insert_op(seq, "b1")).await.unwrap();
        }
        state.team.write(insert_op(4, "other")).await.unwrap();

        let (_, body) = post(crate::app::app(state.clone()),json!({"query": "{ opsSince(boardId: \"b1\", seq: 1) { seq id value } }"})).await;
        assert_eq!(
            body["data"]["opsSince"],
            json!([{"seq": 2, "id": "op2", "value": {"v": 2}}, {"seq": 3, "id": "op3", "value": {"v": 3}}])
        );

        let request = async_graphql::Request::new("subscription { ops(boardId: \"b1\", afterSeq: 1) { seq id hlc entityId value } }")
            .data(state.clone());
        let mut stream = schema().execute_stream(request);
        let seq_of = |r: async_graphql::Response| {
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            r.data.into_json().unwrap()["ops"]["seq"].as_i64().unwrap()
        };
        assert_eq!(seq_of(stream.next().await.unwrap()), 2);
        assert_eq!(seq_of(stream.next().await.unwrap()), 3);
        // Already replayed (3), another board, then a new op for this board.
        state.hub.publish(op_event(3, "b1"));
        state.hub.publish(op_event(9, "other"));
        state.hub.publish(op_event(5, "b1"));
        let next = tokio::time::timeout(Duration::from_secs(2), stream.next()).await.unwrap().unwrap();
        assert_eq!(
            next.data.into_json().unwrap()["ops"],
            json!({"seq": 5, "id": "op5", "hlc": "5:0:n", "entityId": "e1", "value": {"v": 5}})
        );
    }

    #[tokio::test]
    async fn feeds_subscription_sends_snapshot_then_updates() {
        let state = test_state();
        seed_feed(&state, now_ms()).await;
        let request = async_graphql::Request::new("subscription { feeds { source state } }").data(state.clone());
        let mut stream = schema().execute_stream(request);
        let first = stream.next().await.unwrap().data.into_json().unwrap();
        assert_eq!(first, json!({"feeds": {"source": "inat", "state": "NOMINAL"}}));
        state.hub.publish(Event::FeedState(feed_state::FeedState {
            source: "goes19".into(),
            mode: "push".into(),
            state: feed_state::Health::Down,
            newest_observed_at: None,
            last_fetch_at: None,
            last_fetch_run_id: None,
            lag_seconds: None,
            note: Some("SQS unreachable".into()),
        }));
        let next = tokio::time::timeout(Duration::from_secs(2), stream.next()).await.unwrap().unwrap();
        assert_eq!(next.data.into_json().unwrap(), json!({"feeds": {"source": "goes19", "state": "DOWN"}}));
    }

    /// End to end over a real socket: WebSocket upgrade, graphql-transport-ws handshake, and a
    /// Hub event delivered as a `next` message.
    #[tokio::test]
    async fn websocket_subscription_receives_hub_events() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;

        let state = test_state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::app::app(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        let mut req = format!("ws://{addr}/v1/graphql").into_client_request().unwrap();
        req.headers_mut().insert("Sec-WebSocket-Protocol", "graphql-transport-ws".parse().unwrap());
        let (mut ws, res) = tokio_tungstenite::connect_async(req).await.unwrap();
        assert_eq!(res.headers()["sec-websocket-protocol"], "graphql-transport-ws");

        async fn next_json(
            ws: &mut (impl futures_util::Stream<Item = tokio_tungstenite::tungstenite::Result<Message>> + Unpin),
        ) -> Value {
            loop {
                match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
                    Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
                    Message::Ping(_) | Message::Pong(_) => continue,
                    other => panic!("unexpected frame {other:?}"),
                }
            }
        }

        ws.send(Message::text(json!({"type": "connection_init"}).to_string())).await.unwrap();
        assert_eq!(next_json(&mut ws).await["type"], "connection_ack");
        ws.send(Message::text(
            json!({"id": "1", "type": "subscribe", "payload": {"query": "subscription { framesUpdated { from to } }"}}).to_string(),
        ))
        .await
        .unwrap();

        // The server subscribes to the Hub asynchronously; publish until the event gets through.
        let publisher = {
            let hub = state.hub.clone();
            tokio::spawn(async move {
                loop {
                    hub.publish(Event::FramesUpdated { from: 0, to: 900_000 });
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
        };
        let msg = next_json(&mut ws).await;
        publisher.abort();
        assert_eq!(
            msg,
            json!({"id": "1", "type": "next", "payload": {"data": {"framesUpdated": {"from": "1970-01-01T00:00:00.000Z", "to": "1970-01-01T00:15:00.000Z"}}}})
        );
        server.abort();
    }
}
