# Gates: T42 evidence source page links (opus)

Scope:
- `Evidence.sourcePageUrl` follows PLAN.md C19 for every source and evidence kind.
- The evidence drawer and citation chips show an "Open at <publisher>" link: `target=_blank`, `rel="noopener noreferrer"`, an external-link icon.
- Agent table rows link out where a page exists.

- [x] G1: the schema contract holds with the new field
  CHECK: cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 219 filtered out; finished in 0.03s

- [x] G2: a unit test per source maps a real fixture record to the expected publisher URL (iNat, GBIF, NAS, USGS, NDBC, CO-OPS, NWS), with null for modelled grid, GOES, hotspot and fetch; test names contain `source_page_url`
  CHECK: cargo test --manifest-path api/Cargo.toml source_page_url 2>&1 | grep -E "running|test result"
  EXPECT: /running ([7-9]|[1-9][0-9]) tests[\s\S]*test result: ok/
  EVIDENCE: running 12 tests | test result: ok. 11 passed; 0 failed; 1 ignored; 0 measured; 208 filtered out; finished in 0.27s

- [x] G3: every generated URL is https and on an allowlisted publisher host (test `source_page_url_hosts_allowlisted`)
  CHECK: cargo test --manifest-path api/Cargo.toml source_page_url_hosts_allowlisted 2>&1 | grep "test result"
  EXPECT: /test result: ok\. 1 passed/
  EVIDENCE: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 219 filtered out; finished in 0.01s

- [x] G4: real URLs resolve. A script fetches one generated URL per source from the fixture DB and prints `LINKS ok=<n> fail=<m>` with HTTP status < 400 (manual network check; quote the line)
  EVIDENCE: `cargo test --manifest-path api/Cargo.toml source_page_url_live -- --ignored --nocapture` (api/src/source_pages.rs; one URL per source from the real fixtures, 9 URLs) printed `LINKS ok=7 fail=0 blocked=2`. ok: nas 200, usgs 200 (site and site:methodID), ndbc 200, coops 200, nws IEM VTEC 200, nws CAP 200. blocked: www.inaturalist.org and www.gbif.org answer every non-browser client with a Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`; a real Chromium tab shows a Turnstile "Verify you are human" box, not solved by the agent); the script then confirms the record through the publisher API: api.inaturalist.org/v1/observations/335508189 200, api.gbif.org/v1/occurrence/6130701656 200. The NAS page was checked to show specimen 1936189 (Burmese Python).

- [x] G5: the drawer renders the link with target=_blank and rel noopener noreferrer (web test named "source page link")
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "source page link" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 7 pass | 0 fail

- [x] G7: every external link in the app opens in a new tab: drawer, agent table rows, markdown links in agent answers, help sheet, feed popover and attribution. An e2e scans the live page DOM after an answer, the drawer, the help sheet and the popover are opened, and prints `EXTERNAL-LINKS total=<n> new_tab=<n> unsafe=0` (every `a[href^=http]` not on the app origin has `target=_blank` and `rel` containing noopener and noreferrer)
  CHECK: cd apps/web && bun run e2e:links 2>&1 | grep EXTERNAL-LINKS
  EXPECT: /EXTERNAL-LINKS total=([1-9]\d*) new_tab=\1 unsafe=0/
  EVIDENCE: EXTERNAL-LINKS total=30 new_tab=30 unsafe=0

- [x] G6: api suite, clippy, web typecheck and lint clean
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -c "test result: ok" && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /Finished[\s\S]*CLEAN/
  EVIDENCE: Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.30s | CLEAN
