# Gates: T1 contracts and skeleton

Scope: PLAN.md contracts C1–C15, a compiling skeleton for both stacks, and gates for every task.

- [ ] G1: bun workspace installs and typechecks
  CHECK: bun install --frozen-lockfile >/dev/null && bun run typecheck 2>&1 | tail -1
  EXPECT: Exited with code 0
  EVIDENCE: pending

- [ ] G2: web contract tests pass
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "pass|fail"
  EXPECT: /5 pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: api builds and tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result"
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: pending

- [ ] G4: Next production build succeeds
  CHECK: bun run --cwd apps/web build 2>&1 | grep -c "prerendered as static"
  EXPECT: 1
  EVIDENCE: pending

- [ ] G5: PLAN.md holds every contract
  CHECK: for c in C1 C2 C3 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14 C15; do grep -q "### $c:" PLAN.md || echo "missing $c"; done; echo done
  EXPECT: /^done$/
  EVIDENCE: pending

- [ ] G6: a gates file exists for every task T1-T36 plus the 4 nodes
  CHECK: n=0; for i in $(seq 1 36); do [ -f gates/leaf-T$i.md ] && n=$((n+1)); done; for x in data client convo team; do [ -f gates/node-$x.md ] && n=$((n+1)); done; echo "count=$n"
  EXPECT: count=40
  EVIDENCE: pending
