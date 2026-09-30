# Gates: T1 contracts and skeleton

Scope: PLAN.md contracts C1–C15, a compiling skeleton for both stacks, and gates for every task.

- [x] G1: bun workspace installs and typechecks
  CHECK: bun install --frozen-lockfile >/dev/null && bun run typecheck 2>&1 | tail -1
  EXPECT: Exited with code 0
  EVIDENCE: web typecheck: Exited with code 0

- [x] G2: web contract tests pass
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "pass|fail"
  EXPECT: /5 pass[\s\S]*0 fail/
  EVIDENCE: 5 pass | 0 fail

- [x] G3: api builds and tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result"
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

- [x] G4: Next production build succeeds
  CHECK: bun run --cwd apps/web build 2>&1 | grep -c "prerendered as static"
  EXPECT: 1
  EVIDENCE: 1

- [x] G5: PLAN.md holds every contract
  CHECK: for c in C1 C2 C3 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14 C15; do grep -q "### $c:" PLAN.md || m=$((m+1)); done; echo "missing=${m:-0}"
  EXPECT: missing=0
  EVIDENCE: missing=0

- [x] G6: a gates file exists for every task T1-T36 plus the 4 nodes
  CHECK: n=0; for i in $(seq 1 36); do [ -f gates/leaf-T$i.md ] && n=$((n+1)); done; for x in data client convo team; do [ -f gates/node-$x.md ] && n=$((n+1)); done; echo "count=$n"
  EXPECT: count=40
  EVIDENCE: count=40
