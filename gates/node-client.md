# Gates: node-client (integration of T2 T3 T16 T17 T18 T19)

Scope: the globe renders SAB frames that the db worker fetched from local Axum, under cross-origin isolation.

- [x] N1: every child leaf gates file is met, or its ABANDON lines are live-only
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/leaf-T2.md gates/leaf-T3.md gates/leaf-T16.md gates/leaf-T17.md gates/leaf-T18.md gates/leaf-T19.md 2>&1 | tail -3
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: gates/leaf-T19.md: 4 gates | ALL MET (40 met, 1 abandoned)

- [x] N2: web typecheck, lint, test and build are clean on the merged tree
  CHECK: bun run lint >/dev/null 2>&1 && bun run typecheck >/dev/null 2>&1 && bun run test >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo WEB-OK
  EXPECT: WEB-OK
  EVIDENCE: WEB-OK

- [x] N3: a Playwright smoke against next start + local Axum with fixtures prints "CLIENT isolated=true frames>0 errors=0"
  CHECK: cd apps/web && bun run e2e:client 2>&1 | grep CLIENT
  EXPECT: /CLIENT isolated=true frames>0 errors=0/
  EVIDENCE: CLIENT isolated=true frames>0 errors=0

- [x] N4: T18's scrub gate re-run on the merged tree
  CHECK: cd apps/web && bun run e2e:scrub 2>&1 | grep SCRUB
  EXPECT: /requests=0/
  EVIDENCE: SCRUB median=10.53 requests=0 p95=16.65 work_median=0.37 frames=96 verified=96
