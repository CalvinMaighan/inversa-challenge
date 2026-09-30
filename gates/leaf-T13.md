# Gates: T13 agent port (cordis harness) (opus)

Scope:
- Port the deedee cordis/dsh harness into `apps/web/server/agent/**`, pinned to deedee's `@deepseek-ai/*` versions. `cordis.yml` sets one model: `openai/gpt-6-luna` on OpenRouter (T39 replaced DeepSeek on Fireworks and removed the escalation row and the mock LLM).
- Capability tools: geocode, sightings, conditions, alerts, hotspots, explain_cell, backtest, feed_state, set_view. Each tool makes exactly one GraphQL call to Axum (INVERSA_API_ORIGIN), and each result row carries `{kind,id}` plus the C3 envelope.
- The stream bridge enforces C7 and C14 citations: ids not returned by tools in this turn are stripped and a debug event is emitted.
- Limits: 12 turns, 30 tool calls, 90 s. A daily token budget. An answer cache keyed by (normalized question, data version).
- `POST /api/agent/stream` returns NDJSON, or 503 `agent unavailable: OPENROUTER_API_KEY not set`.
- `bun run eval` runs 15 golden questions live against a fixture GraphQL stub.

- [x] G1: harness unit tests pass with no secrets (stream bridge mapping, citation stripping, limits arithmetic, cache keying, budget, route validation, OpenRouter request and chunk mapping), and the live suite passes against OpenRouter (tool loop, citations, limits, cache hit, route)
  CHECK: cd apps/web && env -u OPENROUTER_API_KEY bun test --tsconfig-override ./tsconfig.json tests/server/agent 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' ' && bun run test:live 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' '
  EXPECT: /[1-9][0-9]* pass\s+0 fail\s+[1-9][0-9]* pass\s+0 fail/
  EVIDENCE: 52 pass  0 fail  8 pass  0 fail

- [x] G2: the citation checker strips an id that no tool returned (named test over a scripted session-event sequence fed into the bridge)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests/server/agent -t "invented citations" 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' '
  EXPECT: /1 pass\s+0 fail/
  EVIDENCE: 1 pass  0 fail

- [x] G3: the live eval prints `EVAL passed P/T` and `EVAL quality passed q/5` with at least 13 of 15 and 4 of 5
  CHECK: bun run eval 2>&1 | grep -E "^EVAL (quality )?passed" | tr '\n' ' '
  EXPECT: /EVAL quality passed [45]\/5 EVAL passed 1[3-5]\/15/
  EVIDENCE: EVAL quality passed 5/5 EVAL passed 15/15

- [x] G4: the route streams valid C7 NDJSON from the live model: every line parses and satisfies isAgentStreamEvent, and the last event is done
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun test --tsconfig-override ./tsconfig.json --timeout 240000 tests/live -t "POST streams valid C7 NDJSON" 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' '
  EXPECT: /1 pass\s+0 fail/
  EVIDENCE: 1 pass  0 fail

- [x] G5: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN

- [x] G6: a real question against the live model returns a cited answer (quote the transcript lines)
  EVIDENCE: 2026-09-30, `bun run dev` (Doppler inversa/dev key) on a local Axum loaded with `backfill --fixtures`, `curl -N POST /api/agent/stream` "What are dive conditions at Biscayne for lionfish removal right now?": 408 NDJSON lines, tools geocode, conditions, alerts, hotspots, backtest, explain_cell, set_view; 10 citation events, 1 view, 1 done last. Transcript: "**Recommendation: hold the dive for now.** A **Small Craft Advisory** is in effect through **11 a.m. EDT Thursday, Oct. 1** ... [e:alert:1] ... The most recent usable water-temperature reading was **28.7°C** at Virginia Key, measured at **4:30 p.m. EDT Wednesday, Sept. 30**. [e:reading:19:water_c:1790800200000:measured] ... **Data caveat:** CO-OPS is down; its newest observation is from 4:30 p.m. EDT ... [e:fetch:10]"
