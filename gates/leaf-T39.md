# Gates: T39 real agent via OpenRouter gpt-6-luna, mock removed (opus)

Scope:
- The agent talks to OpenRouter only (`https://openrouter.ai/api/v1`, model `openai/gpt-6-luna`, key `OPENROUTER_API_KEY` from Doppler `inversa`/`dev`), with `reasoning: {effort}`, attribution headers, streaming, tool calls and usage accounting. One model, no escalation.
- Mock mode is gone: no mock LLM plugin, no `AGENT_HARNESS`, no `/dev/agent/mock`, no eval replay. With no key, the route answers 503 `agent unavailable: OPENROUTER_API_KEY not set`.
- `bun run test` needs no secrets. `bun run test:live` and `bun run eval` run live under doppler.

- [x] G1: no agent mocking left: mock LLM, harness modes, replay mode and Fireworks references all gone (T38's `server/agent/tools/**` excluded, reported separately)
  CHECK: grep -rniE '\bmock|AGENT_HARNESS|harnessMode\b|AGENT_EVAL_MODE|replayScript|fireworks|deepseek-v4' apps/web/server/agent apps/web/server/voice apps/web/app apps/web/eval apps/web/e2e/agent.ts apps/web/tests/server/agent apps/web/tests/live scripts package.json apps/web/package.json deploy/README.md .github/workflows --exclude-dir=tools --exclude-dir=node_modules | wc -l | tr -d ' '
  EXPECT: /^\s*0\s*$/
  EVIDENCE: 0

- [x] G2: nothing anywhere in apps/web imports the mock LLM or reads AGENT_HARNESS
  CHECK: grep -rnE 'mock-llm|setMockScript|AGENT_HARNESS|FIREWORKS_' apps/web scripts --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yml' --exclude-dir=node_modules --exclude-dir=.next | grep -v 'use-client-purity.test.ts' | wc -l | tr -d ' '
  EXPECT: /^\s*0\s*$/
  EVIDENCE: 0

- [x] G3: `bun run test` is green with no secrets in the environment (live tests excluded)
  CHECK: env -u OPENROUTER_API_KEY bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' '
  EXPECT: /[1-9][0-9]* pass\s+0 fail/
  EVIDENCE: 541 pass  0 fail

- [x] G4: the route answers 503 with the exact message when the key is missing (unit test, no secrets)
  CHECK: cd apps/web && env -u OPENROUTER_API_KEY bun test tests/server/agent -t "503" 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' '
  EXPECT: /[1-9] pass\s+0 fail/
  EVIDENCE: 2 pass  0 fail

- [x] G5: `bun run test:live` is green against OpenRouter: real tool call, verified citation, route streams C7 NDJSON ending in done, limits hold
  CHECK: bun run test:live 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" | tr '\n' ' '
  EXPECT: /[1-9][0-9]* pass\s+0 fail/
  EVIDENCE: 8 pass  0 fail

- [x] G6: live eval passes at least 13 of 15 golden questions and at least 4 of 5 quality questions
  CHECK: bun run eval 2>&1 | grep -E "^EVAL (quality )?passed" | tr '\n' ' '
  EXPECT: /EVAL quality passed [45]\/5 EVAL passed 1[3-5]\/15/
  EVIDENCE: EVAL quality passed 4/5 EVAL passed 14/15

- [x] G7: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN

- [x] G8: `next build` succeeds
  CHECK: cd apps/web && bun run build 2>&1 | grep -E "Compiled successfully|Failed to compile|Build error" | head -1
  EXPECT: Compiled successfully
  EVIDENCE: ✓ Compiled successfully in 1603ms

- [x] G9: a real OpenRouter request carries `reasoning: {effort}` and the attribution headers and streams a tool call plus usage (unit test on the request builder, plus a live probe quote)
  EVIDENCE: OpenRouter docs (openrouter.ai/docs/use-cases/reasoning-tokens): `"reasoning": {"effort": ...}` with efforts none..xhigh; reasoning streams as `delta.reasoning` or `delta.reasoning_details`. Live probe 2026-09-30 (curl, doppler key, headers `HTTP-Referer: https://inversa.calvinmaighan.dev`, `X-Title: Everglades Ops`, body `"reasoning":{"effort":"low"}`, one tool): `"model":"openai/gpt-6-luna","provider":"OpenAI"`, `tool_calls ... "name":"get_weather"`, args streamed `{"city":"Miami"}`, `"finish_reason":"tool_calls"`, final chunk `"usage":{"prompt_tokens":52,"completion_tokens":18,...,"cost":0.0000142}`. Unit tests `tests/server/agent/openrouter-adapter.test.ts` assert `body.reasoning == {effort}`, no `reasoning_effort`, no default temperature, the headers and base URL, and map that recorded chunk sequence.

- [x] G10: `bun run dev` loads Doppler inversa/dev into the children without printing it, falls back to the plain env with a warning, and runs api, web and the signal Worker; Ctrl-C stops all three
  EVIDENCE: 2026-09-30 smoke run: first line `agent: openrouter openai/gpt-6-luna (key from doppler inversa/dev) · web: http://localhost:3050 · signal: http://127.0.0.1:8799`; `lsof` showed `inversa-a 127.0.0.1:4041`, `node *:3050`, `workerd 127.0.0.1:8799`; `[signal] ⛅️ wrangler 4.145.0`; `grep -ci sk-or` on the log: 0. SIGINT to `bun scripts/dev.ts`: `[api] exited with 143`, `[signal] exited with 143`, `[web] exited with 0`, then 0 listeners on 3050/4041/8799. Fallback run with `DOPPLER_TOKEN=dp.st.invalid`: `warning: Doppler inversa/dev not loaded (Doppler Error: Invalid Auth token); using the plain environment.` then `agent: unavailable, OPENROUTER_API_KEY not set (/api/agent/stream answers 503)`. Driver re-verified 2026-09-30 23:12Z on main: 3 listeners up, /health ok, live agent answered with 4 tools, 7 citations and a view event; no key in the log.

- [x] G11: the agent e2e runs the live model: open the card, ask, tool rows, globe flies, citation opens the drawer; FLOW-OK
  CHECK: bun run --cwd apps/web e2e:agent 2>&1 | tail -1
  EXPECT: FLOW-OK
  EVIDENCE: FLOW-OK
