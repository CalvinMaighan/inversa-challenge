# Gates: T44 every species is a first-class sighting (fable)

Scope:
- Grey "other" dots become real species. Every sighting shows its common and scientific name, photo, and a short plain "About this species" (native range, why it's a problem) from iNaturalist taxa data, fetched server-side and cached.
- The species bar becomes the top introduced animals in the current window (by count), with Inversa's focus species pinned. Plants and insects sit behind their own chips, off by default.
- The window selector offers 2 days / 7 days / 30 days, default 7 days, with the reason (iNat upload lag) stated plainly.
- Default backfill is 7 days.
- Stale API binaries fail soft (a missing GraphQL field degrades, not errors).

- [ ] G1: api tests including taxon enrichment (iconic group, iNat taxon id, summary, photo, Wikipedia URL), cached in SQLite, batched at 30 ids per iNat call, rate-governed; test names contain `taxon_info`
  CHECK: cargo test --manifest-path api/Cargo.toml taxon_info 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: clicking a grey dot on the real stack (a brown anole or Cuban tree frog from real data) opens a card with the common name, scientific name, an About line and a photo; e2e prints `SPECIESCARD name=<common> sci=1 about=1 photo=1 error=0`
  CHECK: cd apps/web && bun run e2e:speciescard 2>&1 | grep SPECIESCARD
  EXPECT: /SPECIESCARD name=[A-Za-z][^ ]* sci=1 about=1 photo=1 error=0/
  EVIDENCE: pending

- [ ] G3: the species bar lists the top introduced animals in the window (focus species pinned), chip counts equal the DB counts for that window, and switching 2d/7d/30d changes the counts; e2e prints `SPECIESBAR chips>=6 counts=ok window_7d>window_2d plants_default=off`
  CHECK: cd apps/web && bun run e2e:speciescard 2>&1 | grep SPECIESBAR
  EXPECT: /SPECIESBAR chips>=6 counts=ok window_7d>window_2d plants_default=off/
  EVIDENCE: pending

- [ ] G4: graceful degradation. The drawer and agent queries do not hard-fail when the API lacks an optional field (simulated old schema); web test named "schema tolerant evidence"
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "schema tolerant evidence" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [x] G5: `bun run data` defaults to 7 days, and after it the local DB's 7-day iNat count is within 10% of iNat's own count for the bbox (manual: quote both numbers)
  EVIDENCE: root `package.json` `data` runs `backfill --days ${DAYS:-7}`. Run 2026-10-01T03:32:45Z into a temp dir (`INVERSA_DATA_DIR=<scratch>/g5data bun run data`, `BACKFILL-OK`): `inat: payloads=19 rows_in=3646 written=3518 ... sightings=3407 revisions=111 conflicts=106`, `taxa: enriched 572 with iNat names, groups, summaries and photos`. iNat at the same moment, `GET /v1/observations?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&introduced=true&updated_since=<now-7d>&per_page=0`: `total_results` 3408 (the four focus taxa: 108, all inside the introduced set). DB 3407 vs iNat 3408: 0.03% apart (the DB skips observations with no taxon, place or date). Taxa after the run: 572 rows, 572 with an iNat id and `fetched_at`, 572 with a photo, 515 with a Wikipedia summary; groups Plantae 330, Insecta 100, Aves 37, Reptilia 28, Actinopterygii 20, Mammalia 20, other 15, Arachnida 9, Mollusca 7, Amphibia 5, Fungi 1.

- [x] G6: the agent answers "what invasive animals were seen near Homestead this week?" with named species and counts, citing them (live, doppler); live eval still at the leaf-T39 threshold (manual: quote the answer's first lines and the EVAL line)
  EVIDENCE: live turn (`doppler run --project inversa --config dev`, `openai/gpt-6-luna`, `runTurn` against an Axum serving the G5 data dir, 2026-10-01T03:45Z): `TOOLS geocode, species_counts, set_view`, 16 citations. Answer: "Near Homestead, the data lists 13 invasive animal species and 17 distinct sightings this week (September 24–October 1). Burmese pythons were most reported, with 3 sightings [e:sighting:97]; green iguanas and Peters's rock agamas had 2 each [e:sighting:76] [e:sighting:2227]. One sighting each was recorded for Cuban tree frog [e:sighting:2838], cane toad [e:sighting:2072], brown anole [e:sighting:2197], bark anole [e:sighting:1350], crested anole [e:sighting:2450], brown basilisk [e:sighting:2778], African spurred tortoise [e:sighting:2629], common myna [e:sighting:2912], emu [e:sighting:2630], and red-eared slider [e:sighting:3387]. Plants and insects are not included." (then the feed caveats: that Axum ran with `INVERSA_SOURCES=off`, so it named iNaturalist, GBIF and NAS as down and disabled with their fetch-run citations). The counts match `speciesCounts` for the Homestead box over the same 7 days (python 3, iguana 2, agama 2, then 1 each). Live eval (`bun run eval`, 16 golden questions after the new `homestead-species-counts` one): `EVAL quality passed 5/5`, `EVAL passed 16/16`, `EVAL views valid 31/31` (leaf-T39 threshold 13/15 and 4/5).

- [ ] G7: web tests, typecheck, lint, api suite and clippy clean; e2e:firstload, e2e:species and e2e:links still pass
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*Finished[\s\S]*CLEAN/m
  EVIDENCE: pending

- [x] G8: screenshots (looked at) `docs/evidence/species-card-other.png` and `species-bar-7d.png`
  EVIDENCE: both 1440×900 from `e2e:speciescard` on the real stack (fixtures plus a 7-day network backfill, taxa enriched), viewed.
  - `species-bar-7d.png`: top left, twelve chips in two rows and a half: Python 4, Tegu 0 (dimmed), Iguana 47, Lionfish 0 (dimmed), then Brown anole 113, Northern curly-tailed lizard 51 (name ellipsised), Cuban tree frog 47, Peters's rock agama 32, Cane toad 27, Egyptian goose 23, each with its own colour dot, then Plants 818 and Insects & others 229 hollow (off), and the "Last 7 days" selector. The globe shows South Florida with hundreds of dots in a dozen colours along the east coast and the Keys; no grey dot. The welcome lists the four focus lines and "Other introduced animals".
  - `species-card-other.png`: zoomed to a Miami shoreline; the clicked dot carries the bracket "SIGHTING 3464". The card reads "SIGHTING · Open at iNaturalist ↗", "Brown anole spotted in South Florida", "*Anolis sagrei* · introduced reptile", "4 h ago · needs ID (not yet confirmed)", the observer's photo (an anole on a seawall behind a fence), the About paragraph ("The brown anole (Anolis sagrei), also known as the Bahaman anole or De la Sagra's Anole, is a lizard native to Cuba and the Bahamas. It has been widely introduced elsewhere…"), the link "More about Brown anole on iNaturalist ↗", the T27 flag "iNat data not updating" (the e2e Axum runs with sources off), "Add note about this sighting" and the collapsed "Details for experts". The tooltip before the click read "Brown anole · needs ID · 4 h ago".
