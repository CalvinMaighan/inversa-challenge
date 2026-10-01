# Gates: T42 evidence source page links (opus)

Scope:
- `Evidence.sourcePageUrl` follows PLAN.md C19 for every source and evidence kind.
- The evidence drawer and citation chips show an "Open at <publisher>" link: `target=_blank`, `rel="noopener noreferrer"`, an external-link icon.
- Agent table rows link out where a page exists.

- [ ] G1: the schema contract holds with the new field
  CHECK: cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending

- [ ] G2: a unit test per source maps a real fixture record to the expected publisher URL (iNat, GBIF, NAS, USGS, NDBC, CO-OPS, NWS), with null for modelled grid, GOES, hotspot and fetch; test names contain `source_page_url`
  CHECK: cargo test --manifest-path api/Cargo.toml source_page_url 2>&1 | grep -E "running|test result"
  EXPECT: /running ([7-9]|[1-9][0-9]) tests[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: every generated URL is https and on an allowlisted publisher host (test `source_page_url_hosts_allowlisted`)
  CHECK: cargo test --manifest-path api/Cargo.toml source_page_url_hosts_allowlisted 2>&1 | grep "test result"
  EXPECT: /test result: ok\. 1 passed/
  EVIDENCE: pending

- [ ] G4: real URLs resolve. A script fetches one generated URL per source from the fixture DB and prints `LINKS ok=<n> fail=<m>` with HTTP status < 400 (manual network check; quote the line)
  EVIDENCE: pending

- [ ] G5: the drawer renders the link with target=_blank and rel noopener noreferrer (web test named "source page link")
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "source page link" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G6: api suite, clippy, web typecheck and lint clean
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -c "test result: ok" && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /Finished[\s\S]*CLEAN/
  EVIDENCE: pending
