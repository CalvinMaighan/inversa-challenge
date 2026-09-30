# Gates: T2 active-state + active-theme subtrees (opus)

Scope: both libraries vendored as git subtrees under packages/, consumed as workspace packages, with the active-theme import fix.

- [x] G1: active-state subtree present with upstream history squashed
  CHECK: git log --oneline -- packages/active-state | grep -ci "squash\|subtree\|Add 'packages/active-state"
  EXPECT: /[1-9]/
  EVIDENCE: 1

- [x] G2: active-theme subtree present
  CHECK: test -f packages/active-theme/package.json && git log --oneline -- packages/active-theme | wc -l | tr -d ' '
  EXPECT: /[1-9]/
  EVIDENCE: 1

- [x] G3: no unscoped active-state imports remain in active-theme
  CHECK: grep -rnE "from ['\"]active-state" packages/active-theme/src | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: 0

- [x] G4: both packages build
  CHECK: (cd packages/active-state && bun run build >/dev/null 2>&1 && echo AS-OK); (cd packages/active-theme && bun run build >/dev/null 2>&1 && echo AT-OK)
  EXPECT: /AS-OK[\s\S]*AT-OK/
  EVIDENCE: AS-OK | AT-OK

- [x] G5: both existing test suites pass
  CHECK: (cd packages/active-state && bun test 2>&1 | grep -E "^ *[0-9]+ fail"); (cd packages/active-theme && bun test 2>&1 | grep -E "^ *[0-9]+ fail")
  EXPECT: /^ *0 fail\s+ *0 fail\s*$/m
  EVIDENCE: 0 fail | 0 fail

- [x] G6: apps/web resolves both from the workspace (not npm)
  CHECK: grep -E '"(@calvinjs/active-state|active-theme)": "workspace:\*"' apps/web/package.json | wc -l | tr -d ' ' && bun run --cwd apps/web typecheck >/dev/null 2>&1 && echo TC-OK
  EXPECT: /2\s+TC-OK/
  EVIDENCE: 2 | TC-OK

- [x] G7: root check still green
  CHECK: bun run typecheck 2>&1 | grep -c "Exited with code 0"
  EXPECT: /[1-9]/
  EVIDENCE: 3

- [x] G8: both packages typecheck through their own scripts
  CHECK: (cd packages/active-state && bun run typecheck >/dev/null 2>&1 && echo AS-TC); (cd packages/active-theme && bun run typecheck >/dev/null 2>&1 && echo AT-TC)
  EXPECT: /AS-TC[\s\S]*AT-TC/
  EVIDENCE: AS-TC | AT-TC

- [x] G9: no unscoped active-state in active-theme manifest, tsup or tsconfig
  CHECK: grep -nE '"active-state(/[a-z]+)?"' packages/active-theme/package.json packages/active-theme/tsup.config.ts packages/active-theme/tsconfig.json | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: 0

- [x] G10: workspace package named @calvinjs/active-state and web resolves both into packages/
  CHECK: grep -c '"name": "@calvinjs/active-state"' packages/active-state/package.json && cd apps/web && bun -e 'console.log(Bun.resolveSync("@calvinjs/active-state/react", process.cwd()), Bun.resolveSync("active-theme/state", process.cwd()))'
  EXPECT: /1\s+\S*packages\/active-state\/dist\/react\/index\.js \S*packages\/active-theme\/dist\/state\/index\.js/
  EVIDENCE: 1 | /Users/calvin/Documents/inversa-challenge/.claude/worktrees/agent-abad7a14a560faa54/packages/active-state/dist/react/index.js /Users/calvin/Documents/inversa-challenge/.claude/worktrees/agent-abad

- [x] G11: root test green across all workspaces
  CHECK: bun run test 2>&1 | grep -c "Exited with code 0"
  EXPECT: /^3$/m
  EVIDENCE: 3
