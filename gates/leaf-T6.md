# Gates: T6 deploy and CI (opus)

Tools: if missing, `brew install caddy actionlint shellcheck` (Docker daemon is down on this Mac).

Scope: deploy/ from big-value (Caddyfile with /v1/* + /health -> 127.0.0.1:4041 incl. websockets, else -> 127.0.0.1:3050, COOP/COEP on all responses; inversa-api/web/litestream systemd units; litestream.yml for data/observations.db + data/team.db to R2 1s sync; bootstrap.sh with restore-on-boot) and workflows release.yml, deploy.yml (Doppler env render, scp, restart), workers.yml (wrangler deploy apps/signal-worker).

- [ ] G1: Caddyfile validates
  CHECK: caddy validate --config deploy/Caddyfile --adapter caddyfile 2>&1 | tail -1
  EXPECT: Valid configuration
  EVIDENCE: pending

- [ ] G2: workflows lint clean
  CHECK: actionlint -color=never 2>&1 | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: pending

- [ ] G3: Caddy sets both isolation headers and routes /v1 with websocket support
  CHECK: grep -cE "Cross-Origin-(Opener|Embedder)-Policy|reverse_proxy .*4041|reverse_proxy .*3050" deploy/Caddyfile
  EXPECT: /^[4-9]|[1-9][0-9]/m
  EVIDENCE: pending

- [ ] G4: litestream config covers both databases
  CHECK: grep -cE "observations\.db|team\.db" deploy/litestream.yml
  EXPECT: /^[2-9]/m
  EVIDENCE: pending

- [ ] G5: bootstrap restores DBs when missing (litestream restore -if-replica-exists) and units have hardening (ProtectSystem=strict)
  CHECK: grep -c "restore" deploy/bootstrap.sh && grep -l "ProtectSystem=strict" deploy/*.service | wc -l | tr -d ' '
  EXPECT: /[1-9]\s+[2-9]/
  EVIDENCE: pending

- [ ] G6: shellcheck clean on deploy scripts
  CHECK: shellcheck deploy/*.sh 2>&1 | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: pending

- [ ] G7 (live, blocked on H1 H2 H3 H8): deploy workflow run succeeds (quote run URL)
  EVIDENCE: pending
