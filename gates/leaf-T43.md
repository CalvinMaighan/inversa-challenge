# Gates: T43 real-time field notes (opus)

Scope:
- Anyone can drop a note on the map (tap a spot, write text, optionally tag a species, optionally attach it to a sighting).
- Notes appear as pins on the globe and in a Notes tab, for everyone in real time, over the existing CRDT ops path (optimistic, WebRTC, WS, Axum) with authorship from ME.
- Notes are editable and deletable by their author.
- Missions move behind a secondary "Crew missions" disclosure inside the Notes tab.

- [x] G1: unit tests for note ops (create, edit, delete tombstone, ordering, validation, length caps) pass
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "field note" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 13 pass | 0 fail

- [x] G2: CRDT vectors still pass in both languages, including new note vectors
  CHECK: cargo test --manifest-path api/Cargo.toml crdt -- --nocapture 2>&1 | grep "CRDT vectors passed" && cd apps/web && bun test --tsconfig-override ./tsconfig.json tests/client/threads/crdt 2>&1 | grep "CRDT vectors passed"
  EXPECT: /CRDT vectors passed: (\d+)\/\1[\s\S]*CRDT vectors passed: (\d+)\/\2/
  EVIDENCE: CRDT vectors passed: 17/17 | CRDT vectors passed: 17/17

- [x] G3: two browser contexts. A drops a note on the map; B sees the pin and the list entry. e2e prints `NOTES rtc_ms=<n> pin=1 list=1 edit=1 delete=1 offline_sync=1`
  CHECK: cd apps/web && bun run e2e:notes 2>&1 | grep NOTES
  EXPECT: /NOTES rtc_ms=\d+ pin=1 list=1 edit=1 delete=1 offline_sync=1/
  EVIDENCE: NOTES-AGENT ok=1 | NOTES rtc_ms=558 pin=1 list=1 edit=1 delete=1 offline_sync=1

- [x] G4: XSS safety. Note text renders as plain text, never HTML, and a test planting `<img onerror>` does not execute (test name contains "note xss")
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "note xss" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 3 pass | 0 fail

- [x] G5: web typecheck, lint, tests and api suite clean
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && cargo test --manifest-path api/Cargo.toml 2>&1 | grep -c "test result: ok" && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: 1 | CLEAN

- [x] G6: screenshots of a note pin and the Notes tab with two authors, plus the agent answering "what have people noted near Homestead today?" using the notes (manual; the agent gets a read-only `notes` tool over the board; live)
  EVIDENCE: `bun run e2e:notes` (live, under doppler) wrote docs/evidence/notes-map.png (A's pin at the pane centre with its NOTE bracket and the drawer's note card: "Two tegus by the canal gate, heading west", Ranger-FA07, Homestead, Argentine tegu), docs/evidence/notes-tab.png (Notes tab with Ranger-929D's iguana note at Royal Palm and Ranger-FA07's tegu note at Homestead; Edit/Delete only on the author's row) and docs/evidence/notes-agent.png (tool rows "Found the place", "notes 1 row, 1 evidence", "Moved the view"; answer "The only note returned near Homestead says Ranger-FA07 noted a python crossing a levee road at 02:11 UTC on October 1 [1]" with the note:<id> citation chip, the Field notes table, and the pin bracketed on the globe). Same run: NOTES-AGENT ok=1, NOTES rtc_ms=624 pin=1 list=1 edit=1 delete=1 offline_sync=1. Live eval with the notes tool registered: EVAL quality passed 5/5, EVAL passed 15/15.
