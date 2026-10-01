# Gates: T41 dramatic simplification, sightings first (opus)

Scope:
- The top bar becomes the title, a LIVE/REPLAY badge, and one status icon button whose popover holds feed health, theme, focus mode and help. (Sharpened at user review, below: no title or badge either; two icon buttons, About and Theme; LIVE/REPLAY is the timeline's Live button.)
- Default layers are sightings and alerts only. Stations, hotspots and LST/SST are off by default, but stay one tap away in Layers. (Sharpened at user review, below: alerts are off too and show only when the agent cites them; Layers lives in About under "More data (for experts)".)
- A species filter bar on the globe has a chip per focus species plus "Other", each with a colour, a live count and one-tap toggle (plus "only this" on long press or alt-click).
- Sightings are clickable: the hover tooltip leads with the species, and a click opens the evidence card.
- Detection-bracket labels are reduced to what matters (cited and selected only, with no label spam).
- Overall visual noise is cut.

- [x] G1: the top bar's only controls are popover triggers (exactly one status trigger, plus the theme trigger that G9 asks for: two icon buttons, no visible text), and the feed chips, theme, focus and help live only inside the popovers (DOM test)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "status popover" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 3 pass | 0 fail

- [x] G2: default LAYERS: sightings visible; stations, hotspots, lst and sst hidden, and alerts hidden as well since the user review (G8) (state test)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "sightings-first defaults" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G3: the species bar toggles filter the globe; e2e prints `SPECIES iguana_only=<n> all=<m> counts=ok drawer=1` with n < m, and clicking an iguana sighting opens the evidence card
  CHECK: cd apps/web && bun run e2e:species 2>&1 | grep SPECIES
  EXPECT: /SPECIES iguana_only=\d+ all=\d+ counts=ok drawer=1/
  EVIDENCE: SPECIES iguana_only=6 all=8 counts=ok drawer=1

- [x] G4: existing e2e suites pass on the simplified UI (layout, agent live, panels live, client), and T42's external-link scan still finds every external link opening in a new tab with the new popovers open
  CHECK: cd apps/web && bun run e2e:layout 2>&1 | grep LAYOUT && bun run e2e:client 2>&1 | grep CLIENT && bun run e2e:links 2>&1 | grep EXTERNAL-LINKS
  EXPECT: /LAYOUT [\s\S]*mobile=ok[\s\S]*CLIENT isolated=true frames>0 errors=0[\s\S]*EXTERNAL-LINKS total=([1-9]\d*) new_tab=\1 unsafe=0/
  EVIDENCE: CLIENT isolated=true frames>0 errors=0 | EXTERNAL-LINKS total=30 new_tab=30 unsafe=0

- [x] G5: axe still at 0 serious and 0 critical, and the keyboard walk still OK on the new top bar and species bar
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /AXE serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: AXE serious=0 critical=0 (scans: 1440 loaded, 1440 answer, 1440 drawer, 1440 legend, 1440 theme, 1440 help, 1440 missions, 375 main, 375 chat-sheet, 375 missions-sheet, 375 drawer-sheet, 375 legend, 3

- [x] G6: web unit suite, typecheck, lint and build clean
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: 0 fail | CLEAN

- [x] G7: before/after screenshots at 1440x900 (`docs/evidence/simplify-before.png`, `simplify-after.png`), plus the popover open and the species bar filtering iguana; looked at, with the noise reduction described (manual)
  EVIDENCE: all four viewed, 1440×900, real stack (Axum fixtures, `next start`), browser clock 2026-09-30T21:00Z at the live edge.
  - `simplify-before.png` (main at e82f9e3 plus only a read-only `window.__inversa` method, no UI change; `e2e:species --before`, whose counting code `e2e:firstload` now carries): a two-row top bar (EVERGLADES OPS, LIVE, CURSOR, UTC and EDT clocks, FOCUS, LIGHT/DARK/TAC, "?") over 11 red feed chips; LAYERS button; the station squares and the hotspot haze, no sighting visible; the timeline with step buttons, a 5-item legend strip and red no-data hatching over the whole track. Count: `SIMPLIFY pane_controls=24 pane_labels=39 page_controls=35 page_labels=47`.
  - `simplify-after.png` (`e2e:firstload`): the species chips top left (Python 0, Tegu 0, Iguana 0, Lionfish 0, Other 3), the ⓘ and ◐ icon buttons top right and nothing else on top; the globe shows only the 3 "other" sightings of the 48 h window; the data attribution sits above the timeline; the timeline is play, speed, LIVE, date and a quiet line with a thin gap lane. Count: `SIMPLIFY pane_controls=14 pane_labels=13 page_controls=25 page_labels=31` (pane controls −42 %, pane labels −67 %). The after script also counts `<summary>` as a control; none is on screen at load in either build (legend and drawer closed), so the numbers compare.
  - `simplify-popover.png`: About open: the one-sentence description, plain freshness ("Sightings checked 20 min ago.", "Newest sighting reported 33 h ago.", the late sources named, "Weather and water data: 8 of 8 sources delayed or offline."), Focus and Help, then collapsed "Data sources" and "More data (for experts)".
  - `simplify-iguana.png` (`e2e:species`): Iguana pressed, the other chips hollow, "All" shown; the globe flown to the clicked iguana (larger dot, white ring, bracket "SIGHTING 9"); the card reads "SIGHTING · Open at iNaturalist · Green iguana spotted near Pembroke Pines · 59 min ago · confirmed by the iNaturalist community" with the iNat photo, and "Details for experts" collapsed; the timeline line shows only the iguana spikes, at REPLAY 2026-09-09.

## Added at user review (novice audience, sightings + notes only)

- [x] G8: at first load (live, no question asked), the only point markers on the globe are species sightings (and user notes once T43 lands). Station squares drawn = 0, alert outlines drawn = 0, and the hotspot haze is off. e2e prints `FIRSTLOAD sightings>0 stations=0 alerts=0 hotspots=0`
  CHECK: cd apps/web && bun run e2e:firstload 2>&1 | grep FIRSTLOAD
  EXPECT: /FIRSTLOAD sightings>0 stations=0 alerts=0 hotspots=0/
  EVIDENCE: FIRSTLOAD sightings>0 stations=0 alerts=0 hotspots=0 window=3 api=3

- [x] G9: the globe pane has no always-visible top bar text. The app status, about and data-sources panel and the theme picker each sit behind an icon button with a popover (two icon buttons; Escape returns focus). Same e2e prints `CHROME icons=2 visible_text_labels=0`
  CHECK: cd apps/web && bun run e2e:firstload 2>&1 | grep CHROME
  EXPECT: /CHROME icons=2 visible_text_labels=0/
  EVIDENCE: CHROME icons=2 visible_text_labels=0

- [x] G10: the evidence card leads with a plain-language summary (what, where in place words, when in relative time, how sure, photo when present) and the publisher link. Raw record and payload JSON sit behind a collapsed "Details for experts" disclosure (web test named "plain evidence summary")
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "plain evidence summary" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 3 pass | 0 fail

- [x] G11: a first-visit welcome explains the app in plain words in two sentences or fewer, shows the species chips with one-line plain descriptions, and offers example questions; it is dismissible and remembered. Live agent answers use plain language for non-experts and keep citations (live eval still passes the leaf-T39 threshold) (manual: screenshot `docs/evidence/simplify-welcome.png` plus the eval line)
  EVIDENCE: `docs/evidence/simplify-welcome.png` (1440×900, `e2e:firstload`), viewed:
  - Above the composer: "Each dot is an invasive animal someone reported in South Florida in the last 48 hours; click one to see it. Filter by species at the top of the map, or ask the agent below." (two sentences; unit test "the first-visit welcome" checks ≤ 2), with its × dismiss.
  - Five species lines with their chip colours: "Burmese python — giant constrictor eating Everglades wildlife", "Argentine tegu — big lizard that raids the nests of birds, turtles and alligators", "Green iguana — tree-climbing lizard that burrows into seawalls and canal banks", "Red lionfish — venomous reef fish that eats young native fish", "Other introduced species — other non-native animals people reported"; then three example-question chips.
  - The Python chip is hovered, and its description shows under it: "Burmese python: giant constrictor eating Everglades wildlife. 0 seen in the last 48 hours. Alt-click or hold to show only these." (the same text is its `aria-describedby`, so focus shows it too).
  - Dismissed and remembered: `e2e:layout` dismisses it and checks it stays gone on the next visit ("hint stays dismissed").
  - Live eval after the tone change (`bun run eval`, doppler inversa/dev, gpt-6-luna): `EVAL quality passed 4/5`, `EVAL passed 14/15` (leaf-T39 threshold 13/15 and 4/5). A plain answer with its citation, from that run: "It is marked **needs ID** (identification is uncertain) and has an **ID conflict**, so verify the identification before dispatching a crew. [e:sighting:2002]". The miss was quality-id-conflict-tegu (did not name the casual record), the same question in both runs after the change.

- [x] G12: the sightings layer shows every sighting in a trailing 48 h window ending at TIME.at (fading with age), not only the current frame. The window length is one constant, shown in the legend or welcome as "last 48 hours". Unit test named "48h sighting window": frames across 48 h are merged and the boundary is exclusive at 48 h; e2e:firstload's sighting count equals the API count of sightings in that window
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "48h sighting window" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 2 pass | 0 fail
