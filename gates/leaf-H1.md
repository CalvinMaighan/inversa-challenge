# Gates: H1 production hardening and deploy readiness, three apps (opus)

Contract: `docs/OVERNIGHT_BRIEF.md` R19 (production-ready, not deployed; no push, no deploy, no credentials entered), `docs/ingest-modes.md` (as built), `deploy/**`, `.github/workflows/**`, `docs/security.md`, `docs/perf.md`, `apps/web/e2e/prod.ts`, the existing rate limits and cost caps in the agent route (`apps/web/app/api/agent/**`, `server/agent/budget.ts`, `cache.ts`), voice caps. You own: `deploy/**`, `.github/workflows/**`, `docs/security.md`, `docs/perf.md`, `docs/HUMAN_STEPS.md`, `apps/web/e2e/prod.ts` plus the `e2e:prod` script, `apps/web/app/api/**` limits and health only, `api/src/app/mod.rs` health and limits only. Do not edit agent prompts, tools or eval (AG2 and AGB) or UI. Never print or commit secrets. Commit on your worktree branch, no push. macOS has no `timeout` command.

Scope: the single deployment at `inversa.calvinmaighan.dev` serving carp (default), lionfish and python; per-app SQLite files under `INVERSA_DATA_DIR/<app>`; Litestream per app file; Caddy keeps the domain with `/v1/*` to Axum, `/signal/*` to the Worker, the rest to Next; systemd units; env documentation. Ingestion credentials that are absent (GOES SQS, NWWS, `USGS_API_KEY`, `INGEST_HOOK_SECRET`, `INGEST_NUDGE_TOKEN`, OpenRouter via Doppler) degrade honestly: feed chips show down with a reason, no crash.

- [ ] G1: per-app limits and caps: the agent route enforces a per-IP rate limit, a per-app and global daily cost cap (the $5 default, configurable), max tokens and tool-call budget, and the answer cache is keyed by app + question + data version; exceeding a limit returns a clear typed message the UI shows, never a stack trace; voice caps unchanged; tests named `prod limits`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "prod limits" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: health and degradation: `/health` is app-aware JSON (built); web `/api/health` reports api reachability, per-app DB opens and signal worker reachability; a missing credential or dead upstream is `down` with the reason in `/health` and the UI chips while cached data still serves; `e2e:prod` boots the production build (next build + release API) with sources off and no credentials and prints one line per app: `PROD app=<id> health=ok ratelimit=ok costcap=ok errors=ok degraded=ok`
  CHECK: cd apps/web && bun run e2e:prod 2>&1 | grep -c "^PROD app=.* health=ok ratelimit=ok costcap=ok errors=ok degraded=ok"
  EXPECT: /^\s*3\s*$/m
  EVIDENCE: pending

- [ ] G3: security pass: `docs/security.md` re-audited for the three-app, webhook and messaging surface (hook HMAC and replay window, nudge tokens, CORS and COEP credentialless, CSP, signal worker abuse limits, DM and notes text-only rendering, prompt injection through notes and feeds, SSRF in source links, no cookies, secrets handling, dependency audit results quoted from `bun audit` and `cargo audit` if available); every finding fixed or listed with a reason; `e2e:prod` prints `HEADERS coop=ok coep=ok csp=ok nosniff=ok referrer=ok`
  CHECK: cd apps/web && bun run e2e:prod 2>&1 | grep "^HEADERS "
  EXPECT: /HEADERS coop=ok coep=ok csp=ok nosniff=ok referrer=ok/
  EVIDENCE: pending

- [ ] G4: deploy artifacts consistent with per-app data: systemd units, Caddyfile, `deploy/litestream.yml` (three apps x observations and team DBs), `bootstrap.sh`, `remote-unpack.sh`, `restore.sh`, `migrate-app-dirs.sh`, release and deploy workflows; `bash -n` clean on every script; `deploy/test-restore.sh` restores all three apps from a local Litestream replica fixture and prints `RESTORE-OK apps=3`; Caddy config validates if `caddy` is installed, otherwise a documented skip
  CHECK: for f in deploy/*.sh; do bash -n $f || echo BAD $f; done; bash deploy/test-restore.sh 2>&1 | tail -1
  EXPECT: /RESTORE-OK apps=3/
  EVIDENCE: pending

- [ ] G5: `docs/HUMAN_STEPS.md` lists every step only the user can do, in order, each with the exact command or URL, why, and what breaks without it: Hetzner VM, DNS, Cloudflare R2 and Worker, Doppler prd config (names only, no values), GitHub Actions secrets, OpenRouter key limits, AWS account + SQS queue + SNS subscription for GOES-19, NWWS-OI application (10+ days), USGS API key, IEMBot and ERDDAP nudge subscriptions with `INGEST_NUDGE_TOKEN`, first deploy and smoke (`GRADE_URL`), rollback; nothing in it is done by the agent
  EVIDENCE: pending

- [ ] G6: performance budget on the production build across apps: first globe frame, app switch under 500 ms warm, scrub median under 16 ms, idle CPU near zero; `docs/perf.md` updated with measured numbers per app (use e2e:perf, e2e:scrub, e2e:appselect and any idle script that exists); quote the lines
  CHECK: cd apps/web && bun run e2e:scrub 2>&1 | grep SCRUB
  EXPECT: /SCRUB median=(1[0-5]|[0-9])(\.\d+)? requests=0/
  EVIDENCE: pending

- [ ] G7: web tests, typecheck, lint, api suite and clippy clean; web and API release builds succeed (state counts)
  CHECK: bun run check 2>&1 | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /CHECK-OK[\s\S]*Finished/
  EVIDENCE: pending
