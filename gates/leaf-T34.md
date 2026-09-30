# Gates: T34 Litestream restore drill (blocked on T33)

Scope: stop the API, move the databases aside, restart, and let bootstrap restore from R2. Row counts must match before and after.

- [ ] G1: row counts for sightings, readings and ops match before and after the restore (manual: quote both count lines from ssh)
  EVIDENCE: pending

- [ ] G2: the drill procedure is documented in deploy/README.md
  CHECK: grep -ci "restore drill" deploy/README.md
  EXPECT: /[1-9]/
  EVIDENCE: pending
