# Gates: T40 chat-left layout, layers legend, globe tooltips, help (opus)

Scope (user: "what are the blue dots, and what are all of the options? Let's keep the chat open on the left side fully with globe on the right side"):
- Two panes. The left column is about 420 px wide, resizable from 360 to 560 px, with the width kept in localStorage. It is full height and always open, with Agent | Missions tabs and an unread dot on the inactive tab. It holds the chat thread (data panels, citations, tool rows) and a composer with mic and send buttons. The globe fills the right pane, and the top bar, timeline and drawer sit inside that pane. The orb and morph card are deleted. Expand pops out next to the column, over the left part of the globe pane and clear of its centre. Under 768 px the column becomes a bottom sheet with three snap points: collapsed, half and full.
- `client/hud/legend/**`: a Layers button and collapsible panel at the top right of the globe pane. It has one row per layer with toggles, swatches, ramps and live counts from `GlobeApi.stats()`, plus a data-gaps row.
- Globe hover tooltips. Picks are throttled to one per animation frame, and each marker shows a label and a key value.
- A "?" help sheet whose content comes from one data file. The first visit also shows a hint line with example-question chips.
- Moved by T41 (sightings first, `gates/leaf-T41.md`), with the same intent checked in the new place: the top bar's title, LIVE badge, clocks, feed chips, theme switch, Focus and "?" are gone from the bar. The top right of the globe pane holds two icon buttons: About (ⓘ), whose popover holds plain freshness, Focus, Help, "Data sources" (the feed rows) and "More data (for experts)" (this Layers legend, rows and counts unchanged), and Theme. LIVE/REPLAY is the timeline's Live button. The first-visit hint is T41's welcome (with the same example-question chips). The e2e steps below open the legend, help and themes through those popovers, and stations start off, so the legend test switches them on first.
- The e2e harnesses and the T14/T38 gates are moved to the new layout, the four screenshots are retaken, and README and the demo script are updated.
- No mock anything: the agent uses real OpenRouter `openai/gpt-6-luna` through Doppler `inversa`/`dev`.

- [x] G1: unit tests for the legend, layout, unread, tooltip and help logic pass (≥20 tests)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests/client/hud/legend tests/client/hud/tooltip tests/client/hud/help tests/client/agent/layout 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([2-9][0-9]|[1-9][0-9]{2,}) pass\s+0 fail/
  EVIDENCE: 40 pass | 0 fail

- [x] G2: the whole web unit suite passes (0 fail)
  CHECK: cd apps/web && bun run test 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 647 pass | 0 fail

- [x] G3: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN

- [x] G4: `next build` succeeds
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && echo BUILD-OK
  EXPECT: BUILD-OK
  EVIDENCE: BUILD-OK

- [x] G5: the orb and morph code is gone. No file or selector still names it, and the page mounts the chat column.
  CHECK: cd apps/web && test ! -e client/agent/morph && test ! -e client/agent/orb.styled.ts && test ! -e client/agent/orb-phase.ts && ! grep -rqE "data-agent-orb|RectMorphPortal|useRectMorph|data-agent-card|open agent chat" client app e2e && grep -q "AgentColumn" app/page.tsx && echo NO-ORB
  EXPECT: NO-ORB
  EVIDENCE: NO-ORB

- [x] G6: e2e:layout on the real stack (Axum fixtures, next start, Chromium). It checks:
  - the chat column is visible at load, with the globe to its right (bounding boxes);
  - the legend toggles change `LAYERS` and the globe layer stats;
  - a hover over a known station shows the tooltip;
  - the Missions tab switches;
  - the mobile sheet works at 375 px.
  CHECK: cd apps/web && bun run e2e:layout 2>&1 | grep "^LAYOUT"
  EXPECT: /^LAYOUT chat=left globe=right legend=ok tooltip=ok tabs=ok mobile=ok$/m
  EVIDENCE: LAYOUT chat=left globe=right legend=ok tooltip=ok tabs=ok mobile=ok

- [x] G7: e2e:agent live (GPT-6 Luna) on the chat column prints FLOW-OK
  CHECK: cd apps/web && bun run e2e:agent 2>&1 | tail -1
  EXPECT: FLOW-OK
  EVIDENCE: FLOW-OK

- [x] G8: e2e:panels live on the new layout: tables, series, brackets, and the drawer from a row click
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run e2e:panels 2>&1 | grep -E "^PANELS "
  EXPECT: /^PANELS table=[1-9]\d* series=[1-9]\d* brackets=[1-9]\d* drawer=1$/m
  EVIDENCE: PANELS table=1 series=8 brackets=3 drawer=1

- [x] G9: e2e:convo live on the chat column
  CHECK: cd apps/web && bun run e2e:convo 2>&1 | tail -1
  EXPECT: CONVO-OK
  EVIDENCE: CONVO-OK

- [x] G10: e2e:team with missions in the Missions tab
  CHECK: cd apps/web && bun run e2e:team 2>&1 | grep -E "^TEAM |COUNTERS-OK OFFLINE-OK"
  EXPECT: /TEAM rtc_p50=[0-9.]+ ws_p50=[0-9.]+ converged=1[\s\S]*COUNTERS-OK OFFLINE-OK/
  EVIDENCE: TEAM rtc_p50=15 ws_p50=89 converged=1 | COUNTERS-OK OFFLINE-OK

