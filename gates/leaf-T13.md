# Gates: T13 agent port (cordis + DeepSeek) (opus)

Scope:
- Port the deedee cordis/dsh harness into `apps/web/server/agent/**`, pinned to deedee's `@deepseek-ai/*` versions. `cordis.yml` sets `deepseek-v4-flash` on Fireworks, escalating to `deepseek-v4-pro-0813`.
- Capability tools: geocode, sightings, conditions, alerts, hotspots, explain_cell, backtest, feed_state, set_view. Each tool makes exactly one GraphQL call to Axum (INVERSA_API_ORIGIN), and each result row carries `{kind,id}` plus the C3 envelope.
- The stream bridge enforces C7 and C14 citations: ids not returned by tools in this turn are stripped and a debug event is emitted.
- Limits: 12 turns, 30 tool calls, 90 s. A daily token budget. An answer cache keyed by (normalized question, data version).
- `POST /api/agent/stream` returns NDJSON.
- `bun run eval` runs about 15 golden questions against a fixture GraphQL stub.

- [x] G1: harness tests pass with the mock LLM (tool loop, citation stripping, limits, view event, cache hit)
  CHECK: cd apps/web && bun test tests/server/agent 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 52 pass | 0 fail

- [x] G2: the citation checker strips an id that no tool returned (named test)
  CHECK: cd apps/web && bun test tests/server/agent -t "strips unverified citation" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G3: the eval runs and prints `EVAL passed P/T`; with the mock LLM in replay mode P must equal T
  CHECK: cd apps/web && AGENT_EVAL_MODE=replay bun run eval 2>&1 | tail -1
  EXPECT: /EVAL passed (\d+)\/\1/
  EVIDENCE: EVAL passed 15/15

- [x] G4: the route streams valid C7 NDJSON: every line parses and satisfies isAgentStreamEvent, and the last event is done (route test with the mock harness)
  CHECK: cd apps/web && bun test tests/server/agent -t "route streams ndjson" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G5: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN

- [ ] G6: (live, blocked on H5) a real question against local Axum with fixtures returns a cited answer (quote the transcript lines)
  EVIDENCE: pending

ABANDON: G6 blocked on H5 (FIREWORKS_API_KEY) and a running Axum with data
