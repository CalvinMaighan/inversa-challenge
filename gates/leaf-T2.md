# Gates: T2 active-state + active-theme subtrees (opus)

Scope: both libraries vendored as git subtrees under packages/, consumed as workspace packages, with the active-theme import fix.

- [ ] G1: active-state subtree present with upstream history squashed
  CHECK: git log --oneline -- packages/active-state | grep -ci "squash\|subtree\|Add 'packages/active-state"
  EXPECT: /[1-9]/
  EVIDENCE: pending

- [ ] G2: active-theme subtree present
  CHECK: test -f packages/active-theme/package.json && git log --oneline -- packages/active-theme | wc -l | tr -d ' '
  EXPECT: /[1-9]/
  EVIDENCE: pending

- [ ] G3: no unscoped active-state imports remain in active-theme
  CHECK: grep -rnE "from ['\"]active-state" packages/active-theme/src | wc -l | tr -d ' '
  EXPECT: /^0$/
  EVIDENCE: pending

- [ ] G4: both packages build
  CHECK: (cd packages/active-state && bun run build >/dev/null 2>&1 && echo AS-OK); (cd packages/active-theme && bun run build >/dev/null 2>&1 && echo AT-OK)
  EXPECT: /AS-OK[\s\S]*AT-OK/
  EVIDENCE: pending

- [ ] G5: both existing test suites pass
  CHECK: (cd packages/active-state && bun test 2>&1 | grep -E "^ *[0-9]+ fail"); (cd packages/active-theme && bun test 2>&1 | grep -E "^ *[0-9]+ fail")
  EXPECT: /^ *0 fail\s+ *0 fail\s*$/
  EVIDENCE: pending

- [ ] G6: apps/web resolves both from the workspace (not npm)
  CHECK: grep -E '"(@calvinjs/active-state|active-theme)": "workspace:\*"' apps/web/package.json | wc -l | tr -d ' ' && bun run --cwd apps/web typecheck >/dev/null 2>&1 && echo TC-OK
  EXPECT: /2\s+TC-OK/
  EVIDENCE: pending

- [ ] G7: root check still green
  CHECK: bun run typecheck 2>&1 | grep -c "Exited with code 0"
  EXPECT: /[1-9]/
  EVIDENCE: pending