- [x] G11: e2e:client on the new layout (isolation, frames, cold snap)
  CHECK: cd apps/web && bun run e2e:client 2>&1 | grep -E "^(CLIENT|COLDSNAP)"
  EXPECT: /CLIENT isolated=true frames>0 errors=0[\s\S]*COLDSNAP .*badge=REPLAY date=2026-02-01 errors=0/
  EVIDENCE: CLIENT isolated=true frames>0 errors=0 | COLDSNAP at=2026-02-01T17:00:00.000Z window=2026-01-17T17:00:00.000Z..2026-02-16T17:00:00.000Z iguana=1.58 max=2.00 sightings=6 globe_sightings=51 globe_hotspo

- [x] G12: e2e:live on the new layout
  CHECK: cd apps/web && bun run e2e:live 2>&1 | grep "^LIVE"
  EXPECT: /^LIVE sighting_ms=\d+ alert_ms=\d+ sparkline_ms=\d+ feed_ms=\d+ reload=0$/m
  EVIDENCE: LIVE sighting_ms=5230 alert_ms=5230 sparkline_ms=5230 feed_ms=7099 reload=0

- [x] G13: the docs describe the new UI. README's UI section names the chat column, the Layers legend and the help sheet, and the demo script no longer mentions the orb.
  CHECK: grep -q "chat column" README.md && grep -q "Layers" README.md && grep -q "help sheet" README.md && ! grep -qiw "orb" docs/demo-script.md && grep -q "Missions tab" docs/demo-script.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: DOCS-OK

- [x] G14: docs/evidence/layout-desktop.png at 1440×900 shows a real answer with its panels (manual; looked at)
  EVIDENCE: docs/evidence/layout-desktop.png, 1440×900, retaken at T41 by the G8 e2e:panels run (`PANELS table=1 series=8 brackets=3 drawer=1`) with a real gpt-6-luna answer. Viewed:
  - The chat column at x 0–420 with AGENT and MISSIONS: the answer (one green iguana report near Homestead on 2 September, water levels 0.77 m at Black Creek Canal and 0.81 m at Canal 111, the caveat that iNaturalist, USGS and CO-OPS are down) with citation chips 1–6, "DATA · 3" with the sightings table open (09-02 18:09Z Green iguana, research, inat), the water-level chart and readings table collapsed, and the composer with mic and send.
  - The globe pane: species chips top left (Iguana 1, Other 1), ⓘ and ◐ top right, the globe framed on Homestead with brackets and labels on the cited sighting ("SIGHTING Green iguana · research") and the two cited readings (Black Creek Canal, Canal 111), the timeline at REPLAY 2026-09-02.

- [x] G15: docs/evidence/layout-legend.png shows the legend open (manual; looked at)
  EVIDENCE: docs/evidence/layout-legend.png, 1440×900, retaken at T41 by e2e:layout (G6). Since T41 the legend is About (ⓘ) → "More data (for experts)". Viewed: the About popover at the top right of the globe pane with its sentence, plain freshness lines, FOCUS and HELP, "Data sources" collapsed and "More data (for experts)" open:
  - Sightings, "3 drawn", "One dot per sighting in the last 48 hours, fading with age. Red ring: the IDs conflict.", with species rows Burmese python 0, Argentine tegu 0, Green iguana 0, Red lionfish 0, Other introduced species 3, each with its checkbox and colour.
  - Stations (switched on by the test; off at load), "20 reporting": USGS gauge 14, NDBC buoy 4, NOAA tide gauge 2; the blue and teal squares on the map match.
  - Alerts "off" with its Extreme, Severe, Moderate and Minor swatches; the body scrolls on to hotspots, missions, team cursors, LST, SST and data gaps.

- [x] G16: docs/evidence/layout-tooltip.png shows a hover tooltip on a globe marker (manual; looked at)
  EVIDENCE: docs/evidence/layout-tooltip.png, 1440×900, retaken at T41 by e2e:layout. Viewed: zoomed on USGS 11 near Lake Ingraham, the blue square at about (930,450); the tooltip beside it reads "USGS gauge · EAST SIDE CREEK NEAR LAKE INGRAHAM, FL · stage 0.24 m · 45 min ago", title bold. e2e asserts its evidence id is the station's reading id and that a click opens the drawer on it.

- [x] G17: docs/evidence/layout-mobile.png at 375×812 shows the globe and the sheet (manual; looked at)
  EVIDENCE: docs/evidence/layout-mobile.png, 375×812, retaken at T41 by e2e:layout. Viewed:
  - The globe is full width behind everything. The species chips wrap to two rows at the top left (Python, Tegu, Iguana / Lionfish, Other 3) and the ⓘ and ◐ buttons sit at the top right; one grey sighting dot is on the map. No top-bar text.
  - The sheet is at half height (about y 406–812) with its grab handle, AGENT | MISSIONS, and "Agent ready".
  - The welcome: its two sentences, the five species lines, and the first example-question chip at the bottom edge.
  - Nothing overflows at 375 px (e2e:a11y `MOBILE main overflow=0 hscroll=0`).

- [x] G18: the layout, legend, tooltip, sheet and help render in all three themes (light, dark, tactical) with no page errors. e2e:layout switches the themes and asserts that the text contrast of the column and legend is at least 4.5:1.
  CHECK: cd apps/web && E2E_SKIP_BUILD=1 bun run e2e:layout 2>&1 | grep "^THEMES"
  EXPECT: /^THEMES light=ok dark=ok tactical=ok$/m
  EVIDENCE: THEMES light=ok dark=ok tactical=ok
