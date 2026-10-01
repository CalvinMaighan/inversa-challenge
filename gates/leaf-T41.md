# Gates: T41 dramatic simplification, sightings first (opus)

Scope:
- The top bar becomes the title, a LIVE/REPLAY badge, and one status icon button whose popover holds feed health, theme, focus mode and help.
- Default layers are sightings and alerts only. Stations, hotspots and LST/SST are off by default, but stay one tap away in Layers.
- A species filter bar on the globe has a chip per focus species plus "Other", each with a colour, a live count and one-tap toggle (plus "only this" on long press or alt-click).
- Sightings are clickable: the hover tooltip leads with the species, and a click opens the evidence card.
- Detection-bracket labels are reduced to what matters (cited and selected only, with no label spam).
- Overall visual noise is cut.

- [ ] G1: the top bar has exactly one popover trigger, and the feed chips, theme, focus and help live only inside the popover (DOM test)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "status popover" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: default LAYERS are sightings and alerts visible; stations, hotspots, lst and sst hidden (state test)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "sightings-first defaults" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: the species bar toggles filter the globe; e2e prints `SPECIES iguana_only=<n> all=<m> counts=ok drawer=1` with n < m, and clicking an iguana sighting opens the evidence card
  CHECK: cd apps/web && bun run e2e:species 2>&1 | grep SPECIES
  EXPECT: /SPECIES iguana_only=\d+ all=\d+ counts=ok drawer=1/
  EVIDENCE: pending

- [ ] G4: existing e2e suites pass on the simplified UI (layout, agent live, panels live, client)
  CHECK: cd apps/web && bun run e2e:layout 2>&1 | grep LAYOUT && bun run e2e:client 2>&1 | grep CLIENT
  EXPECT: /LAYOUT [\s\S]*mobile=ok[\s\S]*CLIENT isolated=true frames>0 errors=0/
  EVIDENCE: pending

- [ ] G5: axe still at 0 serious and 0 critical, and the keyboard walk still OK on the new top bar and species bar
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /AXE serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: pending

- [ ] G6: web unit suite, typecheck, lint and build clean
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G7: before/after screenshots at 1440x900 (`docs/evidence/simplify-before.png`, `simplify-after.png`), plus the popover open and the species bar filtering iguana; looked at, with the noise reduction described (manual)
  EVIDENCE: pending

## Added at user review (novice audience, sightings + notes only)

- [ ] G8: at first load (live, no question asked), the only point markers on the globe are species sightings (and user notes once T43 lands). Station squares drawn = 0, alert outlines drawn = 0, and the hotspot haze is off. e2e prints `FIRSTLOAD sightings>0 stations=0 alerts=0 hotspots=0`
  CHECK: cd apps/web && bun run e2e:firstload 2>&1 | grep FIRSTLOAD
  EXPECT: /FIRSTLOAD sightings>0 stations=0 alerts=0 hotspots=0/
  EVIDENCE: pending

- [ ] G9: the globe pane has no always-visible top bar text. The app status, about and data-sources panel and the theme picker each sit behind an icon button with a popover (two icon buttons; Escape returns focus). Same e2e prints `CHROME icons=2 visible_text_labels=0`
  CHECK: cd apps/web && bun run e2e:firstload 2>&1 | grep CHROME
  EXPECT: /CHROME icons=2 visible_text_labels=0/
  EVIDENCE: pending

- [ ] G10: the evidence card leads with a plain-language summary (what, where in place words, when in relative time, how sure, photo when present) and the publisher link. Raw record and payload JSON sit behind a collapsed "Details for experts" disclosure (web test named "plain evidence summary")
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "plain evidence summary" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G11: a first-visit welcome explains the app in plain words in two sentences or fewer, shows the species chips with one-line plain descriptions, and offers example questions; it is dismissible and remembered. Live agent answers use plain language for non-experts and keep citations (live eval still passes the leaf-T39 threshold) (manual: screenshot `docs/evidence/simplify-welcome.png` plus the eval line)
  EVIDENCE: pending
